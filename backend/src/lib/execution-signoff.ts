// src/lib/execution-signoff.ts
//
// Resolves the `execution_signoff` stakeholder roster persisted at project
// creation (project_stakeholders, role 'execution_signoff'). That roster is the
// authoritative answer to "who must sign off" when a card hits the AA
// ready-prefetch policy gate: n8n moves the card to BLOCKED and POSTs
// /api/execution/approvals, where fr resolves the roster and 422s if it is
// empty (routes/execution-approvals.ts) — and because the n8n POST node runs
// with onError:continueRegularOutput, that 422 is swallowed and the card is
// stranded in BLOCKED forever. So a gate-eligible project (a feature-project
// whose decomposition produces a `decision_development` card under the armed
// AA_APPROVAL_POLICY) MUST have at least one approver seeded.
//
// This helper makes the roster non-empty by default: it keeps an explicit
// approver roster verbatim, and falls back to the project owner only when no
// concrete approver was supplied. Pure: zero I/O, no side effects.
//
// It also owns the two things that decide whether an approval is minted at all:
// the gate-failure taxonomy (SIGNOFF_BLOCK_REASONS) and `isFixtureOrigin` — the
// predicate that refuses to ask a human to sign off on integration-test traffic.

import { isValidUuid } from '../utils/tenant';

// ---------------------------------------------------------------------------
// Gate-failure taxonomy
// ---------------------------------------------------------------------------
//
// The three ways POST /api/execution/approvals can refuse to create an
// approval for a card n8n has ALREADY parked in BLOCKED. Each is a permanent
// configuration defect, not a transient error: retrying changes nothing, and
// the card stays in BLOCKED until a human fixes the configuration.
//
// These strings are the contract in two directions at once:
//   * the `code` field on the error response body, so a caller can branch on
//     the cause instead of pattern-matching an English message; and
//   * `execution_signoff_blocks.reason_code` (migration 098), so the failure
//     survives a caller that ignores the response entirely — which is the
//     actual production situation.
//
// Keep the two in step: adding a member here means the route must record it
// and the stranded-cards view must be able to explain it.
export const SIGNOFF_BLOCK_REASONS = {
  /** No fr.projects row for the supplied project_id / planka_board_id. */
  PROJECT_NOT_FOUND: 'signoff_project_not_found',
  /** fr#1499: the project resolved but is ARCHIVED. An approval on it would be
   *  invisible (the approvals project lane hides archived projects), so the
   *  request is refused with 409 `project_archived` and nothing is minted. */
  PROJECT_ARCHIVED: 'signoff_project_archived',
  /** Project resolved, but no department→workspace link and no
   *  project_data.keycloak_tenant_id — nothing to scope the approval to. */
  PROJECT_UNTENANTED: 'signoff_project_untenanted',
  /** fr#1451: the target resolved, but the card, `metadata.boardId`, or a resume
   *  list (`doingListId` / `todoListId`) is not on the target's board — or the
   *  board could not be resolved at all (fail closed). The decision callback
   *  would move a card it does not own, so nothing is minted (422). */
  TARGET_OFF_BOARD: 'signoff_target_off_board',
  /** Project + tenant resolved, but project_stakeholders has no
   *  role='execution_signoff' row — nobody can ever grant this approval. */
  NO_APPROVERS: 'signoff_no_approvers',
  /**
   * A roster EXISTS — `project_stakeholders` names one or more
   * role='execution_signoff' users — but not one of them is reachable on a push
   * channel, and the tenant ladder (workspace-admin → project owner →
   * APPROVAL_FALLBACK_APPROVER_USER_ID) could not produce one either.
   *
   * ⚠️ DELIBERATELY DISTINCT FROM `NO_APPROVERS`. The two look identical from the
   * card's point of view (nobody can grant this) and need OPPOSITE remedies: an
   * empty roster needs a stakeholder seeded, an unreachable roster already HAS its
   * human and needs that human given a channel. Collapsing them sends the operator
   * to seed a second stakeholder who will be just as unreachable as the first.
   *
   * MEASURED 2026-08-29, and the reason this exists: 172 of the 177
   * `execution_signoff` stakeholder rows name `22560966-…`, the exec-operator,
   * whose ONLY channel is `inapp` — passive, so you receive it only if you are
   * already looking at the thing that is asking. Its approvals: 27 expired, 4
   * pending, and 42 `inapp` deliveries marked `sent` that produced zero answers.
   * The remaining 5 name `32969c16-…`, who has no `user_channel_prefs` row at all.
   */
  NO_REACHABLE_APPROVER: 'signoff_no_reachable_approver',
  /**
   * The originating work is FIXTURE traffic — an integration-test driver, not a
   * human's project — so no approval is minted at all.
   *
   * ⚠️ THE ODD ONE OUT. The three above are configuration DEFECTS: a human must
   * fix something before the card can move. This one is a deliberate REFUSAL and
   * the correct steady-state outcome; nothing is broken and nobody should be
   * paged. That is why `listOpenSignoffBlocks` filters it out
   * (services/execution-signoff-blocks.ts) — suppressed is not stranded — while
   * still writing the row, so "how much synthetic traffic did we refuse" stays
   * answerable.
   *
   * MEASURED 2026-08-25, and the reason this exists: fr's human approval queue
   * held 11 pending + 347 expired sign-offs, and EVERY ONE of the 11 pending was
   * test-fixture traffic — 10 descending from the Planka project "IT Flow1 —
   * bump fastmcp to 3.4.7", 1 from board `smoke-test-2026-05-01`. IT Flow1 is a
   * live-fire integration test that cycles a dependency BACKWARDS through
   * versions within minutes; it alone accounts for 129 fixture projects, 402
   * cards, and 37% of all BLOCKED cards. Over the trailing 48h, BLOCKED arrivals
   * were 7 fixture / 0 real. A human was being asked, daily, to sign off on
   * synthetic traffic — which is how a real sign-off request gets ignored.
   *
   * It escapes the pre-existing `_test` suppression STRUCTURALLY, not by
   * accident: `_test` is a per-invocation flag on a WEBHOOK payload, and the
   * IT Flow1 driver never calls a webhook — it POSTs `fr /api/projects`, so the
   * whole run happens on the real path where no `_test` key exists to carry.
   * The marker therefore has to live on the PROJECT (see isFixtureOrigin below).
   */
  FIXTURE_ORIGIN: 'signoff_fixture_origin',
} as const;

