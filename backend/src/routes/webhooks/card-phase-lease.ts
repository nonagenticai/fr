// src/routes/webhooks/card-phase-lease.ts
//
// THE ATOMIC CARD CLAIM — fr half (PR-5).
// Spec: n8n_custom_nodes/AA_IMPLEMENTATION/PRODUCTION_READINESS.md Part 3.
// Table: backend/migrations/100_card_phase_lease.sql (the spec says "099"; that
// slot was already taken by 099_documents_kag_degraded.sql — see the migration
// header for the full deviation note).
//
// WHY THIS EXISTS (§3.0). `ready-prefetch.json`'s `Advance Guard` says it itself:
// "⚠️ NOT ATOMIC … Planka exposes no compare-and-swap on a card update (no
// If-Match / expected-listId), so this is a read-then-guard: it NARROWS the race …
// It does not close it." The live 2026-08-10 incident on card 1834885028425762010
// proves the stronger claim — the watchdog moved READY→BLOCKED at 04:32:30 on its
// `ready_20min` SLA, and an orphaned in-flight prefetch (exec 504665, started
// 04:28:30) moved BLOCKED→DOING at 04:35:32, undoing the fail-safe. That prefetch's
// `Get Card State` ran at 04:34:34 and ALREADY READ BLOCKED, so an "unchanged since
// we looked" guard would have compared BLOCKED to BLOCKED, passed, and advanced
// anyway. Only a claim taken at the START of the pass and validated at WRITE time
// closes it.
//
// AUTH — ⚠️ HISTORICAL: this route was born on `X-Webhook-Secret`, like
// `router-dedupe` (routes/webhooks.ts). That door was REMOVED (G4, George
// 2026-10-10 — see "AUTH — ONE DOOR" below). §3.1's original justification, quoted: "it must be callable from a Code node, and
// `this.helpers.httpRequestWithAuthentication` is BLOCKED in the n8n 2.18.7 Code
// Node sandbox (probe-proven 2026-06-18). A JWT would need a `Mint Token` node on
// each of 5 hot paths, each a new failure mode needing its own Audit-19 reader.
// Threat model: a leaked secret buys lease theft = a conveyor DoS, not exfiltration,
// and `preempt` is holder-allowlisted server-side."
//
// ⚠️ DEGRADATION IS **CLOSED**, AND THAT IS A DELIBERATE DIVERGENCE FROM
// `router-dedupe`. §3.4, quoted verbatim:
//
//   "`router-dedupe` degrades OPEN for a specific reason: Planka's webhook is
//    fire-and-forget and the event is lost forever if the router does not answer.
//    Failing closed there converts an fr outage into permanent data loss.
//    A card phase transition has none of those properties: […] fr unreachable →
//    degrade OPEN means every writer proceeds unguarded ⇒ the 08-10 class recurs,
//    and *silently*, because the guard reports success; degrade CLOSED means the
//    card does not move; it stays put. […] recovery: none — a fail-safe silently
//    undone leaves no trace [vs] free: watchdog re-fires each tick, `lease_degraded`
//    is on the output. […] CLOSED. A lease that grants itself when the arbiter is
//    down is not a lease."
//
// The server-side half of CLOSED is mechanical and enforced here:
//   * `granted: true` is emitted ONLY when the atomic statement actually RETURNed a
//     row. There is no default-true, no optimistic path, no "assume free".
//   * NOTHING in this module catches a DB error into a positive answer. A failed
//     query propagates to the error middleware as a 5xx, which the caller MUST read
//     as not-granted. Contrast `handleN8nRouterDedupe`, whose caller wraps the call
//     in a try/catch that degrades to the staticData verdict — correct there, fatal
//     here.
//   * There is NO reaper. `router_dedupe` opportunistically DELETEs rows past its
//     ~60s window; deleting a lease row would let `fence` restart at 1 and re-open
//     the ABA window the fence exists to close (§3.1: "the row is retained (not
//     deleted) on release precisely so it cannot restart at 1").
//
// The uncomfortable consequence, stated in §3.4 and repeated here so nobody
// "fixes" it later: while fr is down the watchdog cannot move an SLA-breached card
// to BLOCKED. Still CLOSED — BLOCKED is an escalation, not a data-safety property,
// the watchdog retries every tick, and an unclaimed →BLOCKED write is one of the two
// writers that CAUSED the incident.
//
// PR-6 (n8n claim sites) is a separate, gated change; nothing in n8n_custom_nodes is
// touched by this PR.
//
// AUTH — ONE DOOR (G4, George 2026-10-10; was "two doors", fr#1277):
//   * ⛔ the `X-Webhook-Secret` door is GONE. A request carrying only the secret
//     is 401 from `validateAuth`; the header is ignored.
//   * the bearer door (`validateAuth`) for the typed n8n-nodes-fr op
//     `cardPhaseLease`: an fr LICENCE token (a customer's n8n — tenant pinned by
//     lib/licence-introspect.ts) or a Keycloak JWT.
//
// THE BEARER DOOR (see `authorizeJwtCaller`):
//   * ⛔ THE TENANT PIN. Body `tenant_id` MUST equal the caller's ACTIVE tenant
//     (`ctxTenantId`: the JWT tenant, or the tenant a verified header override
//     resolved to — the conveyor's aa-orchestrator seat with X-Tenant-ID), compared
//     lower-cased — else 403
//     `card_phase_lease_tenant_mismatch`. There is NO cross-tenant exception on
//     this door (a super-admin reaches another tenant only by switching the active
//     tenant, which the pin then compares against), so neither does this.
//   * ⛔ EVERY MUTATING OP (claim, renew, release) IS CONVEYOR-SEAT-ONLY on this
//     door: a caller that is neither
//     the `aa-orchestrator` seat nor a LICENCE caller (its tenant's own n8n
//     conveyor, `holdsConveyorSeat`) gets 403 `card_phase_lease_orchestrator_only`.
//     Leases are the conveyor's card claims; an ordinary user holding one parks a
//     card. `verify` (read-only, tenant-pinned) stays open.
//   * ⛔ PREEMPT IS NEVER HONOURED FOR A KEYCLOAK JWT (the aa-orchestrator seat
//     included). It IS honoured — still for holder `watchdog` only — for a LICENCE
//     caller: the licence is what replaced the n8n secret (G4), so the n8n
//     watchdog keeps the preempt that makes the 08-10 fail-safe stand, now pinned
//     to its own tenant. For a JWT: `holder` is caller-authored, so
//     honouring `preempt` for a bearer that names itself `watchdog` would widen
//     who can preempt from "holds the n8n secret" to "holds any orchestrator
//     token". The narrower rule holds. The request is evaluated as an ordinary claim and the
//     refusal REPORTED (`preempt_refused: true`), the same shape a non-watchdog
//     secret caller already gets — no response-schema change.
//   * Everything after that (the atomic statement, CLOSED degradation, the
//     lease_id predicates) is unchanged.
//
// `lease.released` (event-driven QA re-pull). fr emits it from the two places a
// lease ENDS, and nowhere else:
//   * `release` — only on `released: true` (never already_released / superseded /
//     no_lease, which ended nothing);
//   * `claim` — only when the grant took over a row whose previous lease was still
//     UNRELEASED: `expired_superseded` (it blew its TTL; expiry is otherwise
//     passive and nobody would ever hear of it) or `preempted` (the watchdog).
//     A fresh INSERT, or a claim of an already-released row, emits nothing — the
//     latter was announced by its own release.
// ⛔ AFTER COMMIT. Each lease write is ONE autocommit statement on `queryClient`
// (no `begin()`), so the emit is called only after that awaited statement has
// returned, i.e. committed, with no row lock held (the fr#1314 class). The emit
// is fire-and-forget (`void`, never awaited, never throws): a failed or slow POST
// cannot fail, delay or roll back the lease response; it is logged and counted
// (`fr_card_phase_lease_release_emit_failures_total`). Both doors emit — the emit
// sits below the door split.
// DEFAULT OFF: with AA_LEASE_RELEASED_WEBHOOK unset the emitter is a no-op (no
// POST, no counter); it is armed in gitops together with the n8n consumer.
//
// THE WAITER QUEUE (ncn#2156, migration 172 `card_phase_lease_waiter`). Additive:
// a caller that sends no `waiter` gets exactly the pre-#2156 claim behaviour.
//   * claim + `waiter` REFUSED ⇒ the waiter is enqueued (ON CONFLICT DO NOTHING:
//     the FIRST enqueued_at is kept) IN THE SAME STATEMENT as the claim decision
//     (a CTE). The refused ON CONFLICT DO UPDATE still LOCKS the lease row, so the
//     enqueue commits while that lock is held.
//   * claim + `waiter` GRANTED ⇒ that waiter's own row for this key is deleted,
//     same statement.
//   * release ⇒ statement 1 is the unchanged UPDATE; statement 2 (a FRESH READ
//     COMMITTED snapshot) peeks the oldest waiter and returns it as `next_waiter`.
//     It does NOT delete it: the row stays until the waiter's own granted claim,
//     or `unwait`, removes it — so a failed wake is retried by the next release.
//   ⛔ LOST-WAKEUP CLOSURE. A refused claim racing a release either holds the row
//   lock first (its enqueue commits before the release's UPDATE can run, so the
//   release's SECOND statement sees it) or runs after the release committed (and
//   is then granted). Reading the waiter INSIDE the release statement would use a
//   snapshot taken before the blocked UPDATE waited, miss the enqueue, and strand
//   the waiter.
//   * unwait ⇒ deletes one waiter row; idempotent. Orchestrator-only on the JWT door.
//   * `next_waiter` is OPT-IN: a release carries it ONLY when the request sends
//     `return_next_waiter: true`. An old-shape release is byte-identical to the
//     pre-#2156 response on every branch (released / already_released /
//     superseded / no_lease).
//   * NO SELF-QUEUE. A claim whose holder (or whose `waiter`'s `card:<id>`) is the
//     CURRENT live holder never enqueues — a hunt QA-rework re-claim by `card:X`
//     stays the pre-#2156 refused `held` and never queues X behind itself. And
//     `next_waiter` EXCLUDES the releasing holder's own card (`<id>` and
//     `card:<id>`, the ncn holder convention), so a stale self-row is never woken.
//     The self-check reads the lease row in the STATEMENT snapshot; a same-holder
//     claim racing its own release + a third claimant can still enqueue itself —
//     the release-side exclusion is what bounds that.
//   KNOWN LIMITS (ncn#2156 PR body; the ncn waker owns the first two):
//   * `waiter` / `waiter_board_id` are caller-authored and NOT verified to belong
//     to the tenant: the waker must re-read the card and check its board/tenant
//     before moving it.
//   * Peek-not-pop can name the same card twice when another claimant wins the
//     lease first; the waker's stale check (still TODO + marker) bounds it.
//   * Waiters behind an EXPIRED lease get no wake event (expiry is passive, nobody
//     calls release) — tracked as nonagenticai/n8n_custom_nodes#2161.
//
// RELEASE_HOLDER (ncn#2156 addendum D1). Additive, opt-in op:
//   `{op:'release_holder', tenant_id, holder, return_next_waiter?}` — no `card_id`,
//   no `lease_id`: the QA exit knows its holder but never persisted its lease_id.
//   * Statement 1 is ONE autocommit UPDATE releasing EVERY live lease (released_at
//     IS NULL AND expires_at > NOW()) whose holder is exactly `holder` in that tenant
//     — atomic: all of them or (on error) none. Rows are retained, as `release` does.
//   * Each released key then gets `next_waiter` exactly as `release` computes it:
//     `peekNextWaiter` — its own statement AFTER the UPDATE committed (the LOST-WAKEUP
//     CLOSURE above applies unchanged: a refused claim holding the row lock first
//     commits its enqueue before the UPDATE can touch that row), a PEEK, excluding the
//     releasing holder's own card. Present only with `return_next_waiter: true`.
//   * Each released lease emits `lease.released` (reason 'released') after commit, as
//     a single `release` does — it ENDED that lease. A third emit site, same contract.
//   * An EXPIRED-but-unreleased lease is NOT live, so it is NOT released and wakes
//     nobody: consistent with expiry being passive (#2161 owns that wake).
//   * Zero live leases ⇒ `released: []` (idempotent). Orchestrator-only and
//     tenant-pinned on the JWT door, exactly like `unwait`.
//
// REENTRANT CLAIM (ncn#2156 addendum D1b). Additive, opt-in `claim` + `reentrant:true`:
// when the key's CURRENT live lease is held by exactly this `holder`, the claim is
// GRANTED with the EXISTING lease_id and fence and only `expires_at` renewed to
// NOW()+ttl — no new lease, no fence bump, no emit (nothing ended). Without the flag
// a same-holder claim stays the refused `held` (byte-identical). See the claim
// statement for the concurrency argument.

