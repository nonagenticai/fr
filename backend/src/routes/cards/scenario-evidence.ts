// POST /api/cards/:cardId/scenario-evidence — append repro evidence to an
// EXISTING card (G-26 gap A; R3 "repro contract v2", ruling movies-13).
//
// Repro evidence (`test_file_content`, ≤ 32 KiB UTF-8) used to be written ONLY
// when a card was minted (POST /api/cards/project → `splitScenarioEvidence`).
// bug_analysis writes its repro tests — one per persisted finding — onto a card
// that already exists, so this route adds `gherkin_scenarios` entries plus
// their evidence to one. The n8n node op `fr:cards.addScenarioEvidence` calls it.
//
// Body `{ entries: GherkinScenarioEntry[] }` (1..N), each validated by the SAME
// strict schema and refusal codes as POST /api/cards/project (the entries are
// checked as the card document `{ gherkin_scenarios: entries }`), and each MUST
// carry `test_file_content` + `test_file_sha256` (sha256 of the content's UTF-8
// bytes). Every refusal is 400 + `qa_needs_info: "repro_malformed"`.
//
// TENANCY — from the authenticated principal ONLY, exactly as POST
// /api/cards/project derives it: `validateAuth` + `ctxTenantId(user.tenantId)`
// (the request-context middleware applies the verified delegated-tenant
// override for the trusted service identity; nothing in this handler reads a
// tenant from the body or a header). The body is `.strict()`: a `tenant_id` (or
// any other key) next to `entries` is refused, never read. The same EXEC pin
// (`cardRouteTenantRefusal`, a predicate on the CALLER only) applies, so this
// route accepts exactly the principals POST /api/cards/project accepts.
//
// CARD GATE — the card (read with the admin agent through the project-card
// Planka seam) must sit on the board of a project that resolves under the
// caller's tenant projection (`resolveCardRouteProjectByBoard` = the
// `tenantScopedProjectFilter` POST /api/cards/project uses). A foreign card, an
// unknown card, a card on a non-project board (a stream / framework board) all
// answer the SAME 404 `card_not_found` — never 403, so an id leaks nothing.
// ⚠️ Deliberately NOT `assertCardTenantWritable`: that gate attributes a board
// by `departments.workspace_id` / `project_data.keycloak_tenant_id` and refuses
// a dept-less project without the tag, which POST /api/cards/project accepts —
// it would refuse principals the minter accepts. Both gates refuse foreign
// tenants; this one is the minter's own.
//
// WRITE-ONCE per (card_id, scenario_id) — `card_scenario_evidence` (migration
// 154, PK (card_id, scenario_id), DB CHECKs: ≤ 32768 bytes, sha256 of content):
//   new ⇒ inserted ⇒ `created`; same sha ⇒ `unchanged` (no write);
//   different sha ⇒ 409 `scenario_evidence_conflict`, NEVER an overwrite.
// A batch is all-or-nothing: one conflict ⇒ the whole request 409, zero writes.
//
// CARD POINTER — each NEW entry, WITHOUT `test_file_content` and WITH
// `test_file_sha256`, is appended to the card document's `gherkin_scenarios`
// (`appendScenarioEntries`; bytes outside a fenced document kept). The PATCH
// goes through `CardsResource.update`, which runs the fr#1364 chokepoint guard.
// ORPHAN REPAIR: an `unchanged` entry whose pointer is MISSING from the card
// (a crash between COMMIT and the PATCH, or a failed rollback delete) gets the
// STORED entry's pointer appended, `pointer_repaired: true` on that entry; a
// pointer already present is never duplicated.
//
// ORDER + ROLLBACK — ⛔ no DB connection is ever held across Planka I/O, and
// no step takes a second connection while holding one (see the pool-deadlock
// note below):
//   1. gate: Planka card read, then one short project-resolve query;
//   2. the card's LEASE (create-lease.ts primitive: an autocommit TTL + owner
//      row; two appends to one card would otherwise race the description
//      read-modify-write);
//   3. re-read the description under the lease;
//   4. insert the rows in ONE short transaction and commit;
//   5. LEASE-LOST CHECK, then the Planka PATCH. Immediately before the PATCH
//      the lease row is re-read by (namespace, key, owner) and must still have
//      at least one Planka call's timeout left on it. If it does not (this
//      holder overran its TTL, so a second holder may already be mid
//      read-modify-write), Planka is NOT written: the rows this request
//      created are deleted (the rollback's keyed delete) and the request
//      answers 503 `scenario_evidence_lease_lost` (retryable). If the
//      PATCH fails, ONLY the rows this request created are deleted (keyed
//      on card, scenario_id AND sha256 — pre-existing rows are untouched) and
//      the response reports `scenario_evidence_rolled_back`, as POST
//      /api/cards/project does;
//   6. release the lease in `finally`.
// A contender that cannot take the lease within SCENARIO_EVIDENCE_LEASE_WAIT_MS
// answers 503 `scenario_evidence_card_busy` (retryable; nothing written).
// ⚠️ A holder that LOST its lease (step 5) answers 503
// `scenario_evidence_lease_lost` — also retryable, also nothing on the card.

