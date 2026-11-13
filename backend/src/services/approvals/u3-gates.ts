// src/services/approvals/u3-gates.ts
//
// U3 — the proof-run approval gates (labels: migrations 152 + 153).
//
//   bug_fix_authorization MARKER      G-12 A1. NOT A KIND. RULING 10-01 (movies-13): the one
//                                     bug-fix path is the LIVE doing-orchestrate gate, so the
//                                     gate is ANY approvals row — `generic` (blocked-escalate
//                                     deblock) or `execution.ready_signoff` (ready-prefetch) —
//                                     whose `metadata.approval_kind = 'bug_fix_authorization'`
//                                     (isBugFixAuthorizationRow). The U3 kind
//                                     `execution.bug_fix_approval` is DROPPED: no producer ever
//                                     emitted it, so a gate keyed on it could never fire.
//                                     Mint (resolveBugFixAuthorizationMint): metadata cites the
//                                     U2 bug report {report_id, report_hash, bug_ids[],
//                                     bug_card_id}; the report must exist in the tenant with
//                                     that H_r, be a bug_report of the BUG card, list ≥1 bug,
//                                     and bug_ids ⊆ its bugs. Decide: G-12 A1 structured
//                                     decision + rejected_bug_ids[] ⊆ bug_ids, hash re-checked.
//   execution.feature_design_approval G-12 A3. n8n SENDS the kind; metadata
//                                     {design_artifact_id, design_hash, contract_hash,
//                                     scenarios[{scenario_id, criterion_id, title,
//                                     gherkin}], scenarios_hash} — scenarios_hash is
//                                     RECOMPUTED (src/lib/scenarios-hash.ts), 422 on
//                                     mismatch. ⚠️ fr has NO design-artefact store,
//                                     so the hash cannot be checked against a stored
//                                     artefact: it is required, recorded, and at decide
//                                     the decider must attest the SAME hash.
//                                     P2.3: optional metadata.handoff_contract (handoff.v2,
//                                     ./handoff-contract.ts) — strict, sealed by
//                                     contract_hash (422 contract_hash_mismatch), stored
//                                     verbatim. Top-level A3 metadata is .strict().
//   qa.coverage_signoff               G-12 A4 / AA-TRACE §6.17. NEVER sent: DERIVED from
//                                     deblock_action=COVERAGE + block_reason_class
//                                     no_computed_check + a `no_computed_check:` block
//                                     reason, and validated against §6.14
//                                     (`metadata.coverage_request`, inline only).
//
// FILE BOUNDARY (agreed with quality-rebuild-closeout, fr#1333): this module does NOT
// touch deblock-actions.ts, LAPSE_HOLDS, the chat-seat refusals, or the COVERAGE
// decide-side validation and callback forwarding. It never WRITES
// `approvals.metadata.coverage_decision` (fr#1333 does, at decide time); the ac_coverage
// writeback in ./ac-coverage-writeback.ts only READS it.
//
// WHY THE MINT GATE READS THE RAW BODY. `N8nCardApprovalSchema` is a closed z.object:
// keys it does not declare are stripped, and fr#1333's `metadata` field (e08c0581) parses
// ONLY `metadata.coverage_request`, deliberately LENIENTLY (`.catch(undefined)`: a malformed
// request is dropped, not refused) — and carries no bug_fix/design keys at all. A strict
// gate that read the PARSED object could therefore never see — and never refuse — the
// malformed request. So the gate reads the raw request body, validates ONLY the keys it
// owns with strict typed per-kind schemas, and persists only what those schemas output.
// Nothing arbitrary from the body reaches the jsonb through this module.

import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db as defaultDb, projectReports } from '../../db/client';
import { AppError, ValidationError } from '../../utils/errors';
import { decidedByKindFor } from '../../lib/decided-by-kind';
import { scenariosHash } from '../../lib/scenarios-hash';
import { asDeblockAction, isBugFixAuthorizationRow, type DeblockAction } from '../../domain/engagement/deblock-actions';
import { assertReportBeforeApproval } from '../reports/bug-report';
import { canonicalizeJcs } from '../../lib/bug-report-hash';
import { writeSetSeal } from '../../lib/write-set';
import { HANDOFF_CONTRACT_VERSION, HandoffContractSchema, handoffContractHash } from './handoff-contract';
import { assertWriteSetPaths, compareBytes, WriteSetPathsError } from './write-set-paths';
import {
  NO_REGISTERED_ANSWER,
  QUESTION_REGISTRY,
  answeredCode,
  isQuestionId,
  type QuestionId,
} from './question-registry';
import {
  G12_RULES,
  g12CodesFor,
  g12RowKeyFor,
  g12RuleFor,
  type G12ItemDecision,
} from './g12-rule';

export const FEATURE_DESIGN_APPROVAL_KIND = 'execution.feature_design_approval' as const;
export const COVERAGE_SIGNOFF_KIND = 'qa.coverage_signoff' as const;
/** G-12 A6 — a conveyor QUESTION stamped with a pre-registered question_id (migration 155). */
export const QUESTION_KIND = 'execution.question' as const;

/** Every kind decided under a G-12 row on this module's gates; no other kind may dedupe onto one. */
export const G12_GATE_KINDS = [FEATURE_DESIGN_APPROVAL_KIND, COVERAGE_SIGNOFF_KIND, QUESTION_KIND] as const;

/** The U3 kinds n8n may SEND. `qa.coverage_signoff` is deliberately absent: it is derived. */
export const U3_SENDABLE_KINDS = [FEATURE_DESIGN_APPROVAL_KIND, QUESTION_KIND] as const;
export type U3Kind = typeof FEATURE_DESIGN_APPROVAL_KIND | typeof COVERAGE_SIGNOFF_KIND | typeof QUESTION_KIND;

/**
 * Kinds whose DECISION fr gates here (G-12 structured decision). Coverage is fr#1333's.
 * The bug-fix gate is NOT in this list: it is keyed on the marker, not a kind
 * (isBugFixAuthorizationRow), and is checked before this list is consulted.
 */
export const U3_DECIDE_GATED_KINDS: readonly string[] = [FEATURE_DESIGN_APPROVAL_KIND, QUESTION_KIND];

// ── the live bug-fix gate marker (RULING 10-01, movies-13) ────────────────────────────

/** `metadata.approval_kind` value that marks a row as the live bug-fix authorization gate. */
export const BUG_FIX_AUTHORIZATION_MARKER = 'bug_fix_authorization' as const;

// THE ONE PREDICATE for "this approvals row is a bug-fix authorization gate", on ANY kind,
// is `isBugFixAuthorizationRow` in domain/engagement/deblock-actions.ts (fr#1333) — imported,
// never redefined (tests/unit/domain/web-only-single-definition.test.ts). Every U3 bug-fix
// site (mint, decide, approved-items) calls it and nothing else.

/**
 * THE MARKER IS MINTED THROUGH TWO DOORS ONLY, both a LICENCE caller (G5, George 2026-10-10;
 * the X-Webhook-Secret door is gone): POST /api/execution/approvals (ready-prefetch's
 * execution.ready_signoff; tenant-bound — the approval's tenant is pinned to the licence
 * tenant, and the report / bug card are read only within it) and webhooks card-approval —
 * both run `resolveBugFixAuthorizationMint`, which binds the marker to a real bug report in
 * the approval's tenant. Every other approvals door that spreads caller metadata onto the
 * row must refuse the marker outright; otherwise it mints a row every U3 reader treats as a
 * bug-fix gate with none of the report binding behind it. (The code name below predates
 * G5 and is kept for callers.)
 *   422 bug_fix_marker_not_allowed_here      POST /api/improvement/approvals (not a producer)
 *   422 bug_fix_marker_requires_secret_door  POST /api/execution/approvals via a Keycloak JWT
 */
export const BUG_FIX_MARKER_NOT_ALLOWED_HERE = 'bug_fix_marker_not_allowed_here' as const;
export const BUG_FIX_MARKER_REQUIRES_SECRET_DOOR = 'bug_fix_marker_requires_secret_door' as const;

export function assertNoBugFixMarker(
  metadata: unknown,
  code: typeof BUG_FIX_MARKER_NOT_ALLOWED_HERE | typeof BUG_FIX_MARKER_REQUIRES_SECRET_DOOR,
  door: string,
): void {
  if (!isBugFixAuthorizationRow({ metadata })) return;
  refuse(
    code,
    `metadata.approval_kind='${BUG_FIX_AUTHORIZATION_MARKER}' cannot be minted through ${door}; ` +
      'only a licence caller of POST /api/execution/approvals or webhooks card-approval mints a bug-fix authorization',
  );
}

/** The ONE kind whose approved, marked row authorises fixes (RULING a, 10-01). */
export const BUG_FIX_AUTHORISING_KIND = 'execution.ready_signoff' as const;

/**
 * Deblock actions that, APPROVED on a marked `generic` row, would mean "go on and fix the bugs".
 *
 * ⛔ EMPTY BY RULING (coordinator ruling a, 2026-10-01): ONLY an APPROVED, marked
 * `execution.ready_signoff` row (metadata.approval_kind='bug_fix_authorization') authorises
 * fixes. EVERY generic deblock action — RETRY included — authorises NOTHING: approved-items
 * returns 0 items and 409 `not_authorised_for_fix` with `details.deblock_action`. (Before the
 * ruling RETRY was treated as proceed; it is not: RETRY re-drives the decision card, it is not
 * a structured A1 sign-off.) Kept as a named exported constant so a future ruling changes it
 * here and nowhere else — and so the tests can pin that it stays empty.
 */
export const BUG_FIX_PROCEED_DEBLOCK_ACTIONS: readonly DeblockAction[] = [];

/**
 * Does a decision on a marked row AUTHORISE fixes? PURE.
 *   approved `execution.ready_signoff`  → yes (status-only; it carries no deblock_action)
 *   approved `generic`                  → only if its deblock_action is in
 *                                         BUG_FIX_PROCEED_DEBLOCK_ACTIONS — EMPTY, so never
 *   any other kind / any non-approved   → no (fail closed)
 */
export function bugFixDecisionAuthorises(input: {
  kind: string;
  status: string;
  deblockAction: unknown;
}): boolean {
  if (input.status !== 'approved') return false;
  if (input.kind === BUG_FIX_AUTHORISING_KIND) return true;
  if (input.kind !== 'generic') return false;
  const action = asDeblockAction(input.deblockAction);
  return action !== undefined && BUG_FIX_PROCEED_DEBLOCK_ACTIONS.includes(action);
}