export type SignoffBlockReason =
  (typeof SIGNOFF_BLOCK_REASONS)[keyof typeof SIGNOFF_BLOCK_REASONS];

/**
 * What an operator has to DO about each reason. Carried on the stranded-cards
 * view so the answer to "this card can never be released" arrives with its own
 * remedy rather than requiring someone to re-derive it.
 */
export const SIGNOFF_BLOCK_REMEDIES: Record<SignoffBlockReason, string> = {
  [SIGNOFF_BLOCK_REASONS.PROJECT_NOT_FOUND]:
    'No fr project owns this Planka board. Either register the board on the ' +
    'owning project (projects.planka_board_id) or take the board out of the ' +
    'approval policy — the cards on it can never be signed off as-is.',
  [SIGNOFF_BLOCK_REASONS.PROJECT_ARCHIVED]:
    'The project this card belongs to is ARCHIVED, and archive is one-way. The ' +
    'producer is still stamping an archived project id: repoint it (e.g. the n8n ' +
    'CONVEYOR_PROJECT_ID_* / CONVEYOR_IMPROVEMENT_PROJECT_ID_* config) at the live ' +
    'project and re-run the card — an approval on an archived project would be invisible.',
  [SIGNOFF_BLOCK_REASONS.PROJECT_UNTENANTED]:
    'The project has no department→workspace link and no ' +
    'project_data.keycloak_tenant_id. Set one; an approval cannot be ' +
    'tenant-scoped without it.',
  [SIGNOFF_BLOCK_REASONS.TARGET_OFF_BOARD]:
    "The sign-off request named a card, metadata.boardId or resume list that is " +
    "not on the resolved project's / stream's Planka board (or the board has no " +
    'planka_board_id, or Planka could not be reached to check). Fix the producer so ' +
    'the ids come from the card\'s own board, or register the board on the owning ' +
    'project, and re-run the card.',
  [SIGNOFF_BLOCK_REASONS.NO_APPROVERS]:
    "Seed at least one project_stakeholders row with role='execution_signoff' " +
    'for this project (resolveSignoffStakeholderIds does this at project ' +
    'creation; pre-existing projects were never backfilled).',
  [SIGNOFF_BLOCK_REASONS.NO_REACHABLE_APPROVER]:
    'The sign-off roster names someone who cannot be told. Give one of the named ' +
    "approvers an ENABLED push channel (telegram/email/teams/voice/mcp) under " +
    '/api/me/channels — `inapp` and `websocket` do not count, they are passive and ' +
    'only reach someone already looking at fr. Alternatively reassign the ' +
    "role='execution_signoff' stakeholder to a reachable human, or set " +
    'APPROVAL_FALLBACK_APPROVER_USER_ID to one. Do NOT "fix" this by adding a ' +
    'second unreachable stakeholder.',
  [SIGNOFF_BLOCK_REASONS.FIXTURE_ORIGIN]:
    'Nothing to do — this is the control working. The card belongs to ' +
    'integration-test traffic (an allowlisted project_data.requestor, an ' +
    'explicit project_data.fixture:true, or an FR_FIXTURE_BOARD_IDS board), so ' +
    'no human sign-off was minted. If a REAL project landed here, its requestor ' +
    'is wrongly listed in FR_FIXTURE_REQUESTORS (or its board in ' +
    'FR_FIXTURE_BOARD_IDS) — remove it there; do not widen the match.',
};

