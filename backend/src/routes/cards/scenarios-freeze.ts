// POST /api/cards/:cardId/scenarios/freeze — READY's act (r.ready.scenarios):
// freeze an EXISTING card's gherkin_scenarios set by authoring its gherkin onto
// the stored skeleton and stamping `scenarios_check.scenario_hash`, the value
// R3b's tamper check reads.
//
// Body `{ scenarios: GherkinScenarioEntry[] (1..N), scenario_hash: <64 hex> }`,
// `.strict()`. The entries are checked as the card document
// `{ gherkin_scenarios: scenarios }` with the SAME strict schema and refusal
// codes as every other scenario write; `test_file_content` is refused here
// (evidence goes through POST /api/cards/:id/scenario-evidence, never a freeze).
// `scenario_hash` is NEVER trusted: fr recomputes canonical-scenarios-hash v1
// over `scenarios` and a difference is 422 `scenario_hash_mismatch` BEFORE any
// Planka or DB I/O (coordinator ruling B4).
//
// TENANCY + CARD GATE — exactly scenario-evidence.ts's: tenant from the
// authenticated principal only (`validateAuth` + `ctxTenantId`), the EXEC pin
// (`cardRouteTenantRefusal`), and the card must sit on the board of a project
// that resolves under the caller's tenant projection
// (`resolveCardRouteProjectByBoard`). Foreign / unknown / non-project-board
// cards all answer 404 `card_not_found`.
//
// LIST GATE — the card must sit on a FREEZABLE list (resolved by exact name via
// `resolveProjectTargetList`, the decomposition-split precedent), else 409
// `card_not_in_ready`. Re-checked under the lease.
//
// ORDER — ⛔ no DB connection is ever held across Planka I/O:
//   1. gate: Planka card read, one short project-resolve query, the board's lists;
//   2. the card's LEASE — the SAME namespace + key as scenario-evidence (see
//      _card-document-lease.ts: both routes rewrite the whole description);
//   3. re-read the description under the lease (board + list re-checked);
//   4. `freezeScenarioSet` (pure): unchanged ⇒ 200 with no PATCH; a different
//      stored hash ⇒ 409 `scenarios_frozen`; a refusal ⇒ its code/status
//      (incl. 409 `scenarios_brief_conflict`: ncn's readied_brief would shadow
//      the frozen head — refused on a replay too), body {error, code, card_id, message};
//   5. LEASE-LOST CHECK, then the PATCH through `CardsResource.update` (the
//      description-guard chokepoint). Nothing in fr's DB to roll back;
//   6. release the lease in `finally`.

import { z } from 'zod';

import {
  assertDescriptionScenarios,
  checkDescriptionScenarios,
  freezeScenarioSet,
  scenarioRefusalBody,
  scenarioRefusalStatus,
  SCENARIO_CODES,
  SCENARIO_FREEZE_CODES,
  SCENARIO_REFUSAL_QA_NEEDS_INFO,
} from '../../services/gherkin-scenarios';
import { scenariosHash } from '../../lib/scenarios-hash';
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
  resolveProjectTargetList,
} from './project';
import {
  acquireCardEvidenceLease,
  body,
  cardDocumentLeaseWaitMs,
  cardEvidenceLeaseStillHeld,
  cardNotFound,
  readCard,
  releaseCardEvidenceLease,
} from './_card-document-lease';

/**
 * The lists a card's scenario set may be frozen FROM. READY only: ncn's
 * cells/ready.json runs ready-prefetch (r.ready.scenarios) in READY, which is
 * the one caller of this route. Widen to TODO only if r.ready.scenarios moves.
 */
export const FREEZABLE_LISTS: readonly string[] = ['READY'];

/** `{ scenarios, scenario_hash }` and nothing else — a tenant (or any key) in the body is refused, never read. */
const BodySchema = z
  .object({
    scenarios: z.array(z.unknown()).min(1, 'scenarios must hold at least one gherkin_scenarios entry'),
    scenario_hash: z.string().regex(/^[0-9a-f]{64}$/, 'scenario_hash must be 64 lowercase hex'),
  })
  .strict();