// Compared as a STRING: `COVERAGE` joins DEBLOCK_ACTIONS in fr#1333, and this module
// must compile (and mean the same thing) on either side of that merge.
export const COVERAGE_DEBLOCK_ACTION = 'COVERAGE';
export const NO_COMPUTED_CHECK_CLASS = 'no_computed_check';
export const NO_COMPUTED_CHECK_PREFIX = 'no_computed_check:';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
// The ILS sink refuses NUL and every other Unicode Cc in any id field (aa-trace-endpoints.md
// "Common field rules") and bounds ids at 256 chars; an id it would refuse is refused HERE,
// at mint, where the producer can still fix it — not after a human has decided.
// eslint-disable-next-line no-control-regex
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f-\u009f]*$/;
const sinkId = z.string().min(1).max(256).regex(NO_CONTROL_CHARS, 'control characters are not allowed');

// ── §6.14 coverage request ──────────────────────────────────────────────────────────

export const COVERAGE_ARTIFACT_KINDS = ['test_report', 'ci_run', 'pr', 'log', 'screenshot'] as const;

const CoverageCriterionSchema = z
  .object({
    criterion_id: sinkId,
    text: z.string().min(1).max(8000),
    // Nullable by contract (§6.16: an AC may have no scenario). Normalised to null.
    scenario_id: sinkId.nullable().optional().transform((v) => v ?? null),
    scenario_gherkin: z.string().max(16000).nullable().optional(),
    // R3's frozen `qa_criteria_results[]` not_run record. Carried, not re-validated here:
    // its shape is R3's contract (R3-RESULT-SHAPE.md), and this gate's job is the request.
    computed: z.record(z.string(), z.unknown()).nullable().optional(),
    reason_not_computed: z.string().min(1).max(4000),
  })
  .strict();

const CoverageArtifactSchema = z
  .object({
    kind: z.enum(COVERAGE_ARTIFACT_KINDS),
    ref: z.string().min(1).max(2048),
    sha: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();

const count = z.number().int().nonnegative();

/**
 * Who produced the request (contract amendment with quality-rebuild-closeout, ncn#1969).
 *   absent | 'r3'  R3 qa-evaluate ran: the reviewed commit is known, so both SHAs are 40-hex
 *                  and `artifacts` is present (possibly []).
 *   'derived'      ncn's blocked-escalate DERIVED the request on the legacy QA path, where NO
 *                  computed check ran. EXACTLY:
 *                    - `qa_head_sha` / `commit_sha`: each ABSENT or null — the two are the same
 *                      thing and both are stored as null (so dedupe identity cannot tell them
 *                      apart either); any string → 422 derived_request_has_sha.
 *                    - `artifacts`: ABSENT or [] (stored as []); any entry → 422
 *                      derived_request_claims_computed — the decider UI shows artifacts as
 *                      evidence, and a derived request has none.
 *                    - every criterion's `computed`: EXACTLY {executed:false, outcome:'not_run'}
 *                      — no other key (no `result`, no `passed`) → else 422
 *                      derived_request_claims_computed.
 *                    - `test_summary`: all zero → else 422 derived_request_claims_computed.
 *                    - `pr_url`: ABSENT, null, or a valid url (stored as null when absent) —
 *                      a derived card often never opened a PR. r3 still requires the url.
 *                  A derived request can therefore never assert a pass.
 * The cross-field rules live in `coverageRequestViolation` (one source, used at mint AND by
 * the ac_coverage writeback re-read), not in this schema, so each breach keeps its own code.
 */
export const COVERAGE_REQUEST_SOURCES = ['r3', 'derived'] as const;
export type CoverageRequestSource = (typeof COVERAGE_REQUEST_SOURCES)[number];

export const CoverageRequestSchema = z
  .object({
    source: z.enum(COVERAGE_REQUEST_SOURCES).optional(),
    card_id: sinkId,
    card_type: sinkId,
    qa_head_sha: z.string().regex(HEX40, 'qa_head_sha must be 40 lowercase hex').nullable().optional(),
    // Nullable/optional at the SCHEMA only so a DERIVED request may carry no PR (blocked-escalate
    // derives coverage for cards that often never opened one, and sends `pr_url: null`). A string
    // is still a valid url ≤ 2048 for every source. An r3 request without one is refused by
    // `coverageRequestViolation` (coverage_request_invalid), exactly as before.
    pr_url: z.string().url().max(2048).nullable().optional(),
    commit_sha: z.string().regex(HEX40, 'commit_sha must be 40 lowercase hex').nullable().optional(),
    criteria: z
      .array(CoverageCriterionSchema)
      .min(1, 'criteria must be non-empty')
      .max(500)
      .superRefine((criteria, ctx) => {
        const seen = new Set<string>();
        criteria.forEach((c, i) => {
          if (seen.has(c.criterion_id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, 'criterion_id'],
              message: `duplicate criterion_id ${JSON.stringify(c.criterion_id)} — criterion_id is unique within a request`,
            });
          }
          seen.add(c.criterion_id);
        });
      }),
    // Optional at the SCHEMA only so a derived request may omit it; an r3 request without it
    // is refused by `coverageRequestViolation` (coverage_request_invalid), exactly as before.
    artifacts: z.array(CoverageArtifactSchema).max(200).optional(),
    test_summary: z.object({ passed: count, failed: count, skipped: count }).strict(),
  })
  .strict();
export type CoverageRequest = z.infer<typeof CoverageRequestSchema>;

/** The request's effective source: an absent `source` is R3's (the pre-amendment contract). */
export function coverageRequestSource(req: Pick<CoverageRequest, 'source'>): CoverageRequestSource {
  return req.source ?? 'r3';
}

/**
 * Is `computed` EXACTLY `{executed:false, outcome:'not_run'}`? Key-set equality, not a two-field
 * peek: `computed` is an open record, so `{executed:false, outcome:'not_run', result:'pass',
 * passed:true}` must NOT read as not-run. PURE.
 */
function isDerivedNotRun(computed: unknown): boolean {
  if (!computed || typeof computed !== 'object' || Array.isArray(computed)) return false;
  const keys = Object.keys(computed).sort();
  const c = computed as Record<string, unknown>;
  return keys.length === 2 && keys[0] === 'executed' && keys[1] === 'outcome' && c.executed === false && c.outcome === 'not_run';
}

/**
 * The source-dependent rules of a schema-valid request, or null when it satisfies them. PURE.
 *   r3 / absent  qa_head_sha AND commit_sha are 40-hex, `pr_url` is a url, and `artifacts` is
 *                present (null/absent → coverage_request_invalid, exactly as before the amendment).
 *   derived      both SHAs absent or null (derived_request_has_sha); `artifacts` absent or [],
 *                every criterion's `computed` has EXACTLY the keys {executed:false,
 *                outcome:'not_run'}, and test_summary is all zero (derived_request_claims_computed)
 *                — no computed claim and no evidence, so no forged pass.
 */
export function coverageRequestViolation(
  req: CoverageRequest,
): { code: string; message: string; details?: unknown } | null {
  if (coverageRequestSource(req) === 'r3') {
    const missing = (['qa_head_sha', 'commit_sha'] as const).filter((k) => typeof req[k] !== 'string');
    const details: Array<{ path: string; message: string }> = missing.map((k) => ({
      path: k,
      message: `${k} must be 40 lowercase hex (source r3)`,
    }));
    if (typeof req.pr_url !== 'string') details.push({ path: 'pr_url', message: 'pr_url is required (source r3)' });
    if (!Array.isArray(req.artifacts)) details.push({ path: 'artifacts', message: 'artifacts is required (source r3)' });
    if (details.length) {
      return { code: 'coverage_request_invalid', message: 'metadata.coverage_request does not match §6.14', details };
    }
    return null;
  }
  const withSha = (['qa_head_sha', 'commit_sha'] as const).filter((k) => req[k] !== null && req[k] !== undefined);
  if (withSha.length) {
    return {
      code: 'derived_request_has_sha',
      message: `a derived coverage_request names no reviewed commit: ${withSha.join(', ')} must be null`,
      details: withSha.map((k) => ({ path: k, message: 'must be null when source is derived' })),
    };
  }
  const claims = req.criteria
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !isDerivedNotRun(c.computed))
    .map(({ c, i }) => ({
      path: `criteria.${i}.computed`,
      message: `${c.criterion_id}: must be exactly {executed:false, outcome:'not_run'} (no other keys)`,
    }));
  if (req.artifacts !== undefined && req.artifacts.length > 0) {
    claims.push({ path: 'artifacts', message: 'must be absent or [] when source is derived (no evidence was produced)' });
  }
  const ts = req.test_summary;
  if (ts.passed !== 0 || ts.failed !== 0 || ts.skipped !== 0) {
    claims.push({ path: 'test_summary', message: 'must be {passed:0, failed:0, skipped:0} when source is derived' });
  }
  if (claims.length) {
    return {
      code: 'derived_request_claims_computed',
      message:
        'a derived coverage_request is a human sign-off on criteria NO computed check ran: every ' +
        "criterion must be computed exactly {executed:false, outcome:'not_run'}, artifacts absent or [], " +
        'and test_summary all zero',
      details: claims,
    };
  }
  return null;
}

// ── per-kind mint metadata ────────────────────────────────────────────────────────

const BugFixMintMetadataSchema = z.object({
  approval_kind: z.literal(BUG_FIX_AUTHORIZATION_MARKER),
  report_id: z.string().uuid(),
  report_hash: z.string().regex(HEX64, 'report_hash must be 64 lowercase hex (H_r)'),
  /** The bugs this gate asks a human to authorise: a non-empty, duplicate-free subset of the report's. */
  bug_ids: z
    .array(sinkId)
    .min(1, 'bug_ids must be non-empty')
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'bug_ids must not repeat'),
  /** The BUG card (bug_analysis) the report is about — not the decision card this row sits on. */
  bug_card_id: sinkId,
});
export type BugFixAuthorizationMetadata = z.infer<typeof BugFixMintMetadataSchema>;

const DesignScenarioSchema = z
  .object({
    scenario_id: sinkId,
    criterion_id: sinkId,
    title: z.string().min(1).max(1000),
    // null / whitespace-only hash as null (canonical-scenarios-hash v1 step 2).
    gherkin: z.string().max(16000).nullable().optional().transform((v) => v ?? null),
  })
  .strict();

