// src/routes/internal-computed-checks.ts
//
//   POST /api/internal/cards/:cardId/computed-checks
//        X-Internal-Token == FR_COMPUTED_CHECK_START_TOKEN   → written_by 'n8n.start-plan-checks'
//                                                               (unset everywhere until U-PS-TOKEN)
//        fr licence bearer (no X-Internal-Token)              → the 2 n8n kinds, each keeping its
//                                                               writer's written_by (LICENCE DOOR)
//
// ⛔ G4 (George 2026-10-10): the X-Internal-Token door NO LONGER writes the n8n kinds
// (verify_coding, grid_qa_computed). Their tokens (FR_COMPUTED_CHECK_N8N_TOKEN / _GRID_TOKEN)
// match no caller any more (TOKEN_CALLERS below), so presenting one is 401
// invalid_internal_token (403 computed_check_writer_required with an Authorization header).
// Those kinds are written ONLY through the licence door. start_plan_checks keeps the token
// door (unarmed).
//
// 2026-11-01: the asset-evaluator R10 grader's token door is REMOVED with the service
// (archived; its namespace deleted). The grader was operator-side and read fr's DB
// read-only, so nothing ever POSTed here with that token. `r10_proof_core` stays in
// COMPUTED_CHECK_KINDS for the historical rows the store holds (and the frozen spec /
// generated clients consume), but no caller may write it.
//
// (The old-layer hunt-sweep kinds and the hunt project DELIVERED write they drove are REMOVED:
// that card type is not in RM's v3 vocabulary.)
//
// The ONLY writer of `card_computed_checks` (migration 162), the store the fr DONE-move guard
// reads (services/done-guard.ts). Liveness never counts toward DONE (George 2026-10-01), so a
// pass here must come from a COMPUTED evaluator — never from a human:
//
//   * AUTH IS A PER-CALLER SERVICE TOKEN, never a user JWT. Same shape as
//     routes/github-app.ts' binding read: dedicated env per caller, read live, constant-time
//     HMAC compare, checked BEFORE the body is read and before any DB access.
//   * `written_by` and the permitted `check_kind`s are DERIVED FROM WHICH TOKEN MATCHED. The
//     body cannot name its writer, and one caller cannot write another's kind. One caller,
//     one kind, one secret. Two callers configured with the SAME token would collapse into
//     one (the first match wins), so that is refused as misconfigured rather than guessed.
//   * A request bearing `Authorization` but no valid token (a human or any portal JWT) is 403
//     `computed_check_writer_required` — explicitly, so "a human tried to write a pass" is a
//     named refusal, not an anonymous 401.
//   * A PASS must carry its computed proof: verify_coding needs `computed_ops_passed >= 1`
//     (AA_CQ_GUARD's own rule), and so does grid_qa_computed (the grid QA leaf: liveness and the
//     judge never count); r10_proof_core needs `isolation === true`. A pass without it is
//     422 `pass_without_computed_evidence`. A 'fail' needs no proof.
//
//   LICENCE DOOR (George 2026-10-10, lib/licence-door.ts): no X-Internal-Token and a
//   licence-shaped bearer → verified via validateAuth (authKind 'licence', else 401). It may
//   write ONLY the n8n-side writers' kinds (LICENCE_CHECK_KINDS / LICENCE_CALLER below, derived
//   from CALLERS, each keeping its writtenBy): verify_coding (n8n.verify-coding) and
//   grid_qa_computed (n8n.grid-qa) — NOT r10_proof_core (it has no writer) nor
//   start_plan_checks (unarmed until U-PS-TOKEN) — and, for EVERY kind, ONLY for a card whose Planka board resolves
//   (resolveCardApprovalTenant(undefined, boardId)) to the licence's tenant, else 403
//   {error:"licence_tenant_mismatch"} before any write. Needs no token env configured.
//   every env unset/blank    -> 503 {error:"computed_check_receiver_unconfigured"}
//   two callers share a token-> 503 {error:"computed_check_receiver_misconfigured"}
//   no token, no bearer      -> 401 {error:"invalid_internal_token"}
//   bearer, no valid token   -> 403 {error:"computed_check_writer_required"}
//   bad JSON / schema        -> 400
//   kind not this caller's   -> 403 {error:"check_kind_not_permitted"}
//   pass without proof       -> 422 {error:"pass_without_computed_evidence"}
//   card type unreadable     -> 503 {error:"card_type_unavailable"} (an outage is never "allowed")
//   kind not allowed for the card's type (lib/computed-kind-table.ts; an empty / absent row
//   allows nothing, a card with no card_type allows nothing)
//                            -> 422 {error:"kind_not_allowed_for_card_type", card_type, check_kind}
//   valid                    -> 201 {row} (append-only INSERT)
//
// The card type is read from the CARD (Planka custom field `card_type`) with the DONE guard's
// own reader (services/done-guard.ts readCardTypeFromPlanka) — the same value the guard will
// filter on, so the receiver can never accept a row the guard would then ignore. It is read
// LAST, after every cheap refusal, so a malformed or unauthorised write costs no Planka call.
//
// ⚠️ Public reachability must be closed at the mesh like the other /api/internal/* routes
// (per-path VirtualService 404) — a gitops change, not this file.