import { z } from 'zod';

import { queryClient } from '../../db/client';
import { holdsConveyorSeat } from '../../lib/project-access';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { emitLeaseReleased } from '../../services/card-phase-lease-events';
import type { User } from '../../types/api';
import { ForbiddenError } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';

/**
 * §3.1: "`preempt: true` is accepted **only** for `holder ∈ {'watchdog'}`, enforced
 * server-side. The watchdog is the SLA breaker of last resort; reclaiming a card
 * whose owner blew its budget is its entire job."
 *
 * Widening this set is the one change that can reproduce the 2026-08-10 incident
 * (it is open question #3 in the spec), so it is a literal constant here rather than
 * an env var or a DB row: changing it must be a reviewed code diff.
 */
const PREEMPT_ALLOWED_HOLDERS: ReadonlySet<string> = new Set(['watchdog']);

/** The replay's window: claim at 04:28:30 expires 04:38:30. */
const DEFAULT_TTL_SECONDS = 600;

const CardPhaseLeaseSchema = z.object({
  // `release_holder` is listed so the bad-op 400 names it; its body is parsed by
  // `ReleaseHolderSchema` (it carries no card_id), routed before this schema runs.
  op: z.enum(['claim', 'verify', 'renew', 'release', 'unwait', 'release_holder']),
  tenant_id: z.string().min(1),
  card_id: z.string().min(1),
  /** Required for `claim`. Which phase writer wants the card. */
  holder: z.string().min(1).max(128).optional(),
  /** Required for `verify` / `renew` / `release`. The token a previous claim returned. */
  lease_id: z.string().min(1).max(128).optional(),
  /**
   * 0 is permitted and means "already expired on arrival": a degenerate but SAFE
   * lease (instantly reclaimable, never a false exclusion). The tests use it to
   * exercise the TTL branch deterministically instead of sleeping.
   */
  ttl_seconds: z.number().int().min(0).max(86_400).optional(),
  preempt: z.boolean().optional(),
  /**
   * ncn#2156. `claim`: the waiting card's id (normally the claimant's own card).
   * Refused ⇒ enqueued on this lease key; granted ⇒ its own waiter row is deleted.
   * Absent ⇒ the pre-#2156 claim, byte-for-byte. `unwait`: the waiter to remove.
   */
  waiter: z.string().min(1).max(256).optional(),
  /** ncn#2156. `claim` + `waiter`: the waiting card's board; stored, returned in `next_waiter.board_id`. */
  waiter_board_id: z.string().min(1).max(256).optional(),
  /**
   * ncn#2156. `release`: opt in to `next_waiter`. Absent/false ⇒ the pre-#2156
   * release response, byte-for-byte.
   */
  return_next_waiter: z.boolean().optional(),
  /**
   * ncn#2156 D1b. `claim`: a claim by the CURRENT live holder is granted on its
   * EXISTING lease (expiry renewed). Absent/false ⇒ the refused `held`, byte-for-byte.
   */
  reentrant: z.boolean().optional(),
});