const DesignMintMetadataSchema = z.object({
  design_artifact_id: sinkId,
  design_hash: z.string().regex(HEX64, 'design_hash must be 64 lowercase hex'),
  contract_hash: z.string().regex(HEX64, 'contract_hash must be 64 lowercase hex'),
  scenarios: z
    .array(DesignScenarioSchema)
    .min(1, 'scenarios must be non-empty')
    .max(500)
    .superRefine((scenarios, ctx) => {
      const seen = new Set<string>();
      scenarios.forEach((sc, i) => {
        if (seen.has(sc.scenario_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'scenario_id'],
            message: `duplicate scenario_id ${JSON.stringify(sc.scenario_id)}`,
          });
        }
        seen.add(sc.scenario_id);
      });
    }),
  /** movies-db canonical form, recomputed here (src/lib/scenarios-hash.ts). */
  scenarios_hash: z.string().regex(HEX64, 'scenarios_hash must be 64 lowercase hex'),
  // Declared so `.strict()` admits them; each is validated by its OWN parser below with its
  // own refusal code (write_set_* / handoff_contract_invalid / contract_hash_mismatch).
  write_set: z.unknown().optional(),
  handoff_contract: z.unknown().optional(),
  // fr COMPUTES these two; a sender's copy is admitted and IGNORED (overwritten by fr's value
  // under the same key — pinned by u3-a3-write-set.test.ts "a sender-supplied seal / a3 hash
  // is ignored"). Not a drop: the stored key exists, with the recomputed value.
  write_set_seal: z.unknown().optional(),
  a3_inputs_hash: z.unknown().optional(),
})
  // ⛔ STRICT (P2.3): the stored metadata is REBUILT from the keys above, so an undeclared
  // top-level key used to be SILENTLY DROPPED — a producer shipping `units` / `test_code`
  // beside the design got a 201 and lost them. Now it is a loud 422 design_metadata_invalid.
  // Producer census before the flip (fr / ncn workflows / n8n-nodes-*, origin/main
  // 2026-10-04): ZERO producers send kind execution.feature_design_approval.
  .strict();