import { z } from 'zod';

import { COMPUTED_CHECK_KINDS, isKindAllowedForCardType } from '../lib/computed-kind-table';
import { insertComputedCheck, type ComputedCheckRow } from '../services/computed-checks';
import { readCardTypeFromPlanka } from '../services/done-guard';
import { jsonResponse } from '../utils/response';
import { timingSafeEqualsHmac } from '../utils/secret-compare';
import { isLicenceDoorRequest, requireLicenceCaller, sameTenant } from '../lib/licence-door';
import { resolveCardApprovalTenant } from './webhooks';

const COMPUTED_CHECK_N8N_TOKEN_ENV = 'FR_COMPUTED_CHECK_N8N_TOKEN';
const COMPUTED_CHECK_GRID_TOKEN_ENV = 'FR_COMPUTED_CHECK_GRID_TOKEN';
/**
 * U-PS-KIND: the start_plan_checks writer's token. UNSET in every environment until U-PS-TOKEN
 * arms the writer — an unset token configures no caller, so the kind is unwritable.
 */
const COMPUTED_CHECK_START_TOKEN_ENV = 'FR_COMPUTED_CHECK_START_TOKEN';
/** The kind whose `pass` evidence rule is not yet defined (U-PS-TOKEN). */
const START_PLAN_CHECKS_KIND = 'start_plan_checks';

/**
 * caller → the SET of check_kinds it may write, each with its derived `written_by`. Exported
 * for the table's kind test. Every caller permits exactly one kind.
 */
export const CALLERS = [
  { env: COMPUTED_CHECK_N8N_TOKEN_ENV, kinds: [{ checkKind: 'verify_coding', writtenBy: 'n8n.verify-coding' }] },
  { env: COMPUTED_CHECK_GRID_TOKEN_ENV, kinds: [{ checkKind: 'grid_qa_computed', writtenBy: 'n8n.grid-qa' }] },
  { env: COMPUTED_CHECK_START_TOKEN_ENV, kinds: [{ checkKind: 'start_plan_checks', writtenBy: 'n8n.start-plan-checks' }] },
] as const;

/** Kinds whose pass is proven by `computed_ops_passed >= 1` (liveness ops never count). */
const OPS_PROVEN_KINDS: ReadonlySet<string> = new Set(['verify_coding', 'grid_qa_computed']);

const BodySchema = z
  .object({
    check_kind: z.enum(COMPUTED_CHECK_KINDS),
    verdict: z.enum(['pass', 'fail']),
    evidence_sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    computed_ops_passed: z.number().int().min(0).optional(),
    isolation: z.boolean().optional(),
  })
  .strict();

function logRefusal(reason: string): void {
  console.warn(`[POST /api/internal/cards/:cardId/computed-checks] refused: ${reason}`);
}

/**
 * The check_kinds the licence door may write: every N8N-SIDE writer (the local-docker conveyor's
 * n8n carries only a licence token, never the per-writer tokens). An ALLOWLIST by kind, so a kind
 * added to CALLERS later is NOT licence-writable until it is named here (fail closed).
 * Deliberately ABSENT:
 *   r10_proof_core     — no writer may write it: the asset-evaluator R10 grader (retired
 *                        2026-11-01) is not an n8n writer;
 *   start_plan_checks  — deliberately unarmed until U-PS-TOKEN defines its pass rule.
 */
const LICENCE_CHECK_KINDS = ['verify_coding', 'grid_qa_computed'] as const;