import { z } from 'zod';

import {
  appendScenarioEntries,
  checkDescriptionScenarios,
  type AppendScenarioEntriesResult,
  scenarioRefusalBody,
  scenarioRefusalStatus,
  splitScenarioEvidence,
  SCENARIO_CODES,
  SCENARIO_REFUSAL_QA_NEEDS_INFO,
  type ScenarioEvidence,
} from '../../services/gherkin-scenarios';
import {
  appendScenarioEvidence,
  deleteAppendedScenarioEvidence,
  ScenarioEvidenceConflictError,
  type AppendedScenarioEvidence,
} from '../../services/scenario-evidence';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { PlankaError } from '../../services/planka/errors';
import { AppError, clientSafePlankaErrorMessage } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import {
  cardRouteTenantRefusal,
  projectCardPlankaAgent,
  resolveCardRouteProjectByBoard,
} from './project';
import {
  acquireCardEvidenceLease,
  body,
  cardEvidenceLeaseStillHeld,
  cardNotFound,
  readCard,
  releaseCardEvidenceLease,
  SCENARIO_EVIDENCE_LEASE_KEY,
  SCENARIO_EVIDENCE_LEASE_TTL_SECS,
  SCENARIO_EVIDENCE_LEASE_WAIT_MS,
  scenarioEvidenceLeaseNamespace,
} from './_card-document-lease';

// The lease primitives moved to _card-document-lease.ts (shared with
// scenarios-freeze.ts, which rewrites the same description under the SAME
// lease key). Re-exported so existing importers keep their names.
export {
  SCENARIO_EVIDENCE_LEASE_KEY,
  SCENARIO_EVIDENCE_LEASE_TTL_SECS,
  SCENARIO_EVIDENCE_LEASE_WAIT_MS,
  scenarioEvidenceLeaseNamespace,
};

/** `{ entries: [...] }` and nothing else — a tenant (or any key) in the body is refused, never read. */
const BodySchema = z
  .object({
    entries: z.array(z.unknown()).min(1, 'entries must hold at least one gherkin_scenarios entry'),
  })
  .strict();

// ── per-card serialisation: a LEASE ROW, never a held connection ────────────
//
// ⛔ POOL DEADLOCK (audit of this route's first cut): the first cut held ONE `queryClient.begin`
// connection (a `pg_advisory_xact_lock`) for the whole request, Planka I/O
// included, and took TWO MORE connections inside it (the project resolve and
// `appendScenarioEvidence`'s own transaction). `queryClient` is
// `postgres(url)` — default max 10, no acquire timeout — so 14 concurrent
// requests on 14 cards each held one and waited forever for another. Measured:
// >20s hang, later queries in the process poisoned.
//
// The serialiser is now the create-lease primitive (create-lease.ts): ONE
// autocommit conditional upsert on `action_idempotency` (TTL + owner), no
// connection held after it returns, owner-scoped release in `finally`. Every
// DB step below is a short unit on ONE connection at a time; no connection is
// open while Planka is awaited.