export interface U3MintResult {
  kind: U3Kind;
  /** The ONLY keys this module adds to approvals.metadata — the typed per-kind output. */
  metadata: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function refuse(code: string, message: string, details?: unknown): never {
  throw new ValidationError(message, details).withCode(code);
}

function zodDetails(err: z.ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Merge Procedure Hint's field-source wrapper (ncn blocked-escalate), stripped once. */
const BLOCK_REASON_FIELD_WRAPPER = /^\s*(block reason: )?\s*/i;

/**
 * Derive whether a card-approval mint is the coverage sign-off. PURE.
 *
 * All three signals or none: deblock_action COVERAGE, block_reason_class
 * no_computed_check, and a block reason starting `no_computed_check:`. COVERAGE with
 * either of the other two missing is REFUSED rather than minted as a plain approval —
 * a coverage proposition that does not say which ACs had no computed check cannot be
 * decided per AC, and minting it generic would let a chat seat decide it.
 *
 * The block-reason text is `block_reason` when the producer sends it, else
 * `change_summary` — which is where `blocked-escalate :: Call FR` puts the raw block
 * reason today (`change_summary: $json.reason_raw`). ⚠️ That raw reason carries Merge
 * Procedure Hint's FIELD-SOURCE wrapper: `block reason: no_computed_check:<type>:<ids>`
 * (MEASURED: ncn@7b013764 §2e's real Call FR body; without this strip it was 422
 * coverage_derivation_incomplete). So ONE leading `block reason: ` is stripped first —
 * BLOCK_REASON_FIELD_WRAPPER above is the same pattern ncn Build Proposition strips
 * before its prefix map (`__r5Head`). A `comment reason: ` wrapper is NOT stripped: a comment-sourced prefix derives nothing,
 * on ncn's side and here.
 */
export function deriveCoverageSignoff(signals: {
  deblock_action?: unknown;
  block_reason_class?: unknown;
  block_reason?: unknown;
  change_summary?: unknown;
}): boolean {
  if (str(signals.deblock_action) !== COVERAGE_DEBLOCK_ACTION) return false;
  const cls = str(signals.block_reason_class)?.trim().toLowerCase();
  const reasonText = str(signals.block_reason) ?? str(signals.change_summary) ?? '';
  const hasPrefix = reasonText.replace(BLOCK_REASON_FIELD_WRAPPER, '').startsWith(NO_COMPUTED_CHECK_PREFIX);
  if (cls === NO_COMPUTED_CHECK_CLASS && hasPrefix) return true;
  refuse(
    'coverage_derivation_incomplete',
    `deblock_action COVERAGE needs block_reason_class "${NO_COMPUTED_CHECK_CLASS}" AND a block reason ` +
      `starting "${NO_COMPUTED_CHECK_PREFIX}" (got class ${JSON.stringify(cls ?? null)}, ` +
      `prefix ${hasPrefix ? 'present' : 'absent'}); a coverage proposition must say which ACs had no computed check`,
  );
}

/** Strict §6.14 validation of a coverage request. Inline only; a ref is refused. PURE. */
export function parseCoverageRequest(metadata: unknown, cardId: string): CoverageRequest {
  const m = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  if ('coverage_request_ref' in m) {
    refuse(
      'coverage_request_ref_refused',
      'metadata.coverage_request_ref is refused: the coverage request is taken INLINE only ' +
        '(one source, no fetch-time race). Send metadata.coverage_request.',
    );
  }
  if (m.coverage_request === undefined) {
    refuse('coverage_request_required', 'qa.coverage_signoff requires metadata.coverage_request (§6.14)');
  }
  const rawReq = m.coverage_request;
  if (
    rawReq &&
    typeof rawReq === 'object' &&
    'source' in rawReq &&
    !(COVERAGE_REQUEST_SOURCES as readonly unknown[]).includes((rawReq as Record<string, unknown>).source)
  ) {
    refuse(
      'coverage_request_source_invalid',
      `metadata.coverage_request.source ${JSON.stringify((rawReq as Record<string, unknown>).source)} is not one of: ` +
        `absent, ${COVERAGE_REQUEST_SOURCES.map((x) => `'${x}'`).join(', ')}`,
    );
  }
  const parsed = CoverageRequestSchema.safeParse(rawReq);
  if (!parsed.success) {
    refuse('coverage_request_invalid', 'metadata.coverage_request does not match §6.14', zodDetails(parsed.error));
  }
  const violation = coverageRequestViolation(parsed.data);
  if (violation) refuse(violation.code, violation.message, violation.details);
  if (parsed.data.card_id !== cardId) {
    refuse(
      'coverage_request_card_mismatch',
      `metadata.coverage_request.card_id ${JSON.stringify(parsed.data.card_id)} is not this approval's card ${JSON.stringify(cardId)}`,
    );
  }
  // ONE stored form. An absent SHA and a null SHA mean the same thing on a derived request
  // (and an absent artifacts list the same as []), so both are stored the same way — otherwise
  // the dedupe identity (u3Identity compares qa_head_sha/commit_sha with ===) would treat a
  // retry that omits the keys as a DIFFERENT artefact from one that sends null. An r3 request
  // reaching here already carries both SHAs and artifacts (coverageRequestViolation).
  return {
    ...parsed.data,
    qa_head_sha: parsed.data.qa_head_sha ?? null,
    commit_sha: parsed.data.commit_sha ?? null,
    pr_url: parsed.data.pr_url ?? null,
    artifacts: parsed.data.artifacts ?? [],
  };
}

// ── coverage sign-off is minted through ONE door ─────────────────────────────────────

/**
 * `qa.coverage_signoff` is minted ONLY by webhooks card-approval, where `resolveU3Mint` runs
 * `parseCoverageRequest`. The two other approvals doors that spread caller metadata onto the
 * row — POST /api/execution/approvals (both doors) and POST /api/improvement/approvals — mint
 * `execution.ready_signoff` / `improvement.*` and cannot mint the coverage kind. Yet the
 * decide path (`classifyCoverageDecision`, deblock-actions.ts) keys a per-criterion verdict on
 * the STORED `metadata.deblock_action === 'COVERAGE'`, not on the kind, and reads its criteria
 * off `metadata.coverage_request` unvalidated. So a COVERAGE action or a coverage request on
 * those doors would mint a sign-off nobody validated. Refused there, loudly (422), before any
 * read — no live producer sends either (ncn origin/main: ready-prefetch sends QUESTION only;
 * prod fr: 0 COVERAGE rows and 0 coverage_request rows in the 30 days to 2026-10-02).
 */
export const COVERAGE_SIGNOFF_NOT_MINTABLE_HERE = 'coverage_signoff_not_mintable_here' as const;

export function assertNoCoverageSignoff(metadata: unknown, door: string): void {
  const m = (metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}) as Record<string, unknown>;
  const offending = [
    ...(m.deblock_action === COVERAGE_DEBLOCK_ACTION ? [`deblock_action=${COVERAGE_DEBLOCK_ACTION}`] : []),
    ...(['coverage_request', 'coverage_request_ref'] as const).filter((k) => k in m),
  ];
  if (!offending.length) return;
  refuse(
    COVERAGE_SIGNOFF_NOT_MINTABLE_HERE,
    `metadata ${offending.join(', ')} cannot be minted through ${door}: a coverage sign-off ` +
      `(${COVERAGE_SIGNOFF_KIND}) is minted only by POST /api/webhooks/n8n/card-approval, which validates it (§6.14)`,
    { fields: offending },
  );
}

/**
 * THE MINT HOOK. Called once from `handleN8nCardApproval`, after the tenant resolves and
 * before any dedupe or insert, so a malformed U3 request is always refused (422/409) and
 * never minted, deduplicated onto an existing row, or silently stripped.
 *
 * Returns null when the request is none of the U3 kinds (the route is then unchanged).
 */
export async function resolveU3Mint(
  input: { rawBody: unknown; cardId: string; tenantId: string; improvementKind?: string | null },
  executor: Pick<typeof defaultDb, 'select'> = defaultDb,
): Promise<U3MintResult | null> {
  const body = (input.rawBody && typeof input.rawBody === 'object' ? input.rawBody : {}) as Record<string, unknown>;
  const metadata = body.metadata;
  const metaObj = (metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : undefined) as Record<string, unknown> | undefined;

  let sentKind: (typeof U3_SENDABLE_KINDS)[number] | undefined;
  if (body.kind !== undefined) {
    if (body.kind === COVERAGE_SIGNOFF_KIND) {
      refuse(
        'u3_kind_not_sendable',
        `kind "${COVERAGE_SIGNOFF_KIND}" is never sent: fr derives it from deblock_action COVERAGE + ` +
          `block_reason_class ${NO_COMPUTED_CHECK_CLASS}`,
      );
    }
    if (!(U3_SENDABLE_KINDS as readonly unknown[]).includes(body.kind)) {
      refuse(
        'u3_kind_not_sendable',
        `kind ${JSON.stringify(body.kind)} is not sendable on this route; allowed: ${U3_SENDABLE_KINDS.join(', ')}`,
      );
    }
    sentKind = body.kind as (typeof U3_SENDABLE_KINDS)[number];
  }

  const coverage = deriveCoverageSignoff(body);
  if (!coverage && metaObj && ('coverage_request' in metaObj || 'coverage_request_ref' in metaObj)) {
    refuse(
      'coverage_request_without_coverage_kind',
      'metadata.coverage_request is only accepted on a coverage sign-off (deblock_action COVERAGE + ' +
        `block_reason_class ${NO_COMPUTED_CHECK_CLASS}); it would otherwise be stored on an approval nobody decides per AC`,
    );
  }
  if (coverage && sentKind) {
    refuse('u3_kind_conflict', `kind ${sentKind} conflicts with a derived ${COVERAGE_SIGNOFF_KIND}`);
  }
  const kind: U3Kind | undefined = coverage ? COVERAGE_SIGNOFF_KIND : sentKind;
  if (!kind) return null;
  if (isBugFixAuthorizationRow({ metadata: metaObj })) {
    refuse('u3_kind_conflict', `kind ${kind} cannot carry the ${BUG_FIX_AUTHORIZATION_MARKER} marker`);
  }

  assertU3NotImprovement({ kind }, input.improvementKind);

  if (kind === COVERAGE_SIGNOFF_KIND) {
    const coverageRequest = parseCoverageRequest(metaObj, input.cardId);
    // `coverage_request_source` is persisted top-level so a human sign-off on criteria no
    // computed check ran ('derived') is distinguishable from R3's request without a jsonb dig.
    return {
      kind,
      metadata: { coverage_request: coverageRequest, coverage_request_source: coverageRequestSource(coverageRequest) },
    };
  }

  if (kind === QUESTION_KIND) {
    return { kind, metadata: parseQuestionMint(body, metaObj) };
  }

  const parsed = DesignMintMetadataSchema.safeParse(metaObj ?? {});
  if (!parsed.success) {
    refuse(
      'design_metadata_invalid',
      `${kind} requires metadata {design_artifact_id, design_hash, contract_hash, scenarios[], scenarios_hash}`,
      zodDetails(parsed.error),
    );
  }
  const recomputed = scenariosHash(parsed.data.scenarios);
  if (recomputed !== parsed.data.scenarios_hash) {
    refuse(
      'scenarios_hash_mismatch',
      `metadata.scenarios_hash is not the canonical hash of metadata.scenarios (recomputed ${recomputed})`,
    );
  }
  // ── THE WRITE SET (FROZEN WRITE_SET CONTRACT, U4-diff-scope-recon.md) ──────────────
  // REQUIRED on every A3 mint, validated by THE one path predicate (write-set-paths.ts,
  // imported unchanged), stored EXACTLY as sent (never re-sorted: the seal is over the bytes
  // the human approves), sealed, and the seal folded into A3's inputs_hash. Fail-closed at
  // MINT with 422 — an invalid request body, not a state conflict (the helper's own 409 is
  // for a STORED set read back wrong).
  const writeSet = parseWriteSetForMint(metaObj?.write_set);
  const seal = writeSetSeal(writeSet);
  // P2.3 — the handoff.v2 contract. OPTIONAL (existing producers omit it); when present it must
  // be fully valid AND sealed by contract_hash, and is stored VERBATIM (the raw value, not the
  // zod output) so a reader recomputes the same hash from what it reads back.
  const handoffContract = parseHandoffContractForMint(metaObj, parsed.data.contract_hash);
  if (handoffContract !== undefined) {
    assertContractMatchesDesign(handoffContract, parsed.data.design_hash, writeSet, input.cardId);
  }
  return {
    kind,
    metadata: {
      scenarios_hash: recomputed,
      design_artifact_id: parsed.data.design_artifact_id,
      design_hash: parsed.data.design_hash,
      contract_hash: parsed.data.contract_hash,
      scenarios: parsed.data.scenarios,
      write_set: writeSet,
      write_set_seal: seal,
      a3_inputs_hash: a3InputsHash(parsed.data.design_hash, seal),
      ...(handoffContract !== undefined ? { handoff_contract: handoffContract } : {}),
    },
  };
}

/**
 * metadata.handoff_contract for an A3 MINT. Absent ⇒ undefined (the row is byte-identical to
 * before). Present ⇒ strict handoff.v2 shape (422 handoff_contract_invalid) and
 * contract_hash === handoffContractHash(it) (422 contract_hash_mismatch). Returns a deep copy
 * of the RAW value — verbatim, never re-built from the parse.
 */
function parseHandoffContractForMint(
  metaObj: Record<string, unknown> | undefined,
  contractHash: string,
): Record<string, unknown> | undefined {
  if (!metaObj || !('handoff_contract' in metaObj) || metaObj.handoff_contract === undefined) return undefined;
  const raw = metaObj.handoff_contract;
  const parsed = HandoffContractSchema.safeParse(raw);
  if (!parsed.success) {
    refuse(
      'handoff_contract_invalid',
      `metadata.handoff_contract is not a valid ${HANDOFF_CONTRACT_VERSION} contract`,
      zodDetails(parsed.error),
    );
  }
  const computed = handoffContractHash(raw as Record<string, unknown>);
  if (computed !== contractHash) {
    refuse(
      'contract_hash_mismatch',
      'metadata.contract_hash is not sha256(canonicalizeJcs(metadata.handoff_contract minus design_approval_id)) ' +
        `(recomputed ${computed})`,
      { recomputed: computed },
    );
  }
  return structuredClone(raw) as Record<string, unknown>;
}

/**
 * P2.3 cross-checks between a VALIDATED, hash-sealed handoff_contract and the A3 metadata the
 * human approves beside it (rulings 2026-10-04):
 *   1. handoff_contract.design_hash === metadata.design_hash, else 422
 *      contract_design_hash_mismatch — the contract must decompose THIS design.
 *   2. set(metadata.write_set) === ∪ units[].scope.target_files ∪ units[].acceptance_tests[].path,
 *      else 422 contract_write_set_mismatch. The U4 fence enforces write_set: a contract path
 *      missing from it fences the unit out; an extra write_set path means the human-approved
 *      scope is wider than the contract. Compared as SETS of exact strings — the write-set
 *      contract's only canonical form (write-set-paths.ts: exact string equality, never
 *      normalised; the contract's paths are already refused unless canonical). The seal is
 *      still computed over write_set exactly as sent (unchanged above).
 *   3. handoff_contract.design_card_id === the card this A3 is minted on (`input.cardId`, the
 *      webhook's card_id, stored as approvals.card_id), else 422 contract_design_card_mismatch.
 *      The mint parents every unit card under design_card_id and linkParentChild writes that
 *      card's child_cards unchecked, so a contract naming another card would let a human-approved
 *      A3 hang dev cards under ANY card. The mint route re-checks it (409 design_card_mismatch).
 */
function assertContractMatchesDesign(
  contract: Record<string, unknown>,
  designHash: string,
  writeSet: readonly string[],
  cardId: string,
): void {
  if (contract.design_hash !== designHash) {
    refuse(
      'contract_design_hash_mismatch',
      'metadata.handoff_contract.design_hash does not equal metadata.design_hash',
      { contract_design_hash: contract.design_hash, design_hash: designHash },
    );
  }
  const units = contract.units as Array<{
    scope: { target_files: string[] };
    acceptance_tests: Array<{ path: string }>;
  }>;
  const contractPaths = new Set<string>();
  for (const u of units) {
    for (const f of u.scope.target_files) contractPaths.add(f);
    for (const t of u.acceptance_tests) contractPaths.add(t.path);
  }
  const ws = new Set(writeSet);
  const missing = [...contractPaths].filter((p) => !ws.has(p)).sort(compareBytes);
  const extra = [...ws].filter((p) => !contractPaths.has(p)).sort(compareBytes);
  if (missing.length || extra.length) {
    refuse(
      'contract_write_set_mismatch',
      'metadata.write_set must equal the handoff_contract units\' target_files ∪ acceptance_tests[].path ' +
        `(${missing.length} missing from write_set, ${extra.length} not in the contract)`,
      { missing_from_write_set: missing, not_in_contract: extra },
    );
  }
  if (contract.design_card_id !== cardId) {
    refuse(
      'contract_design_card_mismatch',
      'metadata.handoff_contract.design_card_id is not the card this approval is minted on',
      { contract_design_card_id: contract.design_card_id, card_id: cardId },
    );
  }
}

/**
 * A3's inputs_hash with the write-set seal FOLDED IN (seal contract: "stored at
 * metadata.write_set_seal, AND folded into A3's inputs_hash (both, deliberately)"; formula
 * accepted by movies-ab 2026-10-02):
 *   sha256_hex(RFC8785({ "v": 1, "design_hash": <design_hash>, "write_set_seal": <seal> }))
 * The A3 decision must carry exactly this as g12_decision.inputs_hash, so a decision is bound to
 * the design AND the set of paths it authorises. R10 recomputes it from the collected
 * design_hash + write_set (pinned vectors: tests/unit/services/approvals/g12-row.vectors.json).
 */
export function a3InputsHash(designHash: string, seal: string): string {
  return createHash('sha256')
    .update(canonicalizeJcs({ v: 1, design_hash: designHash, write_set_seal: seal }), 'utf8')
    .digest('hex');
}

/** The A3 write set, validated for MINT: any defect is 422 with the contract's code. */
function parseWriteSetForMint(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((p) => typeof p === 'string')) {
    refuse('write_set_invalid', 'metadata.write_set is required: a non-empty, byte-sorted array of exact repo-relative paths');
  }
  try {
    assertWriteSetPaths(v as string[]);
  } catch (err) {
    if (err instanceof WriteSetPathsError) refuse(err.pathsCode, err.detail);
    throw err;
  }
  return [...(v as string[])];
}

/**
 * G-12 A6 — the QUESTION mint (arbiter ruling, movies-ab 2026-10-02; G-12 v2 §2 A6 governs):
 *   question_id Q1–Q8         → minted, stamped
 *   question_id absent / null → minted (not covered by §3) — decidable ONLY as reject
 *                               `no_registered_answer` (one M4 intervention)
 *   anything else             → 422 question_id_invalid, nothing minted
 * fr never maps the TEXT to an id. It stamps the exact text's sha256 (the A6 inputs_hash) and
 * the rule version the registry belongs to.
 */