/** ncn#2156 D1 — `release_holder` names a holder, not a key, so it has no card_id. */
const ReleaseHolderSchema = z.object({
  op: z.literal('release_holder'),
  tenant_id: z.string().min(1),
  holder: z.string().min(1).max(128).optional(),
  return_next_waiter: z.boolean().optional(),
});

/**
 * Every row shape below is projected so that NO time comparison and NO date
 * parsing happens in JavaScript:
 *
 *   * `expires_at_iso` is rendered by Postgres, because this connection returns
 *     TIMESTAMPTZ as a raw PG-format string (`2026-08-17 20:33:28.799528+00`), not
 *     a Date — `new Date(...)` on that is engine-dependent, and a wrong parse here
 *     would silently mis-report a lease's horizon.
 *   * `expired` is computed by Postgres against Postgres's own NOW(), which is the
 *     SAME clock the atomic claim's WHERE uses. Comparing against the fr pod's
 *     clock instead would make `verify` and `claim` capable of disagreeing about
 *     whether a lease is live — a race with extra steps.
 */
type LeaseRow = {
  lease_id: string;
  holder: string;
  fence: string | number;
  expires_at_iso: string;
  expired: boolean;
  released: boolean;
};

/**
 * What `claim`'s RETURNING adds: the PREVIOUS row's state, read through Postgres
 * 18's `RETURNING old.*` in the SAME atomic statement. All NULL for a fresh INSERT.
 * Reading it with a separate pre-SELECT would race the very writers this statement
 * serialises; `old` is the row version the conflict arm actually replaced.
 */
type ClaimRow = LeaseRow & {
  prev_lease_id: string | null;
  prev_holder: string | null;
  prev_unreleased: boolean | null;
  prev_expired: boolean | null;
  granted_at_iso: string;
  /** D1b: the grant kept the previous lease_id ⇔ the reentrant arm took it. */
  reentrant_hit: boolean;
};

/**
 * The claim CTE always returns exactly ONE row (a LEFT JOIN onto a one-row
 * relation) so the waiter side effects are reported even when nothing was
 * granted. `lease_id` is NULL ⇔ the claim arm returned no row ⇔ NOT granted
 * (`card_phase_lease.lease_id` is NOT NULL, so a granted row can never read NULL).
 */
type ClaimCteRow = { [K in keyof ClaimRow]: ClaimRow[K] | null } & {
  enqueued_n: number;
  dequeued_n: number;
};

type WaiterRow = { waiter_card_id: string; board_id: string | null; enqueued_at_iso: string };