/** The card pointer for a stored/sent entry: every field except the file content. */
function pointerOf(entry: Record<string, unknown>): Record<string, unknown> {
  const { test_file_content: _drop, ...rest } = entry;
  return rest;
}

/**
 * ORPHAN REPAIR: `unchanged` entries whose pointer is MISSING from the card
 * document (a crash between COMMIT and the PATCH, or a failed rollback delete)
 * are appended — from the STORED entry, so the pointer names exactly what fr
 * holds. An identical pointer already present is never duplicated; a DIFFERENT
 * entry under that scenario_id, or a document that cannot take an append, is
 * left alone (the request still answers `unchanged`, as before repair existed).
 */
function repairMissingPointers(
  description: string | null | undefined,
  unchanged: ReadonlyArray<AppendedScenarioEvidence>,
): { description: string; repaired: string[] } | undefined {
  let candidates = unchanged
    .filter((r) => r.stored_entry)
    .map((r) => pointerOf(r.stored_entry!));
  while (candidates.length > 0) {
    const v = appendScenarioEntries(description, candidates);
    if ('refusal' in v) return undefined;
    if ('conflict' in v) {
      const bad = new Set(v.conflict);
      candidates = candidates.filter((c) => !bad.has(String(c.scenario_id)));
      continue;
    }
    return v.appended.length > 0 ? { description: v.description, repaired: v.appended } : undefined;
  }
  return undefined;
}

export async function handleAddScenarioEvidence(req: Request, cardId: string): Promise<Response> {
  const user = await validateAuth(req);
  // ⭐ THE tenant: the authenticated principal's, as POST /api/cards/project
  // derives it. Never the body, never a header read here.
  const activeTenantId = ctxTenantId(user.tenantId);

  // Same principals as POST /api/cards/project: the EXEC pin is a predicate on
  // the CALLER (not the card), so it reveals nothing about any card id.
  // Same decision, with the top-level `code` every refusal of this route carries.
  if (cardRouteTenantRefusal(user, activeTenantId)) return body(403, 'project_cards_only_on_exec_tenant');

  if (typeof cardId !== 'string' || cardId.length === 0) return cardNotFound(String(cardId ?? ''));

  // ── body: strict, before any read or write ──────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (e) {
    return body(400, 'validation_failed', {
      issues: [{ message: String(e) }],
      qa_needs_info: SCENARIO_REFUSAL_QA_NEEDS_INFO,
    });
  }
  const parsedBody = BodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return body(400, 'validation_failed', {
      issues: parsedBody.error.issues,
      qa_needs_info: SCENARIO_REFUSAL_QA_NEEDS_INFO,
    });
  }
  const entries = parsedBody.data.entries;

  // The entries ARE a card document's gherkin_scenarios: the same strict
  // schema, the same refusal codes, the same evidence split as the minter.
  const document = JSON.stringify({ gherkin_scenarios: entries });
  const refusal = checkDescriptionScenarios(document);
  if (refusal) return jsonResponse(scenarioRefusalBody(refusal), scenarioRefusalStatus(refusal));
  const missing = entries
    .map((e, i) => ({ e: e as Record<string, unknown>, i }))
    .filter(({ e }) => typeof e.test_file_content !== 'string' || typeof e.test_file_sha256 !== 'string')
    .map(({ i }) => i);
  if (missing.length > 0) {
    return jsonResponse(
      scenarioRefusalBody({
        code: SCENARIO_CODES.invalid,
        message:
          'gherkin_scenarios: every entry sent here must carry the scenario test-file content AND ' +
          'test_file_sha256 (this route stores evidence); refused, nothing written',
        issues: missing.map((i) => ({
          code: 'custom',
          path: [i],
          message: 'entry carries no test-file evidence',
        })) as z.ZodIssue[],
      }),
      400,
    );
  }
  const split = splitScenarioEvidence(document);
  if ('refusal' in split) return jsonResponse(scenarioRefusalBody(split.refusal), 400);
  // The pointers Planka gets: every field kept except test_file_content.
  const pointers = (JSON.parse(split.description!) as { gherkin_scenarios: Array<Record<string, unknown>> })
    .gherkin_scenarios;

  // ── 1. card gate: Planka read, then ONE short DB query (no connection held across the read) ──
  const agent = projectCardPlankaAgent();
  const gated = await readCard(agent, cardId);
  if ('response' in gated) return gated.response;
  const gatedBoard = String(gated.card.boardId ?? '');
  const project = await resolveCardRouteProjectByBoard(user, activeTenantId, gatedBoard);
  if (!project) return cardNotFound(cardId);

  // ── 2. the card's lease (gate first: a caller that cannot see the card never contends for it) ──
  const owner = await acquireCardEvidenceLease(cardId);
  if (owner === null) {
    return body(503, 'scenario_evidence_card_busy', {
      message: 'another scenario-evidence append to this card is in progress; retry',
      card_id: cardId,
      retry_after_ms: SCENARIO_EVIDENCE_LEASE_WAIT_MS,
    });
  }
  try {
    return await appendUnderLease(agent, cardId, owner, gatedBoard, project.id, split.evidence, pointers);
  } finally {
    await releaseCardEvidenceLease(cardId, owner);
  }
}