function parseQuestionMint(body: Record<string, unknown>, metaObj: Record<string, unknown> | undefined) {
  const m = metaObj ?? {};
  const rawId = m.question_id;
  if (rawId !== undefined && rawId !== null && !isQuestionId(rawId)) {
    refuse(
      'question_id_invalid',
      `metadata.question_id ${JSON.stringify(rawId)} is not a registered G-12 §3 id (Q1..Q8), and not absent/null`,
      // Echoed so the conveyor can block the card with `question_id_invalid:<value>` verbatim.
      { value: rawId },
    );
  }
  const text = m.question_text;
  if (typeof text !== 'string' || text.trim() === '' || text.length > 4000) {
    refuse('question_metadata_invalid', 'metadata.question_text is required: the exact question, 1..4000 characters');
  }
  if (asDeblockAction(body.deblock_action) !== 'QUESTION') {
    refuse('question_metadata_invalid', `${QUESTION_KIND} must be minted with deblock_action QUESTION`);
  }
  const open = body.open_questions;
  if (!Array.isArray(open) || open.length !== 1 || open[0] !== text) {
    refuse(
      'question_metadata_invalid',
      'open_questions must hold exactly one entry, identical to metadata.question_text (one approval, one question)',
    );
  }
  // The conveyor's classifier version (movies-13 condition for the ncn half): which ruleset
  // mapped this question's text to its question_id. Optional, stored verbatim so the
  // classification is auditable on the fr side; fr never interprets it.
  const ruleVersion = m.question_rule_version;
  if (
    ruleVersion !== undefined &&
    ruleVersion !== null &&
    (typeof ruleVersion !== 'string' || ruleVersion.trim() === '' || ruleVersion.length > 128 || !NO_CONTROL_CHARS.test(ruleVersion))
  ) {
    refuse('question_metadata_invalid', 'metadata.question_rule_version, when sent, is a 1..128 character string');
  }
  const rule = latestG12Rule();
  if (!rule) throw new AppError(500, 'no G-12 rule is registered');
  return {
    ...(typeof ruleVersion === 'string' ? { question_rule_version: ruleVersion } : {}),
    question_id: isQuestionId(rawId) ? rawId : null,
    question_text: text as string,
    question_text_sha256: createHash('sha256').update(text as string, 'utf8').digest('hex'),
    g12_rule_version: rule.rule_version,
  };
}

/**
 * THE BUG-FIX MINT HOOK — one call per mint route (execution-approvals.ts for the
 * ready-prefetch execution.ready_signoff row; webhooks.ts card-approval for the
 * blocked-escalate generic deblock row), after the tenant resolves and before the dedupe
 * and the insert, so a malformed marked row is refused and never minted.
 *
 * Returns null for an UNMARKED row (the route is then unchanged). For a marked row it
 * returns the typed metadata to spread LAST onto the insert, or throws:
 *   422 bug_fix_authorization_metadata_invalid  report_id / report_hash / bug_ids[] / bug_card_id missing or malformed
 *   409 report_not_found / report_hash_mismatch / report_not_before_now  (assertReportBeforeApproval, tenant-scoped)
 *   422 report_not_bug_report / 409 report_card_mismatch  the report is not the BUG card's bug_report
 *   422 report_has_no_bugs   ZERO-BUG RULING
 *   422 bug_ids_not_in_report  bug_ids ⊄ the report's bug ids
 */
export async function resolveBugFixAuthorizationMint(
  input: { metadata: unknown; tenantId: string },
  executor: Pick<typeof defaultDb, 'select'> = defaultDb,
): Promise<BugFixAuthorizationMetadata | null> {
  if (!isBugFixAuthorizationRow({ metadata: input.metadata })) return null;
  const parsed = BugFixMintMetadataSchema.safeParse(input.metadata);
  if (!parsed.success) {
    refuse(
      'bug_fix_authorization_metadata_invalid',
      `a ${BUG_FIX_AUTHORIZATION_MARKER} approval requires metadata {report_id, report_hash, bug_ids[], bug_card_id}`,
      zodDetails(parsed.error),
    );
  }
  const m = parsed.data;
  // A report in ANOTHER tenant reads as not found — the tenant is the approval's resolved tenant.
  await assertReportBeforeApproval(executor, { tenant_id: input.tenantId, report_id: m.report_id, report_hash: m.report_hash });
  // The approval sits on the DECISION card; the report is about the BUG card ncn names.
  const reportBugIds = await assertReportBindsToCard(executor, {
    tenantId: input.tenantId,
    reportId: m.report_id,
    cardId: m.bug_card_id,
  });
  const known = new Set(reportBugIds);
  const unknown = m.bug_ids.filter((id) => !known.has(id));
  if (unknown.length) {
    refuse('bug_ids_not_in_report', `bug_ids must be a subset of report ${m.report_id}'s bugs`, { unknown });
  }
  return {
    approval_kind: BUG_FIX_AUTHORIZATION_MARKER,
    report_id: m.report_id,
    report_hash: m.report_hash,
    bug_ids: m.bug_ids,
    bug_card_id: m.bug_card_id,
  };
}

/**
 * REPORT ↔ CARD BINDING (bug_fix mint). `assertReportBeforeApproval` proves the cited
 * report exists in the tenant with that H_r; it does NOT prove the report is a BUG report
 * or that it is about THIS card. Without this check an approval on card X could cite —
 * and, once approved, release fixes for — the bug report of card Y (or a status report
 * that happens to carry a content_hash). Same tenant predicate as the hash check.
 *   422 report_not_bug_report  the cited report's report_type is not 'bug_report'
 *   409 report_card_mismatch   the cited report's card_id is not the approval's card_id
 */
export async function assertReportBindsToCard(
  executor: Pick<typeof defaultDb, 'select'>,
  args: { tenantId: string; reportId: string; cardId: string },
): Promise<string[]> {
  const [report] = await executor
    .select({ card_id: projectReports.card_id, report_type: projectReports.report_type, details: projectReports.details })
    .from(projectReports)
    .where(and(eq(projectReports.id, args.reportId), eq(projectReports.tenant_id, args.tenantId)))
    .limit(1);
  if (!report) conflict('report_not_found', `report ${args.reportId} not found`);
  if (report.report_type !== 'bug_report') {
    refuse(
      'report_not_bug_report',
      `report ${args.reportId} is a ${JSON.stringify(report.report_type)} report; a bug-fix authorization must cite a bug_report`,
    );
  }
  if (report.card_id !== args.cardId) {
    conflict(
      'report_card_mismatch',
      `report ${args.reportId} belongs to card ${JSON.stringify(report.card_id)}, not this approval's card ${JSON.stringify(args.cardId)}`,
    );
  }
  // ZERO-BUG RULING (movies-13; U1 concurs): a zero-bug hunt persists its report with
  // bugs:[] and raises NO approval. Fail closed here too — a bug_fix approval citing a
  // report with nothing to fix would be decided on zero items (G-12 gives the decider no
  // item to approve, so it could only ever be "rejected", and the P1.7 minter would read an
  // approval with no approved items). A missing or non-array `bugs` is treated the same:
  // a bug_fix gate needs at least one cited bug.
  const bugs = (report.details as { bugs?: unknown } | null)?.bugs;
  if (!Array.isArray(bugs) || bugs.length === 0) {
    refuse(
      'report_has_no_bugs',
      `report ${args.reportId} lists no bugs; a zero-bug hunt raises no approval (ZERO-BUG RULING)`,
    );
  }
  return (bugs as Array<{ id?: unknown }>).map((b) => String(b?.id));
}

/**
 * sha256 of the canonical criteria of a coverage request: `[{criterion_id, scenario_id}]`
 * sorted by criterion_id (unique within a request), scenario_id normalised to null,
 * serialised with fixed key order. PURE. Two requests at the same SHAs over a different
 * criteria set (an AC added, dropped, or re-bound to another scenario) hash differently.
 */
export function coverageCriteriaHash(criteria: unknown): string | undefined {
  if (!Array.isArray(criteria)) return undefined;
  const canon = criteria
    .map((c) => {
      const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      return { criterion_id: String(o.criterion_id ?? ''), scenario_id: o.scenario_id == null ? null : String(o.scenario_id) };
    })
    .sort((a, b) => (a.criterion_id < b.criterion_id ? -1 : a.criterion_id > b.criterion_id ? 1 : 0))
    .map((c) => ({ criterion_id: c.criterion_id, scenario_id: c.scenario_id }));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/** The fields that identify WHAT a U3 gate asks a human to decide, per kind. */
function u3Identity(kind: string, metadata: unknown): Record<string, unknown> {
  const m = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  if (kind === FEATURE_DESIGN_APPROVAL_KIND) {
    return {
      design_artifact_id: m.design_artifact_id,
      design_hash: m.design_hash,
      scenarios_hash: m.scenarios_hash,
      write_set_seal: m.write_set_seal,
    };
  }
  if (kind === QUESTION_KIND) {
    return { question_id: m.question_id ?? null, question_text_sha256: m.question_text_sha256 };
  }
  const req = (m.coverage_request && typeof m.coverage_request === 'object' ? m.coverage_request : {}) as Record<
    string,
    unknown
  >;
  return {
    qa_head_sha: req.qa_head_sha,
    commit_sha: req.commit_sha,
    card_type: req.card_type,
    criteria_hash: coverageCriteriaHash(req.criteria),
  };
}

/**
 * ONE CARD, ONE OPEN GATE — the U3 exception to "return the existing row".
 *
 * `handleN8nCardApproval` answers a second mint on a card that already holds an open gate
 * with that gate and `deduplicated: true`. For a U3 mint that is only honest when the open
 * gate asks the SAME question: same kind AND the same artefact (report hash / design +
 * scenarios hash / reviewed commit + card_type + the criteria set, by hash). Otherwise the caller would be told its bug report (or
 * design) is awaiting a decision while the human is in fact deciding something else, and
 * the eventual decision would be read back as a decision on the wrong artefact.
 *   409 open_gate_conflict — the open gate is a different kind or a different artefact.
 * Same kind + same artefact may still dedupe. PURE.
 */
export function assertU3DedupeCompatible(
  u3: U3MintResult | null,
  existing: { id: string; kind: string; metadata: unknown },
): void {
  // ⛔ BOTH DIRECTIONS (movies-f1 finding, 2026-10-03, verified on ffdb8abc). This returned
  // early for every non-U3 mint, so a kind-less QUESTION mint (blocked-escalate's shape) landing
  // on a card whose open gate is an `execution.question` / `execution.feature_design_approval` /
  // `qa.coverage_signoff` was answered `deduplicated: true` with the G-12 gate's id — the caller
  // believed its generic question was pending while the human was deciding a structured one.
  // A G-12 gate is only ever deduped onto by a mint of the SAME kind and identity.
  if (!u3) {
    if ((G12_GATE_KINDS as readonly string[]).includes(existing.kind)) {
      dedupeConflict(
        existing,
        `card already holds open ${existing.kind} approval ${existing.id}; a mint of another kind cannot be ` +
          'deduplicated onto a G-12 gate',
      );
    }
    return;
  }
  if (existing.kind !== u3.kind) {
    dedupeConflict(
      existing,
      `card already holds open approval ${existing.id} of kind ${existing.kind}; a ${u3.kind} cannot be ` +
        'deduplicated onto a gate that asks a different question',
    );
  }
  const want = u3Identity(u3.kind, u3.metadata);
  const have = u3Identity(existing.kind, existing.metadata);
  const differs = Object.keys(want).filter((k) => want[k] !== have[k]);
  if (differs.length) {
    dedupeConflict(
      existing,
      `card already holds open ${u3.kind} approval ${existing.id} for a different artefact (${differs.join(', ')} differ)`,
    );
  }
  // P2.3 ruling 4: contract_hash is NOT part of the A3 identity (the identity is unchanged), but
  // a re-mint of the SAME design under a DIFFERENT contract must not fold onto the open gate —
  // it would answer deduplicated:true while silently keeping the OLD contract. Same hash folds.
  if (u3.kind === FEATURE_DESIGN_APPROVAL_KIND) {
    const wantHash = (u3.metadata as Record<string, unknown>).contract_hash;
    const em = (existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}) as Record<
      string,
      unknown
    >;
    if (wantHash !== em.contract_hash) {
      throw new AppError(
        409,
        `card already holds open ${u3.kind} approval ${existing.id} for the same design under a different ` +
          'contract_hash; decide or void it before minting a new contract',
        { existing_approval_id: existing.id, existing_kind: existing.kind, existing_contract_hash: em.contract_hash ?? null },
      ).withCode('contract_conflicts_open_approval');
    }
  }
}