/** ncn#2156 — the `next_waiter` wire shape. */
type NextWaiter = { card_id: string; board_id: string | null; enqueued_at: string };

/** postgres.js returns BIGINT as a string; the wire contract is a number. */
function fenceToNumber(fence: string | number): number {
  return typeof fence === 'number' ? fence : Number.parseInt(fence, 10);
}

/**
 * POST /api/webhooks/n8n/card-phase-lease
 *
 * One path, three ops (§3.1).
 *
 *   claim   { op, tenant_id, card_id, holder, ttl_seconds?, preempt? }
 *           → { granted: true,  lease_id, fence, holder, expires_at }
 *           → { granted: false, reason, holder, fence, expires_at }
 *
 *   verify  { op, tenant_id, card_id, lease_id }
 *           → { valid: true,  fence, holder, expires_at }
 *           → { valid: false, reason: 'superseded' | 'released' | 'expired' | 'no_lease', … }
 *
 *   renew   { op, tenant_id, card_id, lease_id, ttl_seconds? }
 *           → { renewed: true,  fence, expires_at }
 *           → { renewed: false, reason: 'superseded' | 'released' | 'expired' | 'no_lease' }
 *
 *   release { op, tenant_id, card_id, lease_id }
 *           → { released: true, fence } | { released: false, reason, holder, fence }
 *
 *   ncn#2156 waiter queue (additive):
 *   claim   + waiter? (+ waiter_board_id?)
 *                     → granted: … + waiter_dequeued: boolean
 *                     → refused: … + queued: boolean (false ⇔ no row: the claimant IS the
 *                       current holder, or an unwait raced it), enqueued: boolean (false =
 *                       already queued, first enqueued_at kept), enqueued_at, queue_position (1 = next)
 *   release + return_next_waiter: true
 *                     → + next_waiter: { card_id, board_id, enqueued_at } | null — a PEEK, never a
 *                       pop, excluding the releasing holder's own card (null on superseded /
 *                       no_lease: the lease is not this caller's to hand on). Without the flag the
 *                       release response is the pre-#2156 one, byte-for-byte.
 *   unwait  { op, tenant_id, card_id, waiter } → { op: 'unwait', removed: boolean }
 *
 *   ncn#2156 addendum (additive):
 *   claim   + reentrant: true → same-holder live lease ⇒ granted on the EXISTING lease_id,
 *                       expires_at renewed, + reentrant: boolean (true ⇔ that arm took it)
 *   release_holder { op, tenant_id, holder, return_next_waiter? }
 *           → { op: 'release_holder', released: [{ card_id, lease_id, next_waiter? }] } ordered by card_id
 *
 * Every Planka write by a claim site is preceded by a `verify` on the holder's own
 * `lease_id` — §3.1: "Stale-holder detection is the fence, not a timestamp. A holder
 * that slept past its TTL cannot tell time reliably; it *can* ask whether its
 * `lease_id` is still current."
 */
export async function handleCardPhaseLease(req: Request): Promise<Response> {
  // ONE DOOR (G4, see the AUTH header block): a bearer through `validateAuth` —
  // an fr licence token or a Keycloak JWT. The X-Webhook-Secret door is removed;
  // a secret-only request is 401 here.
  const caller: User = await validateAuth(req);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  // ncn#2156 D1 — routed on the raw op so every other op's parse (and its 400 text)
  // is the unchanged CardPhaseLeaseSchema.
  if (typeof raw === 'object' && raw !== null && (raw as { op?: unknown }).op === 'release_holder') {
    const rh = ReleaseHolderSchema.safeParse(raw);
    if (!rh.success) {
      return jsonResponse({ error: `Invalid payload: ${rh.error.message}` }, 400);
    }
    authorizeJwtCaller(caller, rh.data);
    return releaseHolder(rh.data);
  }
  const parsed = CardPhaseLeaseSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ error: `Invalid payload: ${parsed.error.message}` }, 400);
  }
  const body = parsed.data;
  authorizeJwtCaller(caller, body);

  // Preempt (still `watchdog`-only, server-side) was the secret door's — the n8n
  // system's. G4 moved that system onto its LICENCE: a licence caller is its
  // tenant's own n8n, so it inherits the preempt, pinned to its own tenant
  // (strictly narrower than the old cross-tenant secret). A Keycloak JWT —
  // including the aa-orchestrator seat — never preempts (header block).
  if (body.op === 'claim') return claim(body, { preemptPermitted: caller.authKind === 'licence' });
  if (body.op === 'verify') return verify(body);
  if (body.op === 'renew') return renew(body);
  if (body.op === 'unwait') return unwait(body);
  return release(body);
}

type Parsed = z.infer<typeof CardPhaseLeaseSchema>;

const CARD_PHASE_LEASE_TENANT_MISMATCH_CODE = 'card_phase_lease_tenant_mismatch';
const CARD_PHASE_LEASE_ORCHESTRATOR_ONLY_CODE = 'card_phase_lease_orchestrator_only';

/**
 * The JWT door's authorization (the retired wip-slot route's door, minus its
 * project/card-binding checks: this route carries no project_id and its request
 * schema does not change). Applied after the payload parses and BEFORE
 * any read or write of `card_phase_lease`; throws 403 otherwise.
 */
function authorizeJwtCaller(user: User, body: { op: Parsed['op']; tenant_id: string }): void {
  const activeTenant = ctxTenantId(user.tenantId).toLowerCase();
  // ⛔ THE TENANT PIN. Every op names a tenant; it must be
  // the caller's. Lower-cased on both sides: the column is uuid (migration 103),
  // so case never names a different row.
  if (body.tenant_id.toLowerCase() !== activeTenant) {
    throw new ForbiddenError(
      `tenant_id ${body.tenant_id} is not the caller's active tenant; a bearer caller may only ` +
        "claim, verify, renew or release its own tenant's card leases",
    ).withCode(CARD_PHASE_LEASE_TENANT_MISMATCH_CODE);
  }
  // ⛔ LEASES ARE THE CONVEYOR'S CARD CLAIMS. One check per
  // op, each a separate guard. `verify` is read-only and stays open (tenant-pinned).
  if (body.op === 'claim' && !holdsConveyorSeat(user)) throw orchestratorOnly('claim');
  if (body.op === 'renew' && !holdsConveyorSeat(user)) throw orchestratorOnly('renew');
  if (body.op === 'release' && !holdsConveyorSeat(user)) throw orchestratorOnly('release');
  if (body.op === 'unwait' && !holdsConveyorSeat(user)) throw orchestratorOnly('unwait');
  if (body.op === 'release_holder' && !holdsConveyorSeat(user)) throw orchestratorOnly('release_holder');
}