const FETCH_CONTEXT = 'cards/scenarios-freeze card fetch';

function notInReady(cardId: string, list: string | null): Response {
  return body(409, 'card_not_in_ready', {
    message: `a card's scenario set is frozen only from ${[...FREEZABLE_LISTS].join('/')}; the card is in ${
      list ?? 'an unknown list'
    }`,
    card_id: cardId,
    list,
  });
}

export async function handleFreezeScenarios(req: Request, cardId: string): Promise<Response> {
  const user = await validateAuth(req);
  // ⭐ THE tenant: the authenticated principal's. Never the body, never a header read here.
  const activeTenantId = ctxTenantId(user.tenantId);
  // Same principals as POST /api/cards/project (a predicate on the CALLER, not the card).
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
  const { scenario_hash: sentHash } = parsedBody.data;
  const scenarios = parsedBody.data.scenarios as Array<Record<string, unknown>>;

  // The scenarios ARE a card document's gherkin_scenarios: same schema, same codes.
  const document = JSON.stringify({ gherkin_scenarios: scenarios });
  const refusal = checkDescriptionScenarios(document);
  if (refusal) return jsonResponse(scenarioRefusalBody(refusal), scenarioRefusalStatus(refusal));
  // Evidence never rides a freeze: the existing content-not-accepted-here refusal.
  try {
    assertDescriptionScenarios(document);
  } catch (err) {
    if (err instanceof AppError) {
      return body(err.statusCode, err.code ?? SCENARIO_CODES.contentNotAcceptedHere, {
        message: err.message,
        ...(err.details && typeof err.details === 'object' ? err.details : {}),
      });
    }
    throw err;
  }

  // ── the hash is RECOMPUTED, never trusted — before any Planka/DB I/O ──
  let expected: string | null;
  try {
    expected = scenariosHash(scenarios as never);
  } catch {
    expected = null; // duplicate scenario_id — the schema refuses it first
  }
  if (expected !== sentHash) {
    return body(422, SCENARIO_CODES.scenarioHashMismatch, {
      message:
        'scenario_hash is not the canonical-scenarios-hash v1 fr recomputes from the sent scenarios; nothing written',
      card_id: cardId,
      expected,
      sent: sentHash,
    });
  }

  // ── 1. card gate: Planka read, ONE short DB query, the board's lists ──
  const agent = projectCardPlankaAgent();
  const gated = await readCard(agent, cardId, FETCH_CONTEXT);
  if ('response' in gated) return gated.response;
  const gatedBoard = String(gated.card.boardId ?? '');
  const project = await resolveCardRouteProjectByBoard(user, activeTenantId, gatedBoard);
  if (!project) return cardNotFound(cardId);

  let lists: Awaited<ReturnType<typeof agent.lists.listByBoard>>;
  try {
    lists = await agent.lists.listByBoard(gatedBoard);
  } catch (err) {
    if (err instanceof PlankaError) {
      return body(502, 'planka_list_fetch_failed', {
        message: clientSafePlankaErrorMessage(err, 'cards/scenarios-freeze list fetch'),
        card_id: cardId,
      });
    }
    throw err;
  }
  const freezableListIds = new Set(
    FREEZABLE_LISTS.map((name) => resolveProjectTargetList(lists, name)?.id)
      .filter((id) => id !== undefined && id !== null)
      .map((id) => String(id)),
  );
  const listNameOf = (listId: unknown) => lists.find((l) => String(l.id) === String(listId ?? ''))?.name ?? null;
  if (!freezableListIds.has(String(gated.card.listId ?? ''))) return notInReady(cardId, listNameOf(gated.card.listId));

  // ── 2. the card's lease (SAME namespace + key as scenario-evidence) ──
  const owner = await acquireCardEvidenceLease(cardId);
  if (owner === null) {
    return body(503, 'scenarios_freeze_card_busy', {
      message: 'another write to this card\'s description is in progress; retry',
      card_id: cardId,
      retry_after_ms: cardDocumentLeaseWaitMs(),
    });
  }
  try {
    return await freezeUnderLease(agent, cardId, owner, gatedBoard, project.id, freezableListIds, listNameOf, scenarios, sentHash);
  } finally {
    await releaseCardEvidenceLease(cardId, owner);
  }
}