/** 409 open_gate_conflict with the SAME details every other door's open_gate_conflict carries
 * (bug-fix-uniqueness.ts openGateConflict): which gate holds the card, and of what kind. */
function dedupeConflict(existing: { id: string; kind: string }, message: string): never {
  throw new AppError(409, message, { existing_approval_id: existing.id, existing_kind: existing.kind }).withCode(
    'open_gate_conflict',
  );
}

/**
 * A U3 kind — or a bug_fix_authorization marked row, whose kind must stay generic — never
 * rides an improvement-stream board (whose kind is derived from the stream).
 */
export function assertU3NotImprovement(u3: { kind: string } | null, improvementKind?: string | null): void {
  if (u3 && improvementKind) {
    refuse(
      'u3_kind_conflict',
      `kind ${u3.kind} cannot be minted on an improvement-stream board (derived kind ${improvementKind})`,
    );
  }
}

// ── decide side (bug-fix marker + design only) ──────────────────────────────────────

const G12ItemSchema = z
  .object({
    item_id: sinkId,
    decision: z.enum(['approve', 'reject']),
    reason_code: z.string().min(1).max(200),
    // G-12 evidence. A nested contract location lives HERE, never in the code
    // (movies-09 ruling): `contract_mismatch:args` + mismatch_path "args.limit.type".
    predicate_inputs: z
      .object({ mismatch_path: z.string().min(1).max(1024).regex(NO_CONTROL_CHARS) })
      .strict()
      .optional(),
  })
  .strict();

const G12DecisionSchema = z
  .object({
    rule_row: z.string().min(1).max(16),
    rule_version: z.string().regex(HEX64, 'rule_version is the sha256 of the signed rule file'),
    /** The hash of the artefact the decider reviewed: report_hash (A1) / design_hash (A3). */
    inputs_hash: z.string().regex(HEX64),
    /**
     * Per-item codes. Required for A3 (one item = the design). Optional for A1: a bug with no
     * item takes `real_bug_ok` when approved and `reject_reason_code` when rejected.
     */
    items: z.array(G12ItemSchema).max(500).optional(),
    /** A1 only: the reject code for every rejected bug that has no explicit item. */
    reject_reason_code: z.string().min(1).max(200).optional(),
  })
  .strict();

/** A1 only: the bugs the decider REJECTS; ⊆ metadata.bug_ids. Omitted ⇒ none on approve, all on reject. */
const RejectedBugIdsSchema = z
  .array(sinkId)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, 'rejected_bug_ids must not repeat');

/** What lands in `approval_decisions.item_decisions` (migration 153). */
export interface U3ItemDecisions {
  rule_row: string;
  rule_version: string;
  inputs_hash: string;
  /** A1 only: the resolved rejected set (every metadata.bug_id not in it is approved). */
  rejected_bug_ids?: string[];
  /**
   * A3 only: the HONEST kind of whoever decided — `decidedByKindFor(deciderId)` ('human' /
   * 'agent' / 'triage_agent'). fr does not restrict who may decide (George 2026-10-31:
   * telegram/web/mcp are equivalent; the responder is the responder, human or agent).
   */
  decider_kind?: ReturnType<typeof decidedByKindFor>;
  items: Array<{
    item_id: string;
    decision: G12ItemDecision;
    reason_code: string;
    predicate_inputs?: { mismatch_path: string };
  }>;
}

function conflict(code: string, message: string): never {
  throw new AppError(409, message).withCode(code);
}

type DecideInput = {
  approval: { id: string; tenant_id: string; kind: string; metadata: unknown };
  rawBody: unknown;
  status: 'approved' | 'rejected';
  /**
   * The user id of the decider (a human's Keycloak sub or an agent member's version-8 UUID).
   * Only A3 reads it, to stamp the honest `decider_kind`; it gates nothing.
   */
  deciderId: string | null;
};

/** Shared G-12 parsing: structured decision present, active rule, the row governing `governs`, no free text. */
function parseG12Decision(body: Record<string, unknown>, governs: string, label: string) {
  if (body.g12_decision === undefined) {
    refuse(
      'g12_decision_required',
      `a ${label} decision must carry a structured g12_decision {rule_row, rule_version, inputs_hash, items[]}`,
    );
  }
  const parsed = G12DecisionSchema.safeParse(body.g12_decision);
  if (!parsed.success) {
    refuse('g12_decision_invalid', 'g12_decision is malformed', zodDetails(parsed.error));
  }
  const d = parsed.data;
  const rule = g12RuleFor(d.rule_version);
  if (!rule) {
    refuse('g12_rule_version_unregistered', `rule_version ${d.rule_version} is not a registered G-12 rule`);
  }
  const rowKey = g12RowKeyFor(rule, governs);
  if (!rowKey || rowKey !== d.rule_row) {
    refuse(
      'g12_rule_row_mismatch',
      `rule_row ${JSON.stringify(d.rule_row)} does not govern ${label} (expected ${rowKey ?? 'none'})`,
    );
  }
  const row = rule.rows[rowKey]!;
  // The closed set is looked up by (rule_version, rule_row) — never by row alone.
  const codes = g12CodesFor(d.rule_version, rowKey)!;
  const allCodes = new Set<string>([...codes.approve, ...codes.reject]);

  // Free text is limited to the reason code (G-12 §1.4). A comment / reason that is not
  // one of this row's codes is steering text, and it never goes back into the conveyor.
  for (const field of ['comment', 'reason'] as const) {
    const v = body[field];
    if (typeof v === 'string' && v.trim() !== '' && !allCodes.has(v.trim())) {
      refuse('free_text_refused', `${field} must be empty or one of the ${rowKey} reason codes; free text is refused on ${label}`);
    }
  }

  const items = d.items ?? [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.item_id)) refuse('items_mismatch', `duplicate item_id ${JSON.stringify(item.item_id)}`);
    seen.add(item.item_id);
    if (!codes[item.decision].includes(item.reason_code)) {
      refuse(
        'reason_code_not_in_rule',
        `reason_code ${JSON.stringify(item.reason_code)} is not a ${rowKey} "${item.decision}" code ` +
          `under rule_version ${d.rule_version} (allowed: ${codes[item.decision].join(', ')})`,
      );
    }
    if (item.predicate_inputs && !item.reason_code.startsWith('contract_mismatch:')) {
      refuse('predicate_inputs_unexpected', 'predicate_inputs.mismatch_path is evidence for a contract_mismatch:* code only');
    }
  }
  return { d, rowKey, row, codes, items, seen };
}

function toItemDecisions(
  d: z.infer<typeof G12DecisionSchema>,
  items: z.infer<typeof G12ItemSchema>[],
  extra: Partial<U3ItemDecisions> = {},
): U3ItemDecisions {
  return {
    rule_row: d.rule_row,
    rule_version: d.rule_version,
    inputs_hash: d.inputs_hash,
    ...extra,
    items: items.map((i) => ({
      item_id: i.item_id,
      decision: i.decision,
      reason_code: i.reason_code,
      ...(i.predicate_inputs ? { predicate_inputs: { mismatch_path: i.predicate_inputs.mismatch_path } } : {}),
    })),
  };
}

/**
 * THE DECIDE HOOK. Called once from `handleUpdateApproval`, immediately before the
 * `approval_decisions` insert, so a refusal writes nothing.
 *
 * Returns null for every row it does not gate (unmarked generic / ready_signoff rows, and
 * `qa.coverage_signoff`, whose decide side is fr#1333's). For a gated row it returns the
 * structured decision to persist, or throws:
 *   422 g12_decision_required / g12_decision_invalid / g12_rule_version_unregistered /
 *       g12_rule_row_mismatch / reason_code_not_in_rule / free_text_refused / items_mismatch /
 *       decision_items_inconsistent / rejected_bug_ids_invalid / rejected_bug_ids_not_subset /
 *       reject_reason_code_required
 *   409 report_* (assertReportBeforeApproval) / inputs_hash_mismatch
 */