function orchestratorOnly(
  op: 'claim' | 'renew' | 'release' | 'unwait' | 'release_holder',
): ForbiddenError {
  return new ForbiddenError(
    'card phase leases are the conveyor\'s card claims; through a bearer only the conveyor ' +
      `orchestrator (aa-orchestrator role) or a licence caller may ${op} one`,
  ).withCode(CARD_PHASE_LEASE_ORCHESTRATOR_ONLY_CODE);
}

async function claim(body: Parsed, door: { preemptPermitted: boolean }): Promise<Response> {
  const holder = body.holder;
  if (!holder) {
    return jsonResponse({ error: '`holder` is required for op=claim' }, 400);
  }

  // §3.1 — server-side allowlist. A non-watchdog caller asking to preempt does NOT
  // get the preemption; the claim is then evaluated as an ordinary (free-or-expired)
  // claim and the refusal is REPORTED rather than silently dropped, so the caller's
  // Audit-19 reader can see that it asked for something it did not get.
  // A Keycloak JWT never preempts (header block); a licence caller may (watchdog only).
  const preemptRequested = body.preempt === true;
  const preemptAllowed =
    preemptRequested && door.preemptPermitted && PREEMPT_ALLOWED_HOLDERS.has(holder);
  const preemptRefused = preemptRequested && !preemptAllowed;

  const leaseId = crypto.randomUUID();
  const ttlSeconds = body.ttl_seconds ?? DEFAULT_TTL_SECONDS;

  // ── THE ATOMIC STATEMENT ────────────────────────────────────────────────────
  // §3.1: "the atomicity is the primary key plus one conditional UPDATE; no
  // advisory lock." Under N simultaneous claims Postgres serialises the writers on
  // the conflicting (tenant_id, card_id) row: the first INSERTs, the rest take the
  // DO UPDATE arm and re-evaluate the WHERE against the row the winner just wrote.
  // For a live unreleased lease that WHERE is false, so they return NO row. Exactly
  // one caller can therefore see `granted: true`.
  //
  // The three ways a claim may be taken, and nothing else:
  //   released_at IS NOT NULL  — the previous holder released it,
  //   expires_at  <= NOW()     — the previous holder blew its TTL,
  //   preemptAllowed           — the watchdog, and only the watchdog (§3.1).
  //
  // ncn#2156 — the `enqueue` / `dequeue` arms ride in the SAME statement. Both are
  // no-ops when `waiter` is absent (the pre-#2156 claim). `enqueue` runs only when
  // the claim arm returned no row; the refused ON CONFLICT DO UPDATE has LOCKED the
  // lease row, so the enqueue commits under that lock (see the header's
  // LOST-WAKEUP CLOSURE). `dequeue` runs only on a grant.
  //
  // ncn#2156 D1b — THE REENTRANT ARM rides in the SAME conflict WHERE, so it needs
  // no separate read. ON CONFLICT DO UPDATE locks the conflicting row and evaluates
  // the WHERE (and the SET's CASEs) against its LATEST COMMITTED version, after any
  // concurrent writer on that row has finished. So a reentrant claim racing a
  // release, a takeover or a preempt sees their result: released / another holder /
  // expired ⇒ the reentrant predicate is false and the ordinary arms decide exactly
  // as before. Only a still-live lease of this same holder keeps its lease_id, fence
  // and granted_at; nothing about the row changes but expires_at. `reentrant` false
  // ⇒ every CASE takes its ELSE and the extra OR is false: the pre-D1b statement.
  const reentrant = body.reentrant === true;
  const waiter = body.waiter ?? null;
  const waiterBoardId = body.waiter_board_id ?? null;
  const [row] = await queryClient<ClaimCteRow[]>`
    WITH claim AS (
    INSERT INTO card_phase_lease
      (tenant_id, card_id, lease_id, holder, fence, granted_at, expires_at)
    VALUES (
      ${body.tenant_id}, ${body.card_id}, ${leaseId}, ${holder}, 1, NOW(),
      NOW() + make_interval(secs => ${ttlSeconds}::float8)
    )
    ON CONFLICT (tenant_id, card_id) DO UPDATE
       SET lease_id    = CASE WHEN ${reentrant}::boolean
                                   AND card_phase_lease.holder = EXCLUDED.holder
                                   AND card_phase_lease.released_at IS NULL
                                   AND card_phase_lease.expires_at > NOW()
                              THEN card_phase_lease.lease_id ELSE EXCLUDED.lease_id END,
           holder      = EXCLUDED.holder,
           -- Monotonic and NEVER reset — the ABA guard (§3.1). A reentrant grant is
           -- not a new grant, so its fence does not move (renew's rule).
           fence       = CASE WHEN ${reentrant}::boolean
                                   AND card_phase_lease.holder = EXCLUDED.holder
                                   AND card_phase_lease.released_at IS NULL
                                   AND card_phase_lease.expires_at > NOW()
                              THEN card_phase_lease.fence ELSE card_phase_lease.fence + 1 END,
           granted_at  = CASE WHEN ${reentrant}::boolean
                                   AND card_phase_lease.holder = EXCLUDED.holder
                                   AND card_phase_lease.released_at IS NULL
                                   AND card_phase_lease.expires_at > NOW()
                              THEN card_phase_lease.granted_at ELSE NOW() END,
           expires_at  = EXCLUDED.expires_at,
           released_at = NULL
     WHERE card_phase_lease.released_at IS NOT NULL
        OR card_phase_lease.expires_at <= NOW()
        OR ${preemptAllowed}::boolean
        OR (${reentrant}::boolean
            AND card_phase_lease.holder = EXCLUDED.holder
            AND card_phase_lease.released_at IS NULL
            AND card_phase_lease.expires_at > NOW())
    RETURNING lease_id, holder, fence,
              to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at_iso,
              (expires_at <= NOW())      AS expired,
              (released_at IS NOT NULL)  AS released,
              to_char(granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS granted_at_iso,
              old.lease_id               AS prev_lease_id,
              old.holder                 AS prev_holder,
              (old.released_at IS NULL)  AS prev_unreleased,
              (old.expires_at <= NOW())  AS prev_expired,
              (old.lease_id IS NOT DISTINCT FROM lease_id) AS reentrant_hit
    ),
    enqueue AS (
      INSERT INTO card_phase_lease_waiter (tenant_id, lease_key, waiter_card_id, board_id)
      SELECT ${body.tenant_id}::uuid, ${body.card_id}::text, ${waiter}::text, ${waiterBoardId}::text
       WHERE ${waiter}::text IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM claim)
         -- NO SELF-QUEUE: the current live holder (by holder, or by the waiter's
         -- own card) is never queued behind itself — a same-holder re-claim stays
         -- the plain refused 'held'.
         AND NOT EXISTS (
           SELECT 1 FROM card_phase_lease l
            WHERE l.tenant_id = ${body.tenant_id}
              AND l.card_id   = ${body.card_id}
              AND l.released_at IS NULL
              AND l.expires_at > NOW()
              AND (l.holder = ${holder}
                   OR l.holder = ${waiter}::text
                   OR l.holder = 'card:' || ${waiter}::text)
         )
      ON CONFLICT (tenant_id, lease_key, waiter_card_id) DO NOTHING
      RETURNING 1
    ),
    dequeue AS (
      DELETE FROM card_phase_lease_waiter w
       WHERE ${waiter}::text IS NOT NULL
         AND EXISTS (SELECT 1 FROM claim)
         AND w.tenant_id      = ${body.tenant_id}::uuid
         AND w.lease_key      = ${body.card_id}::text
         AND w.waiter_card_id = ${waiter}::text
      RETURNING 1
    )
    SELECT claim.*,
           (SELECT count(*) FROM enqueue)::int AS enqueued_n,
           (SELECT count(*) FROM dequeue)::int AS dequeued_n
      FROM (SELECT 1) AS one
      LEFT JOIN claim ON TRUE
  `;

  // CLOSED: granted ONLY when the claim arm itself returned a row.
  const granted = row && row.lease_id !== null ? (row as ClaimRow & ClaimCteRow) : null;
  if (granted) {
    // The statement above has returned ⇒ committed (autocommit, no lock held).
    // Emit only when this grant ENDED someone else's still-unreleased lease. A
    // reentrant grant ended nothing (same lease_id) — no emit.
    if (
      granted.prev_lease_id !== null &&
      granted.prev_holder !== null &&
      granted.prev_unreleased &&
      !granted.reentrant_hit
    ) {
      emitLeaseReleased({
        reason: granted.prev_expired ? 'expired_superseded' : 'preempted',
        tenant_id: body.tenant_id,
        lease_key: body.card_id,
        lease_id: granted.prev_lease_id,
        holder: granted.prev_holder,
        released_at: granted.granted_at_iso,
      });
    }
    return jsonResponse({
      op: 'claim',
      granted: true,
      lease_id: granted.lease_id,
      holder: granted.holder,
      fence: fenceToNumber(granted.fence),
      expires_at: granted.expires_at_iso,
      preempted: preemptAllowed,
      ...(preemptRefused ? { preempt_refused: true } : {}),
      ...(waiter !== null ? { waiter_dequeued: granted.dequeued_n > 0 } : {}),
      // OPT-IN (D1b): only a caller that sent reentrant:true sees the key.
      ...(reentrant ? { reentrant: granted.reentrant_hit === true } : {}),
    });
  }

  // NOT GRANTED. This read is INFORMATIONAL ONLY — it is not part of the decision,
  // which was already made atomically above. It exists so the caller's not-granted
  // branch has real properties to read (Audit 19 Leg 3 wants a property access, not
  // a substring) and so "who holds this card" is answerable from one call.
  const [current] = await queryClient<LeaseRow[]>`
    SELECT lease_id, holder, fence,
           to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at_iso,
           (expires_at <= NOW())     AS expired,
           (released_at IS NOT NULL) AS released
      FROM card_phase_lease
     WHERE tenant_id = ${body.tenant_id} AND card_id = ${body.card_id}
  `;

  // ncn#2156 — informational too: where the (already committed) enqueue left this
  // waiter. `queued:false` + NULL fields when there is no row: the claimant IS the
  // current holder (never self-queued), or an `unwait` removed it in between.
  let queue: Record<string, unknown> = {};
  if (waiter !== null) {
    const [place] = await queryClient<{ enqueued_at_iso: string; queue_position: number }[]>`
      SELECT to_char(w.enqueued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS enqueued_at_iso,
             (SELECT count(*) FROM card_phase_lease_waiter o
               WHERE o.tenant_id = w.tenant_id AND o.lease_key = w.lease_key
                 AND (o.enqueued_at, o.waiter_card_id) <= (w.enqueued_at, w.waiter_card_id))::int
               AS queue_position
        FROM card_phase_lease_waiter w
       WHERE w.tenant_id = ${body.tenant_id}::uuid
         AND w.lease_key = ${body.card_id}::text
         AND w.waiter_card_id = ${waiter}::text
    `;
    queue = {
      queued: place !== undefined,
      enqueued: (row?.enqueued_n ?? 0) > 0,
      enqueued_at: place?.enqueued_at_iso ?? null,
      queue_position: place?.queue_position ?? null,
    };
  }

  return jsonResponse({
    op: 'claim',
    granted: false,
    reason: 'held',
    holder: current?.holder ?? null,
    fence: current ? fenceToNumber(current.fence) : null,
    expires_at: current?.expires_at_iso ?? null,
    preempt_requested: preemptRequested,
    ...(preemptRefused ? { preempt_refused: true } : {}),
    ...queue,
  });
}

