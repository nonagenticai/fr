// U7 (LEDGER C2-31, movies-ab ruling 2026-10-01) — EVIDENCE APPEND ON A DEDUPE HIT.
//
// WHAT WAS BROKEN. POST /api/cards/improvement collapses a request onto an
// already-OPEN improvement card (asset arm: `findOpenCardForAsset`, name arm:
// `findOpenCardByName`, plus the lease loser / winner-recheck paths) and
// answered `{ card_id, deduped: true }` — persisting NOTHING from the request.
// The fr dedupe key for a `procedure_improvement` card is the PROCEDURE
// (`<card_type>.<phase>.action`), not the source card, so the second, third …
// bounced coding card blamed on the same procedure had its evidence (source
// card, bounces, versions, trace id) thrown away. The ruling: every bounced
// card's evidence lands on EXACTLY ONE open improvement card — 0 duplicates,
// 0 lost bounces. So a dedupe hit now APPENDS.
//
// WHAT IS WRITTEN — ONE Planka comment on the open card, in two parts:
//   (a) a human-readable summary (source card, execution, bounces, blamed
//       procedure, versions, trace_id or its null-reason), and
//   (b) a fenced ```json STRUCTURED RECORD (`record: fr.improvement_evidence.v1`)
//       carrying the same facts plus the idempotency key and the request's
//       `additional_context` verbatim (bounded).
//
// ⚠️ WHY A COMMENT AND NOT A PLANKA ATTACHMENT. Planka's createAttachment is
// multipart/form-data; fr's PlankaHttp is JSON-only and fr has no attachment
// client anywhere — an attachment would be a NEW transport, not reuse. The card
// DESCRIPTION is the other candidate and is refused: it is the n8n DOING
// card-hydration source (create.ts), and a read-modify-write on it from
// concurrent dedupe hits loses entries. A comment is append-only (no lost
// update), written through the existing `planka.comments` client, lives on the
// card itself, and the fenced record is machine-readable the same way the
// description's fence is.
//
// ⛔ TENANT SEPARATION — STRICT. The append happens only when the open card's
// own `Metadata.keycloak_tenant_id` equals the request's RESOLVED tenant. A card
// with a different tenant → `tenant_mismatch`; a card carrying no tenant at all
// → `tenant_unknown`. Both write nothing. The card is on the stream board the
// route resolved for that same tenant, so this is a second, card-level fence,
// not the only one.
//
// IDEMPOTENCY — per SOURCE EXECUTION. Key = source card id + source execution id
// (`additional_context.source_execution_id`, or the producers' existing
// spellings `done_execution_id` / `blocked_escalate_execution_id` /
// `execution_id`). A replay of the same execution appends nothing; a different
// execution of the same source card appends a new entry. An evidence-bearing
// request (it always carries `source_card_id`, see SCOPE) that lacks an
// execution id falls back to a SHA-256 of the request's identifying content
// (key_basis `content_hash`) — a byte-identical replay is still idempotent, but
// two genuinely different executions with identical bodies would collapse. The
// basis is recorded on every entry so that weaker key is never mistaken for the
// strong one. The key is stamped as a `fr-evidence-key: <key>` line and checked
// by walking EVERY page of the card's comments before writing.
//
// ⚠️ NOT EXACTLY-ONCE UNDER A RACE: two replays of the same execution arriving
// inside one list→create window can both write. The measured producer
// (done-finalize, once per card DONE) does not race itself; a stricter guarantee
// would need a lease around the scan, which is not worth its cost here.
//
// ⛔ SCOPE — EVIDENCE-BEARING REQUESTS ONLY. The append fires only when
// `additional_context` is an OBJECT carrying `source_card_id` — the shape the U7
// producers send (QA-first-pass and blocked-escalate learning requests). Every
// other dedupe hit (notably the detectors' `*_analysis` re-emits, which collapse
// onto their open card on every run) is answered EXACTLY as before U7:
// `{ card_id, deduped: true }`, no evidence fields, zero Planka calls. Appending
// on those would be comment spam on cards U7 has nothing to say about. See
// `isEvidenceBearing`.
//
// FAILURE SEMANTICS — NON-FATAL, NEVER SILENT. The request's outcome (the card
// already exists, here is its id) does not depend on the append. Failing the
// request would invite a retry; swallowing would reproduce the bug. So every
// failure is logged AND returned as `evidence_appended: false` with a named
// reason — the same shape as `stream_membership` on the route.

