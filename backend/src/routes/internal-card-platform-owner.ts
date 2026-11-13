// routes/internal-card-platform-owner.ts
//
//   GET /api/internal/cards/:cardId/platform-owner
//       X-Internal-Token == FR_WM_CARD_LOOKUP_TOKEN
//
// worker_management#336: a prompt release (CANARY/PUBLISHED) names an
// `actor_card_id`, and WM must verify that card EXISTS and is owned by a
// PLATFORM tenant before it writes the transition. fr is the source of truth for
// card -> board -> tenant, so WM asks fr ONE narrow question about ONE card.
// Design: ~/.claude/plans/program/50-audits-evidence/wm336-design-1004.md.
//
// AUTH — one caller, one secret. Same shape as the billing tenant-map
// (routes/internal-projects-tenant-map.ts) and the coding-github binding lookup:
// a DEDICATED env only worker_management holds, read live, never shared. Like
// those routes it does NOT call validateAuth — fr has no global auth middleware
// (each handler authenticates itself), so a portal user session's bearer is
// simply ignored here: the ONLY credential this route accepts is the caller
// token. Public reachability is closed at the mesh (VS 404 directResponse for
// /api/internal/cards/ on the three fr VirtualServices — gitops PR).
//
//   env unset/empty                  -> 503 {error:"card_lookup_unconfigured"}
//                                       (the route is inert until configured)
//   token missing / wrong / any len  -> 404 NOT_FOUND   (coordinator ruling: a
//                                       bad token is indistinguishable from a
//                                       missing card)
//   cardId not ^[0-9]{19}$            -> 404 NOT_FOUND   (no reflection)
//   Planka 404 / card has no board    -> 404 NOT_FOUND
//   board not fr-owned (null tenant)  -> 404 NOT_FOUND
//   tenant not in PLATFORM_TENANT_IDS -> 404 NOT_FOUND   (customer card: never
//                                       disclose that it exists)
//   Planka / DB error or timeout      -> 503 {error:"card_lookup_unavailable"}
//                                       (an outage must not read as "no such
//                                       card"; WM maps it to 503 unverifiable).
//                                       Uniform: a missing card still runs the
//                                       tenant resolver (sentinel board), so a
//                                       DB outage is 503 whether or not the
//                                       card exists, and the paths cost alike.
//   platform card                     -> 200 {card_id, tenant_id, platform:true}
//
// Every 404 is the SAME body. The refusal reason is logged server-side only;
// the token is never logged.
//
// The token compare is `timingSafeEqualsHmac`: HMAC both sides to fixed-length
// digests, then `timingSafeEqual` — no early exit on a length mismatch, so the
// secret's length is not probeable either.

import { PlankaClient } from '../services/planka';
import { PlankaError } from '../services/planka/errors';
import { resolveBoardTenant } from '../lib/board-tenant-access';
import { isPlatformTenant } from './assets/_lib/system-union';
import { jsonResponse } from '../utils/response';
import { timingSafeEqualsHmac } from '../utils/secret-compare';

const WM_CARD_LOOKUP_TOKEN_ENV = 'FR_WM_CARD_LOOKUP_TOKEN';

const CARD_ID_RE = /^[0-9]{19}$/;

/** The ONE refusal body. Bad token, malformed id, missing card, customer card
 * and unattributable board all return exactly this — no `card_id` echo. */
const NOT_FOUND_BODY = { error: 'card_not_found' } as const;

/** The raw Planka read: GET /api/cards/:id via the Planka ADMIN agent (same read
 * as routes/cards/get.ts); throws PlankaError on a non-2xx. */
async function plankaGetCard(cardId: string): Promise<unknown> {
  const planka = PlankaClient.fromConfig().asAgent();
  return planka.http.request('GET', `/api/cards/${encodeURIComponent(cardId)}`, {});
}

/** Card -> boardId. Returns null ONLY when Planka says 404 (or the card carries
 * no board); re-throws every other failure (5xx, network, auth, timeout) so the
 * handler answers 503 — an outage must never read as "no such card". */
async function plankaFetchCardBoardId(cardId: string): Promise<string | null> {
  try {
    const card = (await plankaGetCard(cardId)) as { item?: { boardId?: unknown } } | null;
    const boardId = card?.item?.boardId;
    return typeof boardId === 'string' && boardId !== '' ? boardId : null;
  } catch (e) {
    if (e instanceof PlankaError && e.status === 404) return null;
    throw e;
  }
}

/** A board id no Planka board can carry (Planka ids are non-zero snowflakes).
 * The missing-card path resolves THIS board so it does the same DB work, and
 * meets the same DB outage, as an existing card's path. Its result is discarded. */
const MISSING_CARD_SENTINEL_BOARD = '0000000000000000000';

function logRefusal(reason: string): void {
  console.warn(`[GET /api/internal/cards/:cardId/platform-owner] refused: ${reason}`);
}

/** Read LIVE (not a config snapshot), same as the tenant-map route. */
function expectedToken(): string {
  return (process.env[WM_CARD_LOOKUP_TOKEN_ENV] ?? '').trim();
}

function notFound(reason: string): Response {
  logRefusal(reason);
  return jsonResponse(NOT_FOUND_BODY, 404);
}

export async function handleGetCardPlatformOwner(
  req: Request,
  cardId: string,
): Promise<Response> {
  const expected = expectedToken();
  if (!expected) {
    logRefusal('unconfigured');
    return jsonResponse({ error: 'card_lookup_unconfigured' }, 503);
  }
  const presented = req.headers.get('X-Internal-Token') ?? '';
  // Always run the constant-time compare, even for an absent header, so the
  // absent and wrong cases take the same path.
  const tokenOk = timingSafeEqualsHmac(presented, expected);
  if (!presented || !tokenOk) return notFound('bad_token');

  if (!CARD_ID_RE.test(cardId)) return notFound('malformed_card_id');

  // Resolve EVERY dependency's error state BEFORE branching on existence, and
  // make the missing-card path do the same work as an existing card's: it runs
  // the tenant resolver against a sentinel board and discards the result. So a
  // token holder sees neither a latency gap nor a 404-vs-503 split between
  // "missing" and "exists but customer" — during a DB outage BOTH are 503.
  let boardId: string | null;
  let tenant: string | null;
  try {
    boardId = await plankaFetchCardBoardId(cardId);
    tenant = await resolveBoardTenant(boardId ?? MISSING_CARD_SENTINEL_BOARD);
  } catch (e) {
    console.error('[GET /api/internal/cards/:cardId/platform-owner] card lookup failed', e);
    return jsonResponse({ error: 'card_lookup_unavailable' }, 503);
  }
  if (!boardId) return notFound('card_missing');
  if (!tenant) return notFound('board_unattributable');
  if (!isPlatformTenant(tenant)) return notFound('not_platform_tenant');

  return jsonResponse({ card_id: cardId, tenant_id: tenant, platform: true });
}