/**
 * ncn#2156 — PEEK the oldest waiter on a lease key. ⛔ Must be its OWN statement,
 * issued AFTER the release UPDATE has returned: a fresh READ COMMITTED snapshot is
 * what lets it see an enqueue that committed while the UPDATE waited on the row
 * lock. Never deletes (see the header).
 */
async function peekNextWaiter(
  key: { tenant_id: string; card_id: string },
  releasingHolder: string,
): Promise<NextWaiter | null> {
  // The releasing holder's OWN card is never the next waiter: a stale self-row
  // (e.g. queued before it won, by a path that skipped the self-delete) must not
  // be "woken". ncn's holder is `card:<id>`; the bare `<id>` form is excluded too.
  const [w] = await queryClient<WaiterRow[]>`
    SELECT waiter_card_id, board_id,
           to_char(enqueued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS enqueued_at_iso
      FROM card_phase_lease_waiter
     WHERE tenant_id = ${key.tenant_id}::uuid
       AND lease_key = ${key.card_id}::text
       AND waiter_card_id <> ${releasingHolder}::text
       AND 'card:' || waiter_card_id <> ${releasingHolder}::text
     ORDER BY enqueued_at, waiter_card_id
     LIMIT 1
  `;
  return w
    ? { card_id: w.waiter_card_id, board_id: w.board_id, enqueued_at: w.enqueued_at_iso }
    : null;
}