type CallerKind = (typeof CALLERS)[number]['kinds'][number];

/**
 * G4: the X-Internal-Token door's callers — CALLERS minus every LICENCE_CHECK_KINDS kind (those
 * are licence-only now), and minus any caller left with no kind. Today: the (unarmed)
 * start_plan_checks writer. The n8n / grid token envs therefore configure nothing: their token
 * matches no caller.
 */
const TOKEN_CALLERS: ReadonlyArray<{ readonly env: string; readonly kinds: readonly CallerKind[] }> = CALLERS.map(
  (c) => ({
    env: c.env,
    kinds: (c.kinds as readonly CallerKind[]).filter(
      (k) => !(LICENCE_CHECK_KINDS as readonly string[]).includes(k.checkKind),
    ),
  }),
).filter((c) => c.kinds.length > 0);

/**
 * The licence door's caller, DERIVED from CALLERS: each licence kind keeps its own token
 * caller's `writtenBy` (n8n.verify-coding, n8n.grid-qa). Throws at load if a named kind is
 * missing from CALLERS.
 */
const LICENCE_CALLER: CallerShape = {
  kinds: LICENCE_CHECK_KINDS.map((kind) => {
    const found = CALLERS.flatMap((c): readonly CallerKind[] => c.kinds).find((k) => k.checkKind === kind);
    if (!found) throw new Error(`LICENCE_CHECK_KINDS names ${kind}, which no CALLERS entry writes`);
    return found;
  }),
};
/** Board → tenant for the licence binding (project, else stream). */
const resolveBoardTenant = (boardId: string): Promise<string | null> => resolveCardApprovalTenant(undefined, boardId);

/** Every configured writer token must be distinct, or callers collapse into one. */
function tokensCollide(): boolean {
  const all = TOKEN_CALLERS.map((c) => c.env)
    .map((env) => (process.env[env] ?? '').trim())
    .filter((t) => t.length > 0);
  return new Set(all).size !== all.length;
}

export async function handleInternalComputedCheck(req: Request, cardId: string): Promise<Response> {
  // Licence door first: it never consults the token envs (a local stack has none).
  const licence =
    (req.headers.get('X-Internal-Token') ?? '') === '' && isLicenceDoorRequest(req)
      ? await requireLicenceCaller(req)
      : null;
  if (licence) return handleChecked(req, cardId, LICENCE_CALLER, licence.tenantId);

  const configured = TOKEN_CALLERS.map((c) => ({ ...c, expected: (process.env[c.env] ?? '').trim() })).filter(
    (c) => c.expected.length > 0,
  );
  if (configured.length === 0) {
    logRefusal('unconfigured');
    return jsonResponse({ error: 'computed_check_receiver_unconfigured' }, 503);
  }
  if (tokensCollide()) {
    logRefusal('duplicate_caller_token');
    return jsonResponse({ error: 'computed_check_receiver_misconfigured' }, 503);
  }
  const presented = req.headers.get('X-Internal-Token') ?? '';
  // Run every compare (no early exit) so which caller matched is not timeable.
  let caller: (typeof configured)[number] | null = null;
  for (const c of configured) {
    const ok = timingSafeEqualsHmac(presented, c.expected);
    if (ok && presented && !caller) caller = c;
  }
  if (!caller) {
    const bearer = (req.headers.get('Authorization') ?? '').trim();
    if (bearer) {
      logRefusal('bearer_without_service_token');
      return jsonResponse(
        {
          error: 'computed_check_writer_required',
          message:
            'Only a computed evaluator (service token) may record a computed check; a user token never can.',
        },
        403,
      );
    }
    logRefusal('bad_token');
    return jsonResponse({ error: 'invalid_internal_token' }, 401);
  }
  return handleChecked(req, cardId, caller, null);
}

/** What `handleChecked` reads of a caller: its permitted kinds (a token caller, or LICENCE_CALLER). */
type CallerShape = { readonly kinds: ReadonlyArray<{ readonly checkKind: string; readonly writtenBy: string }> };

/**
 * Licence door: the card must sit on a board of the licence's tenant. Unknown board,
 * untenanted board and foreign board all read the same 403, before any write. Applies to
 * EVERY kind the licence caller may write. Null ⇒ bound.
 */