export async function assertU3DecideGates(
  input: DecideInput,
  executor: Pick<typeof defaultDb, 'select'> = defaultDb,
): Promise<U3ItemDecisions | null> {
  if (isBugFixAuthorizationRow(input.approval)) return assertBugFixAuthorizationDecide(input, executor);
  if (!U3_DECIDE_GATED_KINDS.includes(input.approval.kind)) return null;

  const { approval } = input;
  const body = (input.rawBody && typeof input.rawBody === 'object' ? input.rawBody : {}) as Record<string, unknown>;
  if (approval.kind === QUESTION_KIND) return assertQuestionDecide(input, body);
  // Defence in depth beside routes/approvals.ts: an A3 decision takes no decider-supplied action.
  if (body.deblock_action !== undefined && body.deblock_action !== null) {
    refuse('deblock_action_not_allowed', `${approval.kind} takes no decider-supplied deblock_action`);
  }
  const { d, row, items, seen } = parseG12Decision(body, approval.kind, approval.kind);
  if (d.reject_reason_code !== undefined) {
    refuse('g12_decision_invalid', 'reject_reason_code is an A1 (bug-fix) field; A3 decides each item explicitly');
  }
  const meta = (approval.metadata && typeof approval.metadata === 'object' ? approval.metadata : {}) as Record<string, unknown>;
  const designHash = str(meta.design_hash);
  const designId = str(meta.design_artifact_id);
  if (!designHash || !designId) conflict('design_not_cited', `approval ${approval.id} cites no design artefact`);
  const expected = assertSealedA3(approval.id, meta, designHash);
  if (d.inputs_hash !== expected) {
    conflict(
      'inputs_hash_mismatch',
      'inputs_hash is not this approval\'s a3_inputs_hash (design_hash with the write-set seal folded in)',
    );
  }
  // Every item decided, none invented: G-12 gives EACH item exactly one outcome.
  const missing = seen.has(designId) ? [] : [designId];
  const extra = [...seen].filter((id) => id !== designId);
  if (missing.length || extra.length) {
    refuse('items_mismatch', `items must decide exactly the ${row.item}s of this approval`, { missing, extra });
  }
  // The approval's own status must follow from its items: approved iff ≥1 item approved.
  const implied = items.some((i) => i.decision === 'approve') ? 'approved' : 'rejected';
  if (implied !== input.status) {
    refuse('decision_items_inconsistent', `status ${input.status} contradicts the item decisions (which imply ${implied})`);
  }
  // decider_kind: the stored record of WHO decided (human or agent) — recorded, never gated.
  return toItemDecisions(d, items, { decider_kind: decidedByKindFor(input.deciderId) });
}

/**
 * Re-check the A3 seal at DECIDE (defence in depth beside the U4 read route's own re-seal): the
 * stored write_set must still be a valid set that recomputes to the stored seal, and the stored
 * a3_inputs_hash must still be the fold of design_hash + that seal. Any drift ⇒ 409
 * write_set_seal_mismatch, nothing recorded. Returns the inputs_hash a decision must carry.
 */
function assertSealedA3(approvalId: string, meta: Record<string, unknown>, designHash: string): string {
  const ws = meta.write_set;
  const seal = str(meta.write_set_seal);
  const stored = str(meta.a3_inputs_hash);
  if (!Array.isArray(ws) || !seal || !stored) {
    conflict('write_set_missing', `approval ${approvalId} carries no sealed write_set; it cannot be decided`);
  }
  try {
    assertWriteSetPaths(ws as string[]);
  } catch (err) {
    if (err instanceof WriteSetPathsError) conflict('write_set_seal_mismatch', `stored write_set is invalid: ${err.detail}`);
    throw err;
  }
  if (writeSetSeal(ws as string[]) !== seal || a3InputsHash(designHash, seal) !== stored) {
    conflict('write_set_seal_mismatch', `approval ${approvalId}'s write_set no longer recomputes to its seal`);
  }
  return stored;
}

/**
 * G-12 A6 decide (arbiter ruling 2026-10-02). One item: the stamped question_id, or the literal
 * `no_registered_answer` when none was stamped. inputs_hash = question_text_sha256.
 *   stamped Q1–Q7 → approve `answered:<that id>`, or reject `no_registered_answer`
 *   stamped Q8 / none → reject `no_registered_answer` only
 * An approve whose code names ANOTHER id is refused: the decision must agree with the stamp
 * (the only thing R10 can check about A6).
 */
function assertQuestionDecide(input: DecideInput, body: Record<string, unknown>): U3ItemDecisions {
  const { approval } = input;
  // Defence in depth beside routes/approvals.ts: no decider-supplied action on A6, ever.
  if (body.deblock_action !== undefined && body.deblock_action !== null && body.deblock_action !== 'QUESTION') {
    refuse('deblock_action_not_allowed', `${QUESTION_KIND} takes no decider-supplied deblock_action`);
  }
  const { d, items, seen } = parseG12Decision(body, approval.kind, approval.kind);
  if (d.reject_reason_code !== undefined) {
    refuse('g12_decision_invalid', 'reject_reason_code is an A1 (bug-fix) field; A6 decides its one item explicitly');
  }
  const meta = (approval.metadata && typeof approval.metadata === 'object' ? approval.metadata : {}) as Record<string, unknown>;
  const textHash = str(meta.question_text_sha256);
  if (!textHash) conflict('question_not_cited', `approval ${approval.id} carries no question_text_sha256`);
  if (d.inputs_hash !== textHash) {
    conflict('inputs_hash_mismatch', 'inputs_hash is not the question_text_sha256 this approval was minted with');
  }
  const stamped = isQuestionId(meta.question_id) ? meta.question_id : null;
  const itemId = stamped ?? NO_REGISTERED_ANSWER;
  const missing = seen.has(itemId) ? [] : [itemId];
  const extra = [...seen].filter((id) => id !== itemId);
  if (missing.length || extra.length) {
    refuse('items_mismatch', 'items must decide exactly this approval\'s one question', { missing, extra });
  }
  const item = items[0]!;
  if (item.decision === 'approve') {
    if (!stamped || !QUESTION_REGISTRY[stamped].answerable) {
      refuse(
        'question_not_answerable',
        `this question is ${stamped ?? 'not covered by §3'}: the only allowed decision is reject ${NO_REGISTERED_ANSWER}`,
      );
    }
    if (item.reason_code !== answeredCode(stamped)) {
      refuse('reason_code_not_stamped', `approve must carry ${answeredCode(stamped)}, the stamped question_id`);
    }
  }
  const implied = item.decision === 'approve' ? 'approved' : 'rejected';
  if (implied !== input.status) {
    refuse('decision_items_inconsistent', `status ${input.status} contradicts the item decision (which implies ${implied})`);
  }
  return toItemDecisions(d, items);
}

/**
 * The decision TEXT an approved A6 records: the REGISTERED answer for the stamped id, so the
 * QUESTION callback to n8n carries a pre-registered answer and never free text (G-12 §0/§1.4).
 * Null for every other row, and for a rejected or unanswerable question.
 */
export function a6RegisteredAnswerFor(
  approval: { kind: string; metadata: unknown },
  status: 'approved' | 'rejected',
): string | null {
  if (approval.kind !== QUESTION_KIND) return null;
  // A rejected A6 has exactly one possible meaning; record that code, never a decider string
  // (a valid A6 code such as `answered:Q3` passes the free-text rule and would otherwise be
  // forwarded to n8n as the "answer" on a rejected question).
  if (status === 'rejected') return NO_REGISTERED_ANSWER;
  const meta = (approval.metadata && typeof approval.metadata === 'object' ? approval.metadata : {}) as Record<string, unknown>;
  const id = meta.question_id;
  if (!isQuestionId(id) || !QUESTION_REGISTRY[id as QuestionId].answerable) return null;
  return QUESTION_REGISTRY[id as QuestionId].answer;
}

// ── chat APPROVE-ALL (USER RULING 2026-10-02) ───────────────────────────────────────

/**
 * The rule a chat-seat approve-all is stamped with: the LAST registered G-12 rule (v2
 * supersedes v1 for new decisions, g12-rule.ts §7.3). Never a guess — derived from the
 * registry, and refused when the registry has no row governing this approval.
 */
function latestG12Rule() {
  return G12_RULES[G12_RULES.length - 1];
}

export const CHAT_APPROVE_ALL_NOT_AVAILABLE = 'chat_approve_all_not_available' as const;

/**
 * USER RULING 2026-10-02: the Telegram seat may APPROVE-ALL a bug-fix authorization (A1) or a
 * feature-design approval (A3) — see `chatSeatMayApproveAll` in deblock-actions.ts. This builds
 * the raw decide body the web would send for "approve everything", so the chat reply goes
 * through THE SAME `assertU3DecideGates` (status 'approved') — nothing here bypasses a gate:
 *   A1  `{ g12_decision: {rule_version, rule_row, inputs_hash: metadata.report_hash} }` — no
 *       rejected_bug_ids and no items, so the gate's own default applies (every cited bug
 *       approved with the row's first approve code). The report is still re-checked by the gate.
 *   A3  `{ g12_decision: {rule_version, rule_row, inputs_hash: metadata.design_hash,
 *       items: [{item_id: metadata.design_artifact_id, decision:'approve', reason_code}]}}`.
 * rule_row is `g12RowKeyFor(rule, governs)` (governs = the marker for A1, the kind for A3);
 * reason_code is that row's FIRST approve code under the stamped rule_version.
 *
 * Refuses (422 chat_approve_all_not_available) rather than guessing when the row is neither
 * A1 nor A3, when no registered rule governs it, when the hash/item it must attest is absent,
 * or when an approval of this row AUTHORISES NO FIX (a marked `generic` row — ruling a,
 * 10-01: approving it rejects every bug and needs a reject code a chat reply cannot carry).
 */