/**
 * ncn#2156 D1 — release EVERY live lease `holder` holds in the tenant (header block).
 */
async function releaseHolder(body: z.infer<typeof ReleaseHolderSchema>): Promise<Response> {
  const holder = body.holder;
  if (!holder) {
    return jsonResponse({ error: '`holder` is required for op=release_holder' }, 400);
  }

  // ONE autocommit statement: atomic across every key. UPDATE, never DELETE (fence).
  // Ordered by key in the C collation so the response order never depends on locale.
  const rows = await queryClient<
    { card_id: string; lease_id: string; holder: string; released_at_iso: string }[]
  >`
    WITH r AS (
      UPDATE card_phase_lease
         SET released_at = NOW()
       WHERE tenant_id = ${body.tenant_id}
         AND holder    = ${holder}
         AND released_at IS NULL
         AND expires_at > NOW()
      RETURNING card_id, lease_id, holder,
                to_char(released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS released_at_iso
    )
    SELECT card_id, lease_id, holder, released_at_iso FROM r ORDER BY card_id COLLATE "C"
  `;

  // The UPDATE has returned ⇒ committed (autocommit, no lock held).
  const released: Array<{ card_id: string; lease_id: string; next_waiter?: NextWaiter | null }> = [];
  for (const r of rows) {
    emitLeaseReleased({
      reason: 'released',
      tenant_id: body.tenant_id,
      lease_key: r.card_id,
      lease_id: r.lease_id,
      holder: r.holder,
      released_at: r.released_at_iso,
    });
    released.push({
      card_id: r.card_id,
      lease_id: r.lease_id,
      // OPT-IN, and its OWN statement after the commit — exactly `release`'s peek.
      ...(body.return_next_waiter === true
        ? {
            next_waiter: await peekNextWaiter(
              { tenant_id: body.tenant_id, card_id: r.card_id },
              r.holder,
            ),
          }
        : {}),
    });
  }
  return jsonResponse({ op: 'release_holder', released });
}

/**
 * ncn#2156 — remove one waiter (the waker found it stale, or the card gave up).
 * Idempotent: removing an absent row answers `removed: false`, never an error.
 */
async function unwait(body: Parsed): Promise<Response> {
  const waiter = body.waiter;
  if (!waiter) {
    return jsonResponse({ error: '`waiter` is required for op=unwait' }, 400);
  }
  const rows = await queryClient<{ one: number }[]>`
    DELETE FROM card_phase_lease_waiter
     WHERE tenant_id      = ${body.tenant_id}::uuid
       AND lease_key      = ${body.card_id}::text
       AND waiter_card_id = ${waiter}::text
    RETURNING 1 AS one
  `;
  return jsonResponse({ op: 'unwait', removed: rows.length > 0 });
}

async function verify(body: Parsed): Promise<Response> {
  const leaseId = body.lease_id;
  if (!leaseId) {
    return jsonResponse({ error: '`lease_id` is required for op=verify' }, 400);
  }

  const [row] = await queryClient<LeaseRow[]>`
    SELECT lease_id, holder, fence,
           to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at_iso,
           (expires_at <= NOW())     AS expired,
           (released_at IS NOT NULL) AS released
      FROM card_phase_lease
     WHERE tenant_id = ${body.tenant_id} AND card_id = ${body.card_id}
  `;

  // Order is load-bearing. `superseded` is checked FIRST because it is the
  // 2026-08-10 replay's answer: at 04:35:32 lease A had NOT expired (exp 04:38:30)
  // and had not been released — it had simply been taken by the watchdog's lease B.
  // A clock-first ordering would have answered "still valid" and re-opened the race.
  if (!row) {
    return jsonResponse({ op: 'verify', valid: false, reason: 'no_lease' });
  }
  if (row.lease_id !== leaseId) {
    return jsonResponse({
      op: 'verify',
      valid: false,
      reason: 'superseded',
      holder: row.holder,
      fence: fenceToNumber(row.fence),
    });
  }
  if (row.released) {
    return jsonResponse({
      op: 'verify',
      valid: false,
      reason: 'released',
      holder: row.holder,
      fence: fenceToNumber(row.fence),
    });
  }
  if (row.expired) {
    return jsonResponse({
      op: 'verify',
      valid: false,
      reason: 'expired',
      holder: row.holder,
      fence: fenceToNumber(row.fence),
      expires_at: row.expires_at_iso,
    });
  }

  return jsonResponse({
    op: 'verify',
    valid: true,
    holder: row.holder,
    fence: fenceToNumber(row.fence),
    expires_at: row.expires_at_iso,
  });
}