import { createHash } from 'node:crypto';

import type { PlankaClient } from '../planka';
import { IMPROVEMENT_CARD_FIELD_GROUP_NAME } from '../planka/custom-fields';
import type { CardGenerationRequestT } from './request-schema';

export const EVIDENCE_RECORD_SCHEMA = 'fr.improvement_evidence.v1';
export const EVIDENCE_KEY_PREFIX = 'fr-evidence-key: ';
/** Upper bound on the serialized `additional_context` copied into the record. */
export const EVIDENCE_CONTEXT_MAX_CHARS = 16_000;
/** Page cap for the idempotency scan (Planka pages comments). */
export const EVIDENCE_SCAN_MAX_PAGES = 40;

export type EvidenceSkipReason =
  | 'no_open_card_visible'
  | 'board_read_failed'
  | 'tenant_unknown'
  | 'tenant_mismatch'
  | 'comment_scan_failed'
  | 'comment_write_failed';

export type EvidenceKeyBasis = 'source_execution' | 'content_hash';

export type EvidenceAppendOutcome =
  | {
      appended: true;
      /** true = this exact evidence was already on the card; nothing new written. */
      replay: boolean;
      key: string;
      key_basis: EvidenceKeyBasis;
    }
  | {
      appended: false;
      reason: EvidenceSkipReason;
      key?: string;
      key_basis?: EvidenceKeyBasis;
    };

export interface AppendDedupeEvidenceInput {
  boardId: string;
  /** The open card the request collapsed onto; null when none is visible yet. */
  cardId: string | null;
  /** The request's RESOLVED tenant (never the body's claim). */
  tenantId: string;
  cardRequest: CardGenerationRequestT;
  /** Which dedupe path fired — recorded, not interpreted. */
  dedupePath: string;
}

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() ? v.trim() : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** JSON with sorted object keys — a stable input for the content hash. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = asObj(v);
  if (o) {
    return (
      '{' +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v ?? null);
}

export interface ExtractedEvidence {
  key: string;
  key_basis: EvidenceKeyBasis;
  source_card_id: string | null;
  source_execution_id: string | null;
  trace_id: string | null;
  trace_id_reason: string | null;
  blamed_procedure: string | null;
  bounces: Array<Record<string, unknown>>;
  bounce_kinds: string[];
  block_reason_class: string | null;
  versions: Record<string, unknown>;
  additional_context: unknown;
  additional_context_truncated: boolean;
}

const EXECUTION_ID_FIELDS = [
  'source_execution_id',
  'done_execution_id',
  'blocked_escalate_execution_id',
  'execution_id',
] as const;

const VERSION_FIELDS = [
  'procedure_version',
  'version_stamp',
  'version_stamp_reason',
  'executed_workflow_version_ids',
  'executed_workflow_version_ids_reason',
  'prompt_version_ids',
  'prompt_version_ids_reason',
  'procedure_body_hash',
  'procedure_body_hash_reason',
] as const;

/**
 * The U7 scope gate: only a request whose `additional_context` is an object
 * carrying a non-empty `source_card_id` has evidence to append. Everything else
 * (detector `*_analysis` re-emits, manual cards, string contexts) does not.
 */
export function isEvidenceBearing(req: CardGenerationRequestT): boolean {
  return str(asObj(req.additional_context)?.source_card_id) !== null;
}