/**
 * Everything that must be serialised per card. The caller holds the card's
 * lease; NO DB connection is held here across any Planka await:
 *   re-read the description (Planka) → insert rows + document verdict (ONE
 *   short transaction, committed) → PATCH (Planka) → on failure delete exactly
 *   the rows this request created (short DB).
 */
async function appendUnderLease(
  agent: ReturnType<typeof projectCardPlankaAgent>,
  cardId: string,
  owner: string,
  gatedBoard: string,
  projectId: string,
  evidence: ReadonlyArray<ScenarioEvidence>,
  pointers: Array<Record<string, unknown>>,
): Promise<Response> {
  // ── 3. the description the PATCH replaces, read UNDER the lease ──
  const fresh = await readCard(agent, cardId);
  if ('response' in fresh) return fresh.response;
  // A card that left the gated board between the gate and the lease is not the card the gate admitted.
  if (String(fresh.card.boardId ?? '') !== gatedBoard) return cardNotFound(cardId);
  const card = fresh.card;

  // ── 4. rows + pointer verdict: ONE short transaction, write-once, all or nothing ──
  // The stored rows are the FIRST authority (a different sha ⇒ 409 from the
  // insert transaction itself). Only then, still INSIDE that transaction (a
  // pure computation on the description already read — no I/O), is the card
  // document checked for the entries this call CREATES; a document that
  // cannot take them aborts the transaction, so nothing is committed.
  let docVerdict: AppendScenarioEntriesResult | undefined;
  const documentRefused = new Error('card document refused the append');
  let results: AppendedScenarioEvidence[];
  try {
    results = await appendScenarioEvidence({
      cardId,
      projectId,
      evidence,
      beforeCommit: (res) => {
        const createdIds = new Set(res.filter((r) => r.result === 'created').map((r) => r.scenario_id));
        if (createdIds.size === 0) return; // all `unchanged`: no created pointer to verdict
        docVerdict = appendScenarioEntries(
          card.description,
          pointers.filter((p) => createdIds.has(String(p.scenario_id))),
        );
        if (!('description' in docVerdict)) throw documentRefused;
      },
    });
  } catch (err) {
    if (err instanceof ScenarioEvidenceConflictError) {
      return body(409, 'scenario_evidence_conflict', {
        message: err.message,
        card_id: cardId,
        scenario_ids: err.conflicts.map((c) => c.scenario_id),
        conflicts: err.conflicts,
        where: 'card_scenario_evidence',
      });
    }
    if (err === documentRefused && docVerdict && 'conflict' in docVerdict) {
      return body(409, 'scenario_evidence_conflict', {
        message:
          "the card's gherkin_scenarios already carries a DIFFERENT entry for these scenario_ids; " +
          'evidence is write-once, nothing written',
        card_id: cardId,
        scenario_ids: docVerdict.conflict,
        where: 'card_document',
      });
    }
    if (err === documentRefused && docVerdict && 'refusal' in docVerdict) {
      return body(422, docVerdict.refusal.code, { message: docVerdict.refusal.message, card_id: cardId });
    }
    throw err;
  }
  const created = results.filter((r) => r.result === 'created');
  const next = docVerdict as Extract<AppendScenarioEntriesResult, { description: string }> | undefined;
  let nextDescription: string | undefined = next && next.appended.length > 0 ? next.description : undefined;

  // ── orphan repair: `unchanged` rows whose pointer is missing from the card ──
  const repair = repairMissingPointers(
    nextDescription ?? card.description,
    results.filter((r) => r.result === 'unchanged'),
  );
  const repaired = new Set(repair?.repaired ?? []);
  if (repair) nextDescription = repair.description;

  // ── 5. the PATCH — no DB connection is open here ──
  let descriptionUpdated = false;
  if (nextDescription !== undefined) {
    // LEASE-LOST CHECK: the PATCH (new pointers AND orphan repair — one write)
    // replaces the whole description read in step 3, so it is only safe while
    // this request still owns the card's lease for at least the PATCH's own
    // duration. Otherwise: no Planka write, delete exactly this request's rows.
    if (!(await cardEvidenceLeaseStillHeld(cardId, owner))) {
      return await rollbackAndRespond(cardId, created, 503, 'scenario_evidence_lease_lost', {
        message:
          "this request's lease on the card expired before the description update; nothing was written " +
          'to the card and the rows this request created were deleted; retry',
        retry_after_ms: SCENARIO_EVIDENCE_LEASE_WAIT_MS,
      });
    }
    try {
      await agent.cards.update(cardId, { description: nextDescription });
      descriptionUpdated = true;
    } catch (err) {
      if (err instanceof PlankaError) {
        return await rollbackAndRespond(cardId, created, 502, 'planka_description_update_failed', {
          message: clientSafePlankaErrorMessage(err, 'cards/scenario-evidence description update'),
        });
      }
      if (err instanceof AppError) {
        // The chokepoint guard (a 400) or any other coded refusal: same rollback.
        return await rollbackAndRespond(cardId, created, err.statusCode, err.code ?? 'planka_description_update_refused', {
          message: err.message,
          ...(err.details && typeof err.details === 'object' ? err.details : {}),
        });
      }
      reportSwallowedFailure(err, {
        service: 'planka',
        method: 'cards.update',
        degradedTo: '500 scenario_evidence_description_update_failed after rolling back this request\'s rows',
      });
      return await rollbackAndRespond(cardId, created, 500, 'scenario_evidence_description_update_failed', {});
    }
  }

  return jsonResponse(
    {
      card_id: cardId,
      project_id: projectId,
      entries: results.map((r) => ({
        scenario_id: r.scenario_id,
        test_file_sha256: r.test_file_sha256,
        result: r.result,
        ...(repaired.has(r.scenario_id) ? { pointer_repaired: true } : {}),
      })),
      created_count: created.length,
      unchanged_count: results.length - created.length,
      description_updated: descriptionUpdated,
    },
    200,
  );
}

/**
 * Delete ONLY the rows this request created, then answer `status` with the
 * rollback outcome — `scenario_evidence_rolled_back` true/false, mirroring
 * POST /api/cards/project. A failed delete is reported, never assumed.
 */
async function rollbackAndRespond(
  cardId: string,
  created: ReadonlyArray<AppendedScenarioEvidence>,
  status: number,
  code: string,
  rest: Record<string, unknown>,
): Promise<Response> {
  let rolledBack = false;
  let removed = 0;
  try {
    removed = await deleteAppendedScenarioEvidence(cardId, created);
    rolledBack = removed === created.length;
  } catch (delErr) {
    reportSwallowedFailure(delErr, {
      service: 'fr-db',
      method: 'deleteAppendedScenarioEvidence',
      degradedTo: 'orphan card_scenario_evidence rows reported as scenario_evidence_rolled_back=false',
    });
  }
  return body(status, code, {
    ...rest,
    card_id: cardId,
    scenario_evidence_rolled_back: rolledBack,
    scenario_evidence_rows_removed: removed,
    scenario_ids: created.map((c) => c.scenario_id),
  });
}