/**
 * RENEW — extend the horizon of a lease you still hold. Added because the original
 * three ops make a long holder impossible to serve honestly.
 *
 * THE PROBLEM IT SOLVES. `claim`'s WHERE is `released_at IS NOT NULL OR expires_at <=
 * NOW() OR preemptAllowed`, with no same-holder arm — so a live holder re-claiming its
 * OWN card is refused against itself (`granted:false, reason:'held'`, its own holder
 * string in the response). Without a renew, a holder whose work outlives its TTL has
 * only bad options: claim a TTL sized to the worst case up front, so a crash parks the
 * card for hours; or release-then-reclaim, which is not a renewal at all but a
 * deliberately opened window. Neither is what the caller means.
 *
 * ⛔ THE FENCE DOES NOT MOVE. A renewal is NOT a new grant. `fence` is the ABA guard —
 * bumping it here would make a holder supersede ITSELF, and every claim site that
 * captured a fence at the start of its pass would fail its own pre-write check for no
 * reason. Only `claim` may mint a fence.
 *
 * ⛔ AN EXPIRED LEASE IS NOT RENEWABLE, DELIBERATELY. `expires_at > NOW()` is in the
 * WHERE. Once the horizon has passed, the card is claimable by anyone and the honest
 * answer is a fresh `claim`, which either succeeds or names the new holder. Resurrecting
 * it would silently re-take a card another writer was entitled to — and it contradicts
 * §3.1's rule that a holder which slept past its TTL cannot tell time reliably: such a
 * caller must re-establish its right, not assert it.
 *
 * The `lease_id` predicate makes this non-stealable in the same way `release` is: you can
 * only extend the lease whose token you hold.
 */
async function renew(body: Parsed): Promise<Response> {
  const leaseId = body.lease_id;
  if (!leaseId) {
    return jsonResponse({ error: '`lease_id` is required for op=renew' }, 400);
  }
  const ttlSeconds = body.ttl_seconds ?? DEFAULT_TTL_SECONDS;

  const rows = await queryClient<LeaseRow[]>`
    UPDATE card_phase_lease
       SET expires_at = NOW() + make_interval(secs => ${ttlSeconds}::float8)
     WHERE tenant_id = ${body.tenant_id}
       AND card_id   = ${body.card_id}
       AND lease_id  = ${leaseId}
       AND released_at IS NULL
       AND expires_at > NOW()
    RETURNING lease_id, holder, fence,
              to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at_iso,
              (expires_at <= NOW())     AS expired,
              (released_at IS NOT NULL) AS released
  `;

  const renewed = rows[0];
  if (renewed) {
    return jsonResponse({
      op: 'renew',
      renewed: true,
      holder: renewed.holder,
      fence: fenceToNumber(renewed.fence),
      expires_at: renewed.expires_at_iso,
    });
  }

  // Informational only, exactly as `claim` and `release` do it: the decision was already
  // made atomically above. Reason order mirrors `verify` — `superseded` FIRST, because a
  // lease taken by someone else has NOT expired from its own point of view and a
  // clock-first answer would mislead the caller about why it lost.
  const [row] = await queryClient<LeaseRow[]>`
    SELECT lease_id, holder, fence,
           to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at_iso,
           (expires_at <= NOW())     AS expired,
           (released_at IS NOT NULL) AS released
      FROM card_phase_lease
     WHERE tenant_id = ${body.tenant_id} AND card_id = ${body.card_id}
  `;
  const reason = !row
    ? 'no_lease'
    : row.lease_id !== leaseId
      ? 'superseded'
      : row.released
        ? 'released'
        : 'expired';

  return jsonResponse({
    op: 'renew',
    renewed: false,
    reason,
    holder: row?.holder ?? null,
    fence: row ? fenceToNumber(row.fence) : null,
    expires_at: row?.expires_at_iso ?? null,
  });
}

async function release(body: Parsed): Promise<Response> {
  const leaseId = body.lease_id;
  if (!leaseId) {
    return jsonResponse({ error: '`lease_id` is required for op=release' }, 400);
  }

  // UPDATE, never DELETE — the row (and therefore `fence`) must survive a release.
  // The `lease_id` predicate makes release idempotent AND non-stealable: a holder
  // that lost the lease cannot release someone else's.
  const rows = await queryClient<
    { fence: string | number; holder: string; released_at_iso: string }[]
  >`
    UPDATE card_phase_lease
       SET released_at = NOW()
     WHERE tenant_id = ${body.tenant_id}
       AND card_id   = ${body.card_id}
       AND lease_id  = ${leaseId}
       AND released_at IS NULL
    RETURNING fence, holder,
              to_char(released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS released_at_iso
  `;

  const released = rows[0];
  if (released) {
    // The UPDATE has returned ⇒ committed (autocommit, no lock held). Only a
    // release that actually ended the lease emits; every not-released branch
    // below returns without one.
    emitLeaseReleased({
      reason: 'released',
      tenant_id: body.tenant_id,
      lease_key: body.card_id,
      lease_id: leaseId,
      holder: released.holder,
      released_at: released.released_at_iso,
    });
    return jsonResponse({
      op: 'release',
      released: true,
      fence: fenceToNumber(released.fence),
      // OPT-IN (ncn#2156): absent flag ⇒ the pre-#2156 response, byte-for-byte.
      ...(body.return_next_waiter === true
        ? { next_waiter: await peekNextWaiter(body, released.holder) }
        : {}),
    });
  }

  // Informational: say WHY nothing was released, so a claim site never has to guess.
  const [row] = await queryClient<LeaseRow[]>`
    SELECT lease_id, holder, fence,
           to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at_iso,
           (expires_at <= NOW())     AS expired,
           (released_at IS NOT NULL) AS released
      FROM card_phase_lease
     WHERE tenant_id = ${body.tenant_id} AND card_id = ${body.card_id}
  `;
  const reason = !row
    ? 'no_lease'
    : row.lease_id !== leaseId
      ? 'superseded'
      : 'already_released';

  return jsonResponse({
    op: 'release',
    released: false,
    reason,
    holder: row?.holder ?? null,
    fence: row ? fenceToNumber(row.fence) : null,
    // OPT-IN (ncn#2156). A retried release whose first response was lost answers
    // already_released — it must still be able to wake the next waiter.
    // superseded / no_lease: the lease is not this caller's to hand on.
    ...(body.return_next_waiter === true
      ? {
          next_waiter:
            reason === 'already_released' && row
              ? await peekNextWaiter(body, row.holder)
              : null,
        }
      : {}),
  });
}