/** Pure: everything the append needs, derived from the request body alone. */
export function extractEvidence(req: CardGenerationRequestT): ExtractedEvidence {
  const ac = asObj(req.additional_context);

  const source_card_id = str(ac?.source_card_id);
  let source_execution_id: string | null = null;
  for (const f of EXECUTION_ID_FIELDS) {
    source_execution_id = str(ac?.[f]);
    if (source_execution_id) break;
  }

  const trace_id = str(ac?.trace_id);
  const trace_id_reason = trace_id
    ? null
    : (str(ac?.trace_id_reason) ?? 'the request carried no trace_id and no reason for its absence');

  const bounces = Array.isArray(ac?.bounces)
    ? (ac!.bounces as unknown[]).map((b) => asObj(b)).filter((b): b is Obj => b !== null)
    : [];
  const bounce_kinds = bounces.map(
    (b) => `${str(b.from) ?? '?'}->${str(b.to) ?? '?'}`,
  );

  const versions: Record<string, unknown> = {};
  for (const f of VERSION_FIELDS) {
    if (ac && ac[f] !== undefined) versions[f] = ac[f];
  }

  let additional_context: unknown = req.additional_context ?? null;
  let additional_context_truncated = false;
  const serialized = JSON.stringify(additional_context);
  if (serialized && serialized.length > EVIDENCE_CONTEXT_MAX_CHARS) {
    additional_context = serialized.slice(0, EVIDENCE_CONTEXT_MAX_CHARS);
    additional_context_truncated = true;
  }

  let key: string;
  let key_basis: EvidenceKeyBasis;
  if (source_card_id && source_execution_id) {
    key = `ev1:src:${source_card_id}:exec:${source_execution_id}`;
    key_basis = 'source_execution';
  } else {
    const digest = createHash('sha256')
      .update(
        canonicalJson({
          card_type: req.card_type,
          asset_id: req.asset_id ?? null,
          parent_card_id: req.parent_card_id,
          requestor: req.requestor,
          problem_statement: req.problem_statement,
          additional_context: req.additional_context ?? null,
        }),
      )
      .digest('hex');
    key = `ev1:sha256:${digest}`;
    key_basis = 'content_hash';
  }

  return {
    key,
    key_basis,
    source_card_id,
    source_execution_id,
    trace_id,
    trace_id_reason,
    blamed_procedure: str(ac?.blamed_procedure) ?? str(req.asset_id),
    bounces,
    bounce_kinds,
    block_reason_class: str(ac?.block_reason_class),
    versions,
    additional_context,
    additional_context_truncated,
  };
}

/** The open card's own tenant, from its Metadata.keycloak_tenant_id field. */
async function readCardTenant(
  planka: PlankaClient,
  boardId: string,
  cardId: string,
): Promise<string | null> {
  const view = await planka.customFields.getBoardCustomFields(boardId);
  const group = view.customFieldGroups.find(
    (g) => g.name === IMPROVEMENT_CARD_FIELD_GROUP_NAME && g.boardId === boardId,
  );
  if (!group) return null;
  const field = view.customFields.find(
    (f) => f.customFieldGroupId === group.id && f.name === 'keycloak_tenant_id',
  );
  if (!field) return null;
  const v = view.customFieldValues.find(
    (x) => x.cardId === cardId && x.customFieldId === field.id,
  );
  return str(v?.content);
}

function hasKeyLine(text: string | undefined, key: string): boolean {
  if (!text) return false;
  const line = EVIDENCE_KEY_PREFIX + key;
  return text.split('\n').some((l) => l.trim() === line);
}

/** Walks every page of the card's comments looking for the key. */
async function keyAlreadyOnCard(
  planka: PlankaClient,
  cardId: string,
  key: string,
): Promise<boolean> {
  let beforeId: string | undefined;
  for (let page = 0; page < EVIDENCE_SCAN_MAX_PAGES; page++) {
    const items = await planka.comments.listForCard(cardId, beforeId ? { beforeId } : {});
    if (items.length === 0) return false;
    if (items.some((c) => hasKeyLine(c.text, key))) return true;
    const last = items[items.length - 1]?.id;
    if (!last || last === beforeId) return false;
    beforeId = last;
  }
  // Cap reached without a match. Appending risks a duplicate entry; refusing
  // would DROP evidence, which the ruling forbids. A duplicate is the lesser
  // error and is still visible — so proceed, loudly.
  console.warn(
    `[improvement-cards] evidence idempotency scan hit the ${EVIDENCE_SCAN_MAX_PAGES}-page cap on card ${cardId}; appending`,
  );
  return false;
}

/**
 * Hard upper bound on the WHOLE comment (summary + fenced record), in UTF-8
 * bytes. Planka rejects a comment over 1 MiB; a rejected write is
 * `comment_write_failed`, i.e. the evidence is LOST — the very outcome U7
 * exists to prevent. `bounces` / `versions` / `problem_statement` arrive
 * unbounded from the request, so capping only `additional_context` (16k) is
 * not a bound on the comment. 64 KiB leaves a 16x margin under Planka's limit.
 */