async function licenceBoardRefusal(cardBoardId: string | undefined, licenceTenant: string): Promise<Response | null> {
  const boardTenant = cardBoardId ? await resolveBoardTenant(String(cardBoardId)) : null;
  if (sameTenant(boardTenant, licenceTenant)) return null;
  logRefusal('licence_tenant_mismatch');
  return jsonResponse(
    {
      error: 'licence_tenant_mismatch',
      message: "this card is not on a board of the licence's tenant; nothing was written",
    },
    403,
  );
}

/**
 * Everything after authentication — ONE body for both doors. `licenceTenant` non-null ⇒ the
 * licence door: the card's board must resolve to that tenant before any write.
 */
async function handleChecked(
  req: Request,
  cardId: string,
  caller: CallerShape,
  licenceTenant: string | null,
): Promise<Response> {
  if (!cardId || cardId.length > 64) return jsonResponse({ error: 'invalid_card_id' }, 400);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_payload', message: parsed.error.message }, 400);
  }
  const body = parsed.data;
  const permitted = caller.kinds.find((k) => k.checkKind === body.check_kind);
  if (!permitted) {
    logRefusal(`kind_not_permitted:${caller.kinds[0]?.writtenBy ?? 'none'}:${body.check_kind}`);
    return jsonResponse({ error: 'check_kind_not_permitted', check_kind: body.check_kind }, 403);
  }
  // Licence door: bind the card's board to the licence tenant BEFORE any kind-specific check.
  // The card read is CARRIED (not repeated) into the table check below: one Planka read per
  // request on either door.
  let preRead: { cardType: string | null; boardId?: string } | null = null;
  if (licenceTenant !== null) {
    try {
      preRead = await readCardTypeFromPlanka(cardId);
    } catch (err) {
      return cardTypeUnavailable(err);
    }
    const refused = await licenceBoardRefusal(preRead.boardId, licenceTenant);
    if (refused) return refused;
  }
  if (body.check_kind === START_PLAN_CHECKS_KIND && body.verdict === 'pass') {
    // FAIL CLOSED until U-PS-TOKEN defines what proves a start_plan_checks pass (the S4 check
    // function re-run against the approved outline + analysis_hash). Without that rule a
    // token holder could assert a pass with nothing behind it.
    logRefusal('start_plan_checks_pass_unarmed');
    return jsonResponse(
      {
        error: 'pass_without_computed_evidence',
        message: 'a start_plan_checks pass has no evidence rule yet (U-PS-TOKEN); only fail is recorded',
      },
      422,
    );
  } else if (body.verdict === 'pass') {
    const opsProven = OPS_PROVEN_KINDS.has(body.check_kind);
    const proven = opsProven ? (body.computed_ops_passed ?? 0) >= 1 : body.isolation === true;
    if (!proven) {
      return jsonResponse(
        {
          error: 'pass_without_computed_evidence',
          message:
            opsProven
              ? `a ${body.check_kind} pass needs computed_ops_passed >= 1 (liveness ops never count)`
              : 'an r10_proof_core pass needs isolation: true',
        },
        422,
      );
    }
  }

  let cardType: string | null;
  let cardBoardId: string | undefined;
  try {
    ({ cardType, boardId: cardBoardId } = preRead ?? (await readCardTypeFromPlanka(cardId)));
  } catch (err) {
    return cardTypeUnavailable(err);
  }
  if (licenceTenant !== null) {
    const refused = await licenceBoardRefusal(cardBoardId, licenceTenant);
    if (refused) return refused;
  }
  if (!isKindAllowedForCardType(cardType, body.check_kind)) {
    logRefusal(`kind_not_allowed_for_card_type:${cardType}:${body.check_kind}`);
    return jsonResponse(
      { error: 'kind_not_allowed_for_card_type', card_type: cardType, check_kind: body.check_kind },
      422,
    );
  }

  const row: ComputedCheckRow = await insertComputedCheck({
    cardId,
    checkKind: body.check_kind,
    verdict: body.verdict,
    evidenceSha: body.evidence_sha,
    writtenBy: permitted.writtenBy,
  });
  return jsonResponse(row, 201);
}

function cardTypeUnavailable(err: unknown): Response {
  logRefusal(`card_type_unavailable:${err instanceof Error ? err.message : String(err)}`);
  return jsonResponse(
    {
      error: 'card_type_unavailable',
      message: "The card's card_type could not be read, so fr cannot tell whether this kind counts for it. Retry; nothing was written.",
    },
    503,
  );
}