export async function buildChatApproveAllG12Body(approval: DecideInput['approval']): Promise<Record<string, unknown>> {
  const rule = latestG12Rule();
  const meta = (approval.metadata && typeof approval.metadata === 'object' && !Array.isArray(approval.metadata)
    ? approval.metadata
    : {}) as Record<string, unknown>;

  const isA1 = isBugFixAuthorizationRow(approval);
  if (!isA1 && approval.kind !== FEATURE_DESIGN_APPROVAL_KIND) {
    refuse(CHAT_APPROVE_ALL_NOT_AVAILABLE, `approval ${approval.id} (${approval.kind}) is not a chat approve-all row`);
  }
  // `governs` exactly as the gate computes it: the marker for a marked row
  // (assertBugFixAuthorizationDecide → parseG12Decision(body, BUG_FIX_AUTHORIZATION_MARKER)),
  // else the approval's own kind (assertU3DecideGates → parseG12Decision(body, approval.kind)).
  // rule_row then comes from the SAME resolver, g12RowKeyFor — never a hardcoded row key.
  const governs = isA1 ? BUG_FIX_AUTHORIZATION_MARKER : approval.kind;
  const rowKey = rule ? g12RowKeyFor(rule, governs) : undefined;
  const codes = rule && rowKey ? g12CodesFor(rule.rule_version, rowKey) : undefined;
  const approveCode = codes?.approve[0];
  if (!rule || !rowKey || !approveCode) {
    refuse(CHAT_APPROVE_ALL_NOT_AVAILABLE, `no registered G-12 rule governs ${governs} with an approve code`);
  }

  if (isA1) {
    if (!bugFixDecisionAuthorises({ kind: approval.kind, status: 'approved', deblockAction: meta.deblock_action })) {
      refuse(
        CHAT_APPROVE_ALL_NOT_AVAILABLE,
        `approving ${approval.kind} approval ${approval.id} authorises no bug fix (ruling a, 10-01); decide it in fr`,
      );
    }
    const reportHash = str(meta.report_hash);
    if (!reportHash) refuse(CHAT_APPROVE_ALL_NOT_AVAILABLE, `approval ${approval.id} cites no report_hash`);
    return { g12_decision: { rule_version: rule.rule_version, rule_row: rowKey, inputs_hash: reportHash } };
  }

  const designHash = str(meta.design_hash);
  const designId = str(meta.design_artifact_id);
  if (!designHash || !designId) {
    refuse(CHAT_APPROVE_ALL_NOT_AVAILABLE, `approval ${approval.id} cites no design artefact (design_artifact_id + design_hash)`);
  }
  // The same inputs_hash the web decision must carry: design_hash with the write-set seal folded
  // in, re-checked against the stored write_set (409 write_set_missing / write_set_seal_mismatch
  // surface as the chat refusal, nothing recorded).
  const inputsHash = assertSealedA3(approval.id, meta, designHash);
  return {
    g12_decision: {
      rule_version: rule.rule_version,
      rule_row: rowKey,
      inputs_hash: inputsHash,
      items: [{ item_id: designId, decision: 'approve', reason_code: approveCode }],
    },
  };
}

/**
 * The G-12 fields the WEB decide surface must stamp on an A1 decision, served read-only on
 * GET /api/approvals/:id as `g12_decide` so the browser never re-spells a rule_version (the
 * sha256 of the signed rule file) or a reason code. Same derivation as
 * `buildChatApproveAllG12Body`: the LAST registered rule, `g12RowKeyFor(rule, marker)`,
 * inputs_hash = metadata.report_hash. `reject_codes` is that row's closed reject set — the
 * only values `reject_reason_code` (and a rejecting decision's `reason`) may carry.
 *
 * Only for a marked `execution.ready_signoff` row: the one kind whose approve AUTHORISES
 * fixes (bugFixDecisionAuthorises, RULING a 10-01), i.e. the only row where a per-bug
 * reject picker changes the outcome. null for every other row, so their GET is unchanged.
 */
export interface WebA1DecideTemplate {
  rule_version: string;
  rule_row: string;
  inputs_hash: string;
  reject_codes: string[];
}

export function webA1DecideTemplate(approval: { kind: string; metadata: unknown }): WebA1DecideTemplate | null {
  if (approval.kind !== BUG_FIX_AUTHORISING_KIND || !isBugFixAuthorizationRow(approval)) return null;
  const meta = approval.metadata as Record<string, unknown>;
  const reportHash = str(meta.report_hash);
  const rule = latestG12Rule();
  const rowKey = rule ? g12RowKeyFor(rule, BUG_FIX_AUTHORIZATION_MARKER) : undefined;
  const codes = rule && rowKey ? g12CodesFor(rule.rule_version, rowKey) : undefined;
  if (!reportHash || !rule || !rowKey || !codes) return null;
  return { rule_version: rule.rule_version, rule_row: rowKey, inputs_hash: reportHash, reject_codes: [...codes.reject] };
}

/**
 * The G-12 fields the WEB decide surface must stamp on an A3 (`execution.feature_design_approval`)
 * decision, served read-only on GET /api/approvals/:id as `g12_decide_a3`. Same derivation as the
 * A3 half of `buildChatApproveAllG12Body`: the LAST registered rule, `g12RowKeyFor(rule, kind)`,
 * item_id = metadata.design_artifact_id, and inputs_hash = the SEALED a3_inputs_hash
 * (`assertSealedA3`: design_hash with the write-set seal folded in) — NOT the bare design_hash,
 * which `assertU3DecideGates` answers 409 inputs_hash_mismatch.
 *
 * null (nothing served, so the browser cannot build a decision) when the row is not an A3, when
 * no registered rule governs it, when design_artifact_id / design_hash are absent, or when the
 * stored write_set no longer recomputes to its seal — every case the decide gate would refuse.
 */
export interface WebA3DecideTemplate {
  rule_version: string;
  rule_row: string;
  inputs_hash: string;
  item_id: string;
  approve_codes: string[];
  reject_codes: string[];
}

export function webA3DecideTemplate(approval: { id: string; kind: string; metadata: unknown }): WebA3DecideTemplate | null {
  if (approval.kind !== FEATURE_DESIGN_APPROVAL_KIND) return null;
  const meta = (approval.metadata && typeof approval.metadata === 'object' && !Array.isArray(approval.metadata)
    ? approval.metadata
    : {}) as Record<string, unknown>;
  const designHash = str(meta.design_hash);
  const designId = str(meta.design_artifact_id);
  const rule = latestG12Rule();
  const rowKey = rule ? g12RowKeyFor(rule, approval.kind) : undefined;
  const codes = rule && rowKey ? g12CodesFor(rule.rule_version, rowKey) : undefined;
  if (!designHash || !designId || !rule || !rowKey || !codes || codes.approve.length === 0) return null;
  let inputsHash: string;
  try {
    inputsHash = assertSealedA3(approval.id, meta, designHash);
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
  return {
    rule_version: rule.rule_version,
    rule_row: rowKey,
    inputs_hash: inputsHash,
    item_id: designId,
    approve_codes: [...codes.approve],
    reject_codes: [...codes.reject],
  };
}

/**
 * A1 on a MARKED row (generic deblock or execution.ready_signoff). The per-bug outcome is
 * `rejected_bug_ids[]` ⊆ metadata.bug_ids — omitted ⇒ none rejected when the decision
 * authorises fixes, all rejected when it does not. "Authorises" is bugFixDecisionAuthorises:
 * approved AND (ready_signoff, or a generic row whose effective deblock_action is a proceed
 * action). So an approved DROP is a decision that rejects every bug, and saying otherwise
 * (a rejected_bug_ids that leaves a bug approved) is 422 decision_items_inconsistent.
 */
async function assertBugFixAuthorizationDecide(
  input: DecideInput,
  executor: Pick<typeof defaultDb, 'select'>,
): Promise<U3ItemDecisions> {
  const { approval } = input;
  const body = (input.rawBody && typeof input.rawBody === 'object' ? input.rawBody : {}) as Record<string, unknown>;
  const label = `${BUG_FIX_AUTHORIZATION_MARKER} (${approval.kind})`;
  const { d, codes, items, seen } = parseG12Decision(body, BUG_FIX_AUTHORIZATION_MARKER, label);

  const meta = (approval.metadata && typeof approval.metadata === 'object' ? approval.metadata : {}) as Record<string, unknown>;
  const reportId = str(meta.report_id);
  const reportHash = str(meta.report_hash);
  const bugIds = Array.isArray(meta.bug_ids) ? meta.bug_ids.filter((x): x is string => typeof x === 'string') : [];
  if (!reportId || !reportHash) conflict('report_not_found', `approval ${approval.id} cites no report`);
  if (bugIds.length === 0) conflict('approval_items_missing', `approval ${approval.id} cites no bug_ids`);
  // Re-check at decide: the report must still be there, in THIS tenant, with this H_r.
  await assertReportBeforeApproval(executor, { tenant_id: approval.tenant_id, report_id: reportId, report_hash: reportHash });
  if (d.inputs_hash !== reportHash) {
    conflict('inputs_hash_mismatch', 'inputs_hash is not the report_hash this approval cites');
  }

  const authorises = bugFixDecisionAuthorises({
    kind: approval.kind,
    status: input.status,
    deblockAction: body.deblock_action ?? meta.deblock_action,
  });

  let rejected: Set<string>;
  if (body.rejected_bug_ids !== undefined) {
    const r = RejectedBugIdsSchema.safeParse(body.rejected_bug_ids);
    if (!r.success) refuse('rejected_bug_ids_invalid', 'rejected_bug_ids is malformed', zodDetails(r.error));
    const known = new Set(bugIds);
    const unknown = r.data.filter((id) => !known.has(id));
    if (unknown.length) {
      refuse('rejected_bug_ids_not_subset', 'rejected_bug_ids must be a subset of this approval\'s bug_ids', { unknown });
    }
    rejected = new Set(r.data);
  } else {
    rejected = authorises ? new Set() : new Set(bugIds);
  }
  // The decision's meaning must follow from the per-bug outcome: it authorises fixes iff
  // ≥1 bug stays approved.
  const someApproved = bugIds.some((id) => !rejected.has(id));
  if (someApproved !== authorises) {
    refuse(
      'decision_items_inconsistent',
      authorises
        ? `rejected_bug_ids rejects every bug, but the decision (${input.status}) authorises fixes`
        : `the decision (${input.status}${approval.kind === 'generic' ? `, deblock_action ${String(body.deblock_action ?? meta.deblock_action ?? 'none')}` : ''}) authorises no fix, so every bug is rejected`,
    );
  }

  const extra = [...seen].filter((id) => !bugIds.includes(id));
  if (extra.length) refuse('items_mismatch', 'items may only decide this approval\'s bug_ids', { missing: [], extra });
  const byId = new Map(items.map((i) => [i.item_id, i]));
  if (d.reject_reason_code !== undefined && !codes.reject.includes(d.reject_reason_code)) {
    refuse('reason_code_not_in_rule', `reject_reason_code ${JSON.stringify(d.reject_reason_code)} is not an A1 reject code (allowed: ${codes.reject.join(', ')})`);
  }
  const resolved = bugIds.map((id) => {
    const decision: G12ItemDecision = rejected.has(id) ? 'reject' : 'approve';
    const explicit = byId.get(id);
    if (explicit) {
      if (explicit.decision !== decision) {
        refuse('decision_items_inconsistent', `item ${id} says ${explicit.decision} but rejected_bug_ids makes it ${decision}`);
      }
      return explicit;
    }
    if (decision === 'approve') return { item_id: id, decision, reason_code: codes.approve[0]! };
    if (d.reject_reason_code === undefined) {
      refuse('reject_reason_code_required', `rejected bug ${id} needs a G-12 A1 reject code (an item, or reject_reason_code)`);
    }
    return { item_id: id, decision, reason_code: d.reject_reason_code };
  });
  return toItemDecisions(d, resolved, { rejected_bug_ids: bugIds.filter((id) => rejected.has(id)) });
}