export const EVIDENCE_COMMENT_MAX_BYTES = 64 * 1024;
/** Per-value clip for the human-readable summary lines. */
export const EVIDENCE_SUMMARY_VALUE_MAX_CHARS = 1_000;
/** What a truncated record field is replaced with: a preview of its JSON. */
export const EVIDENCE_TRUNCATED_PREVIEW_CHARS = 1_024;

/**
 * Record fields that MAY be truncated to fit the cap, largest first.
 * ⛔ Deliberately absent, never truncated: `record`, `idempotency_key`,
 * `key_basis`, `tenant_id`, `target_card_id`, `source_card_id`,
 * `source_execution_id`, `dedupe_path`, `appended_at` — the identity of the
 * entry. A truncated key line would break idempotency; a truncated tenant
 * would break the tenant audit.
 */
const TRUNCATABLE_RECORD_FIELDS = [
  'additional_context',
  'bounces',
  'versions',
  'bounce_kinds',
  'problem_statement',
  'trace_id_reason',
  'blamed_procedure',
  'block_reason_class',
  'trace_id',
  'requestor',
  'card_type',
  'asset_id',
  'asset_kind',
] as const;

function clip(v: string, max = EVIDENCE_SUMMARY_VALUE_MAX_CHARS): string {
  return v.length > max ? `${v.slice(0, max)}… [truncated, ${v.length} chars]` : v;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function renderEvidenceComment(
  ev: ExtractedEvidence,
  input: AppendDedupeEvidenceInput & { cardId: string },
  appendedAt: string,
): string {
  const r = input.cardRequest;
  const bounceLine = ev.bounces.length
    ? ev.bounces
        .map(
          (b) =>
            `${str(b.from) ?? '?'}->${str(b.to) ?? '?'}` +
            (str(b.at) ? `@${str(b.at)}` : '') +
            (str(b.action_id) ? ` (action ${str(b.action_id)})` : ''),
        )
        .join(', ')
    : '(none carried)';
  const versionKeys = Object.keys(ev.versions);
  const record: Record<string, unknown> = {
    record: EVIDENCE_RECORD_SCHEMA,
    idempotency_key: ev.key,
    key_basis: ev.key_basis,
    evidence_appended: true,
    appended_at: appendedAt,
    dedupe_path: input.dedupePath,
    target_card_id: input.cardId,
    tenant_id: input.tenantId,
    requestor: r.requestor,
    card_type: r.card_type,
    asset_id: r.asset_id ?? null,
    asset_kind: r.asset_kind ?? null,
    source_card_id: ev.source_card_id,
    source_execution_id: ev.source_execution_id,
    trace_id: ev.trace_id,
    trace_id_reason: ev.trace_id_reason,
    blamed_procedure: ev.blamed_procedure,
    bounce_kinds: ev.bounce_kinds,
    bounces: ev.bounces,
    block_reason_class: ev.block_reason_class,
    versions: ev.versions,
    problem_statement: r.problem_statement.slice(0, 500),
    additional_context: ev.additional_context,
    additional_context_truncated: ev.additional_context_truncated,
    /** Record fields replaced by a preview to fit EVIDENCE_COMMENT_MAX_BYTES. */
    truncated: [] as string[],
  };
  // Summary values are clipped individually — EXCEPT the identity lines
  // (source card / execution and the key line), which are never cut.
  const summary = [
    '**Improvement evidence appended** (dedupe hit — this request collapsed onto this open card)',
    `- requestor: ${clip(r.requestor)}`,
    `- source card: ${ev.source_card_id ?? '(none carried)'}`,
    `- source execution: ${ev.source_execution_id ?? '(none carried)'}`,
    `- blamed procedure: ${clip(ev.blamed_procedure ?? '(none carried)')}`,
    `- bounces: ${clip(bounceLine)}`,
    ...(ev.block_reason_class ? [`- block reason class: ${clip(ev.block_reason_class)}`] : []),
    `- versions: ${clip(versionKeys.length ? versionKeys.join(', ') + ' (see record)' : '(none carried)')}`,
    `- trace_id: ${clip(ev.trace_id ?? `null — ${ev.trace_id_reason}`)}`,
    EVIDENCE_KEY_PREFIX + ev.key,
    '',
  ];
  const assemble = (): string =>
    [...summary, '```json', JSON.stringify(record, null, 2), '```'].join('\n');

  // Fit the WHOLE comment under the cap: replace the largest truncatable field
  // with a bounded preview of its JSON, one at a time, until it fits.
  let text = assemble();
  const truncated = record.truncated as string[];
  while (byteLen(text) > EVIDENCE_COMMENT_MAX_BYTES) {
    let largest: string | null = null;
    let largestLen = -1;
    for (const f of TRUNCATABLE_RECORD_FIELDS) {
      if (truncated.includes(f)) continue;
      const len = byteLen(JSON.stringify(record[f] ?? null));
      if (len > largestLen) {
        largest = f;
        largestLen = len;
      }
    }
    // Nothing left to cut, or what is left is already preview-sized: stop.
    if (!largest || largestLen <= EVIDENCE_TRUNCATED_PREVIEW_CHARS) break;
    const json = JSON.stringify(record[largest] ?? null);
    record[largest] = `${json.slice(0, EVIDENCE_TRUNCATED_PREVIEW_CHARS)}… [truncated, ${json.length} chars]`;
    truncated.push(largest);
    text = assemble();
  }
  if (byteLen(text) > EVIDENCE_COMMENT_MAX_BYTES) {
    // Only the never-truncated identity fields can be this large. Write it
    // anyway (Planka's own limit is 16x higher) — and say so.
    console.warn(
      `[improvement-cards] evidence comment is ${byteLen(text)} bytes after truncation ` +
        `(cap ${EVIDENCE_COMMENT_MAX_BYTES}); identity fields are oversized, key=${clip(ev.key, 200)}`,
    );
  }
  return text;
}

/**
 * Append the request's evidence to the open card it was deduped onto.
 * NEVER throws: every failure is a named `appended: false` outcome.
 */
export async function appendDedupeEvidence(
  planka: PlankaClient,
  input: AppendDedupeEvidenceInput,
): Promise<EvidenceAppendOutcome> {
  const ev = extractEvidence(input.cardRequest);
  const keyed = { key: ev.key, key_basis: ev.key_basis };
  const cardId = input.cardId;
  const log = (reason: EvidenceSkipReason, err?: unknown): EvidenceAppendOutcome => {
    console.warn(
      `[improvement-cards] dedupe evidence NOT appended (${reason}) card=${cardId ?? 'none'} ` +
        `board=${input.boardId} key=${ev.key}` +
        (err !== undefined ? `: ${err instanceof Error ? err.message : String(err)}` : ''),
    );
    return { appended: false, reason, ...keyed };
  };

  if (!cardId) return log('no_open_card_visible');

  let cardTenant: string | null;
  try {
    cardTenant = await readCardTenant(planka, input.boardId, cardId);
  } catch (e) {
    return log('board_read_failed', e);
  }
  if (!cardTenant) return log('tenant_unknown');
  if (cardTenant.toLowerCase() !== input.tenantId.trim().toLowerCase()) {
    return log('tenant_mismatch');
  }

  try {
    if (await keyAlreadyOnCard(planka, cardId, ev.key)) {
      return { appended: true, replay: true, ...keyed };
    }
  } catch (e) {
    return log('comment_scan_failed', e);
  }

  const appendedAt = new Date().toISOString();
  try {
    await planka.comments.create({
      cardId,
      text: renderEvidenceComment(ev, { ...input, cardId }, appendedAt),
    });
  } catch (e) {
    return log('comment_write_failed', e);
  }
  return { appended: true, replay: false, ...keyed };
}

/**
 * The response fields the route adds to an EVIDENCE-BEARING deduped answer.
 * A non-evidence-bearing hit gets none of them (pre-U7 bytes).
 */
export function evidenceResponseFields(o: EvidenceAppendOutcome): Record<string, unknown> {
  return o.appended
    ? {
        evidence_appended: true,
        ...(o.replay ? { evidence_reason: 'already_appended' } : {}),
        evidence_key: o.key,
        evidence_key_basis: o.key_basis,
      }
    : {
        evidence_appended: false,
        evidence_reason: o.reason,
        ...(o.key ? { evidence_key: o.key, evidence_key_basis: o.key_basis } : {}),
      };
}