async function freezeUnderLease(
  agent: ReturnType<typeof projectCardPlankaAgent>,
  cardId: string,
  owner: string,
  gatedBoard: string,
  projectId: string,
  freezableListIds: ReadonlySet<string>,
  listNameOf: (listId: unknown) => string | null,
  scenarios: ReadonlyArray<Record<string, unknown>>,
  sentHash: string,
): Promise<Response> {
  // ── 3. the description the PATCH replaces, read UNDER the lease ──
  const fresh = await readCard(agent, cardId, FETCH_CONTEXT);
  if ('response' in fresh) return fresh.response;
  if (String(fresh.card.boardId ?? '') !== gatedBoard) return cardNotFound(cardId);
  if (!freezableListIds.has(String(fresh.card.listId ?? ''))) return notInReady(cardId, listNameOf(fresh.card.listId));

  // ── 4. the freeze verdict (pure) ──
  const verdict = freezeScenarioSet(fresh.card.description, scenarios, sentHash);
  if (verdict.kind === 'unchanged') {
    return jsonResponse(
      {
        card_id: cardId,
        project_id: projectId,
        result: 'unchanged',
        scenario_hash: sentHash,
        scenario_count: verdict.scenarioCount,
        description_updated: false,
      },
      200,
    );
  }
  if (verdict.kind === 'conflict') {
    return body(409, SCENARIO_FREEZE_CODES.frozen, {
      message: "the card's scenario set is already frozen under a different scenario_hash; a frozen set is never re-frozen",
      card_id: cardId,
      stored_scenario_hash: verdict.storedHash,
      sent_scenario_hash: sentHash,
    });
  }
  if (verdict.kind === 'refusal') {
    return body(verdict.status, verdict.code, {
      message: verdict.message,
      card_id: cardId,
      ...(verdict.issues ? { issues: verdict.issues } : {}),
    });
  }

  // ── 5. LEASE-LOST CHECK, then the PATCH ──
  if (!(await cardEvidenceLeaseStillHeld(cardId, owner, '503 scenarios_freeze_lease_lost; no Planka write'))) {
    return body(503, 'scenarios_freeze_lease_lost', {
      message: "this request's lease on the card expired before the description update; nothing was written; retry",
      card_id: cardId,
      retry_after_ms: cardDocumentLeaseWaitMs(),
    });
  }
  try {
    await agent.cards.update(cardId, { description: verdict.description });
  } catch (err) {
    if (err instanceof PlankaError) {
      return body(502, 'planka_description_update_failed', {
        message: clientSafePlankaErrorMessage(err, 'cards/scenarios-freeze description update'),
        card_id: cardId,
      });
    }
    if (err instanceof AppError) {
      // The chokepoint guard (a 400) or any other coded refusal.
      return body(err.statusCode, err.code ?? 'planka_description_update_refused', {
        message: err.message,
        ...(err.details && typeof err.details === 'object' ? err.details : {}),
        card_id: cardId,
      });
    }
    reportSwallowedFailure(err, {
      service: 'planka',
      method: 'cards.update',
      degradedTo: '500 scenarios_freeze_description_update_failed',
    });
    return body(500, 'scenarios_freeze_description_update_failed', { card_id: cardId });
  }

  return jsonResponse(
    {
      card_id: cardId,
      project_id: projectId,
      result: 'frozen',
      scenario_hash: sentHash,
      scenario_count: verdict.scenarioCount,
      description_updated: true,
    },
    200,
  );
}