// ---------------------------------------------------------------------------
// Fixture-origin predicate
// ---------------------------------------------------------------------------
//
// ⛔ EXACT STRING EQUALITY ONLY, against an enumerated allowlist. Never a
// substring match, a regex, or ANY pattern over the project NAME. A sibling
// effort measured a 1.5% false-positive rate on a name-regex classifier, and
// the false positive was a SECURITY card. The asymmetry is the whole design:
// letting a fixture through costs one ignorable approval, whereas suppressing a
// real security sign-off silently removes a human control. When in doubt this
// predicate must answer FALSE.
//
// Env-read at CALL time rather than through `config.ts`:
//   * `config` is a module-load `as const` snapshot, so a value frozen there
//     cannot be overridden by a test (or corrected by an operator) without a
//     process restart — and this list is exactly the knob someone will need to
//     narrow in a hurry if it ever over-matches; and
//   * `config.ts` would have to import these defaults from here, while the
//     predicate would import `config` from there — a cycle.
// That is an established shape here, not a new one: `routes/me/licenses.ts:42`
// reads FR_LICENSE_APP_KEYS per call for the same test-override reason. The
// parse itself (split/trim/drop-empties) is copied verbatim from
// `config.ts parseAudiences`, this codebase's convention for an optional
// comma-separated env list.

/**
 * The integration-test drivers that POST `fr /api/projects` on the real path.
 * Verbatim `project_data.requestor` values — these are script filenames the
 * drivers set for themselves, not human names, so an exact match is safe.
 * Override wholesale with `FR_FIXTURE_REQUESTORS` (comma-separated).
 */
export const DEFAULT_FIXTURE_REQUESTORS: readonly string[] = [
  'drive-it-flow1-demo.sh',
  'drive-cve-sweep.sh',
  'smoke-stage5.sh',
  'smoke-stage5-improvement.sh',
];

/** split/trim/drop-empties — mirrors config.ts parseAudiences. */
function parseCsvEnv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

/** The active requestor allowlist: `FR_FIXTURE_REQUESTORS` or the defaults. */
export function resolveFixtureRequestors(): readonly string[] {
  return parseCsvEnv(process.env.FR_FIXTURE_REQUESTORS) ?? DEFAULT_FIXTURE_REQUESTORS;
}

/**
 * Exact Planka board ids to treat as fixture origin, from `FR_FIXTURE_BOARD_IDS`.
 *
 * ⚠️ HONEST GAP, stated rather than approximated. A stream-backed board carries
 * NO fixture marker of any kind: `streams` (db/schema.ts:1273-1320) has only
 * kind / slug / is_active / tenant, and there is no project row and therefore no
 * `project_data` to hang `requestor` or `fixture` on. `smoke-test-2026-05-01`
 * — the 11th pending approval — is precisely this case. The only honest match
 * for such a board is its literal id, enumerated by an operator; a slug PATTERN
 * (`smoke-*`, `*-test-*`) would reintroduce exactly the name-shaped matching the
 * banner above forbids, so it is deliberately not offered. Defaults to EMPTY:
 * until an operator enumerates a board here, stream boards keep minting
 * approvals, which is the safe direction to be wrong in.
 */
export function resolveFixtureBoardIds(): readonly string[] {
  return parseCsvEnv(process.env.FR_FIXTURE_BOARD_IDS) ?? [];
}

/** What the predicate reads. Every field is `unknown` until type-checked —
 *  `project_data` is operator-supplied JSONB, not a validated shape. */
export interface FixtureOriginInput {
  /** `projects.project_data`. Null/absent for a stream-backed board. */
  projectData?: unknown;
  /** The resolved Planka board id, for the stream-board path. */
  boardId?: string | null;
}

/** Explicit allowlists; an omitted field is read from the environment. */
export interface FixtureOriginOptions {
  requestors?: readonly string[];
  boardIds?: readonly string[];
}

/**
 * True iff this work originates from a test fixture and must NOT mint a human
 * approval. Three independent EXACT markers, OR'd:
 *
 *   1. `project_data.fixture === true` — a driver declaring itself. Strict
 *      `=== true`: the string "true", 1, and "yes" all answer false.
 *   2. `project_data.requestor` exactly equal to an allowlisted entry.
 *   3. `boardId` exactly equal to an `FR_FIXTURE_BOARD_IDS` entry (the
 *      stream-board path — see resolveFixtureBoardIds).
 *
 * OR, not AND, and that is load-bearing: `fixture` is a NEW field
 * (types/api.ts), so none of the 129 already-created IT Flow1 projects carry it.
 * Requiring both would make this control inert against the exact 10 pending
 * approvals it exists to stop, until every driver is updated and every project
 * recreated.
 *
 * Pure apart from the two env reads; zero I/O.
 */
export function isFixtureOrigin(
  input: FixtureOriginInput,
  opts: FixtureOriginOptions = {},
): boolean {
  const boardIds = opts.boardIds ?? resolveFixtureBoardIds();
  if (typeof input.boardId === 'string' && boardIds.includes(input.boardId)) {
    return true;
  }

  const data = input.projectData;
  if (!data || typeof data !== 'object') return false;
  const { fixture, requestor } = data as { fixture?: unknown; requestor?: unknown };

  if (fixture === true) return true;

  if (typeof requestor !== 'string') return false;
  const requestors = opts.requestors ?? resolveFixtureRequestors();
  // `includes` on a string[] is `===` per element — exact equality, by design.
  return requestors.includes(requestor);
}

/**
 * Resolve the concrete Keycloak-subject UUIDs to seed as a project's
 * `execution_signoff` stakeholders.
 *
 * Rules:
 *   1. Keep the deduped, valid-UUID subset of `approvers` (free-text names are
 *      dropped — `project_stakeholders.user_id` is a NOT NULL uuid column).
 *   2. If that subset is empty, fall back to the project owner so the gate
 *      roster is never empty (the dead-strand fix). The owner only becomes the
 *      default approver when no explicit approver was given — an explicit roster
 *      always wins, so we never inject unwanted owner self-approval.
 *   3. If even the owner id is not a valid UUID, return [] (defensive — the
 *      caller's insert simply seeds nothing, preserving today's behaviour for
 *      that pathological case rather than throwing).
 */
export function resolveSignoffStakeholderIds(
  approvers: string[],
  ownerId: string,
): string[] {
  const explicit = [...new Set(approvers.filter(isValidUuid))];
  if (explicit.length > 0) return explicit;
  return isValidUuid(ownerId) ? [ownerId] : [];
}
