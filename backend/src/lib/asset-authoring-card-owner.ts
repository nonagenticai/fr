// src/lib/asset-authoring-card-owner.ts
//
// fr#1437 (5) — who OWNS the card a `POST /api/asset-authoring/publish` acts for.
// Design: ~/.claude/plans/program/20-designs/fr1437-5-asset-authoring-customer-card-DESIGN.md
// (option B).
//
// WHY. publish.ts writes the asset into `ctxTenantId(user.tenantId)`. The
// conveyor's asset_loop calls it as `system-workflow-operator`, whose token
// tenant is the SYSTEM tenant, with `card_id` = the Planka card id. So every
// asset lands in the system tenant whatever the card's tenant is — for a
// CUSTOMER card that breaks the strict system/customer separation. Latent
// today (0 publish calls in 30 days).
//
// THE VERDICT (closed set):
//   - `no_card`         — card_id absent / empty / not a Planka id shape;
//   - `platform_card`   — the card's board owner is a platform tenant;
//   - `customer_card`   — the owner resolves and is NOT a platform tenant;
//   - `card_unresolved` — no owner (Planka miss, unowned board, resolver error).
// Owner resolution is the card → board → `resolveBoardTenant` hop
// (`plankaCardBoardId` + `plankaBoardOwnerTenant`, below).
//
// ENFORCED, unconditionally (fr#1448): every verdict is counted
// (`fr_asset_authoring_card_owner_total{verdict,caller_kind}`) with a capped,
// deduped `[asset-authoring-card-owner]` line naming who, and then
// `customer_card` ⇒ 403 `asset_authoring_customer_card_refused`,
// `card_unresolved` (incl. a resolver error) ⇒ 403
// `asset_authoring_card_unresolved`. `no_card` and `platform_card` pass.
//
// ⛔ ACCEPTED LIMIT — customer cards cannot use asset authoring until per-tenant
// operator identity exists (ncn#2032). Option A (write into the card's tenant)
// is REJECTED: it makes the operator a writer for any tenant chosen by a card id
// it supplies — the rm#187 class.
//
// Labels are closed sets; no uuid or id is ever a label (log fields only).

import { isPlatformTenant } from '../middleware/internal-tenant-only';
import { ForbiddenError } from '../utils/errors';
import type { User } from '../types/api';
import { isPlankaIdShape } from './planka-id-shape';
import { systemOperatorSubsInEffect } from './sa-tenant-from-sub';

// The card → board → tenant hop. Same card→board read
// `assertCardTenantAuthorized` does (admin agent). Imported lazily: the Planka
// client and the db layer are heavy and this module is loaded by metrics.ts.
export async function plankaCardBoardId(cardId: string): Promise<string | null> {
  const { plankaAsAgent } = await import('../services/planka/with-auth');
  const card = await plankaAsAgent().cards.get(cardId);
  return card.item?.boardId ?? null;
}

// `resolveBoardTenant` — the single source of truth for board→tenant.
export async function plankaBoardOwnerTenant(boardId: string): Promise<string | null> {
  const { resolveBoardTenant } = await import('./board-tenant-access');
  return resolveBoardTenant(boardId);
}

// ── closed sets ─────────────────────────────────────────────────────────────

export const ASSET_AUTHORING_CARD_OWNER_VERDICTS = [
  'platform_card',
  'customer_card',
  'card_unresolved',
  'no_card',
] as const;
export type AssetAuthoringCardOwnerVerdict = (typeof ASSET_AUTHORING_CARD_OWNER_VERDICTS)[number];

export const ASSET_AUTHORING_CALLER_KINDS = [
  /** a listed FR_SYSTEM_OPERATOR_SUBS password-grant operator (lib/sa-tenant-from-sub.ts). */
  'system_operator_user',
  /** a client-credentials token (`isServiceAccountClaims`, carried as `user.isServiceAccount`). */
  'service_account',
  /** everyone else. */
  'human',
] as const;
export type AssetAuthoringCallerKind = (typeof ASSET_AUTHORING_CALLER_KINDS)[number];

export const ASSET_AUTHORING_CARD_OWNER_REFUSAL_CODES = {
  customer_card: 'asset_authoring_customer_card_refused',
  card_unresolved: 'asset_authoring_card_unresolved',
} as const;

// ── the classifiers (pure) ──────────────────────────────────────────────────

/**
 * Pure: the verdict for one publish.
 *   - cardId absent / empty / non-digit → no_card
 *   - owner null                        → card_unresolved
 *   - isPlatformTenant(owner)           → platform_card
 *   - else                              → customer_card
 */
export function classifyPublishCardOwner(args: {
  cardId: string | undefined;
  owner: string | null;
}): AssetAuthoringCardOwnerVerdict {
  if (!isPlankaIdShape(args.cardId?.trim())) return 'no_card';
  if (args.owner === null || args.owner.trim() === '') return 'card_unresolved';
  return isPlatformTenant(args.owner.trim().toLowerCase()) ? 'platform_card' : 'customer_card';
}

/**
 * Pure: the caller's kind. `user.isServiceAccount` is `isServiceAccountClaims`
 * over the VERIFIED claims (services/keycloak.ts validateToken); the operator
 * list is the one lib/sa-tenant-from-sub.ts parsed from FR_SYSTEM_OPERATOR_SUBS.
 */
export function classifyPublishCallerKind(
  user: Pick<User, 'id' | 'isServiceAccount'>,
  operatorSubs: readonly string[] = systemOperatorSubsInEffect(),
): AssetAuthoringCallerKind {
  if (user.isServiceAccount === true) return 'service_account';
  const sub = typeof user.id === 'string' ? user.id.trim().toLowerCase() : '';
  if (sub !== '' && operatorSubs.includes(sub)) return 'system_operator_user';
  return 'human';
}

// ── metrics + log ───────────────────────────────────────────────────────────

/** The stable log tag. Grep / Loki-query this, never the free-text message. */
export const ASSET_AUTHORING_CARD_OWNER_TAG = '[asset-authoring-card-owner]';

const ownerTotal = new Map<string, number>();
function zeroCardOwnerCounters(): void {
  ownerTotal.clear();
  for (const v of ASSET_AUTHORING_CARD_OWNER_VERDICTS) {
    for (const k of ASSET_AUTHORING_CALLER_KINDS) ownerTotal.set(`${v}|${k}`, 0);
  }
}
zeroCardOwnerCounters();

// One line per distinct (verdict, caller, card, owner, writer, card_type),
// capped. The COUNTER is never deduped.
const LOG_CAP = 500;
const loggedKeys = new Set<string>();

function shouldLog(verdict: AssetAuthoringCardOwnerVerdict, callerKind: AssetAuthoringCallerKind): boolean {
  if (verdict === 'customer_card' || verdict === 'card_unresolved') return true;
  return verdict === 'no_card' && callerKind !== 'human';
}

function record(args: {
  verdict: AssetAuthoringCardOwnerVerdict;
  callerKind: AssetAuthoringCallerKind;
  cardId: string | undefined;
  owner: string | null;
  writerTenant: string;
  cardType: string;
  resolverError: boolean;
}): void {
  const key = `${args.verdict}|${args.callerKind}`;
  ownerTotal.set(key, (ownerTotal.get(key) ?? 0) + 1);
  if (!shouldLog(args.verdict, args.callerKind)) return;
  try {
    const logKey = `${key}|${args.cardId ?? ''}|${args.owner ?? ''}|${args.writerTenant}|${args.cardType}`;
    if (loggedKeys.has(logKey) || loggedKeys.size >= LOG_CAP) return;
    loggedKeys.add(logKey);
    console.warn(
      ASSET_AUTHORING_CARD_OWNER_TAG,
      JSON.stringify({
        event: 'asset_authoring_card_owner',
        verdict: args.verdict,
        caller_kind: args.callerKind,
        card_id: args.cardId ?? null,
        owner_tenant_id: args.owner,
        writer_tenant_id: args.writerTenant,
        card_type: args.cardType,
        resolver_error: args.resolverError,
      }),
    );
  } catch {
    // The counter already moved; a broken logger must not fail the request.
  }
}

/** Prometheus text-exposition lines. Rendered by routes/metrics.ts. */
export function renderAssetAuthoringCardOwnerMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_asset_authoring_card_owner_total POST /api/asset-authoring/publish calls, by who owns the card_id they act for and the caller kind (fr#1437 (5)). customer_card / card_unresolved are refused 403; see the [asset-authoring-card-owner] log line for which card.',
    '# TYPE fr_asset_authoring_card_owner_total counter',
  ];
  for (const v of ASSET_AUTHORING_CARD_OWNER_VERDICTS) {
    for (const k of ASSET_AUTHORING_CALLER_KINDS) {
      lines.push(
        `fr_asset_authoring_card_owner_total{verdict="${v}",caller_kind="${k}"} ${ownerTotal.get(`${v}|${k}`) ?? 0}`,
      );
    }
  }
  return lines;
}

// ── the check ────────────────────────────────────────────────────────────

function refusal(verdict: AssetAuthoringCardOwnerVerdict): ForbiddenError | null {
  switch (verdict) {
    case 'platform_card':
    case 'no_card':
      return null;
    case 'customer_card':
      return new ForbiddenError(
        'Asset authoring is not available for a card owned by a customer tenant',
      ).withCode(ASSET_AUTHORING_CARD_OWNER_REFUSAL_CODES.customer_card);
    case 'card_unresolved':
      return new ForbiddenError(
        'The owner of the card this publish acts for could not be resolved',
      ).withCode(ASSET_AUTHORING_CARD_OWNER_REFUSAL_CODES.card_unresolved);
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

/**
 * Classify, count and ENFORCE the card owner of one publish: `customer_card`
 * and `card_unresolved` (a resolver error included) throw a 403
 * ForbiddenError; `no_card` and `platform_card` return their verdict.
 */
export async function assertPublishCardOwner(
  args: {
    cardId: string | undefined;
    cardType: string;
    user: Pick<User, 'id' | 'isServiceAccount'>;
    /** The tenant publish.ts will write into (`ctxTenantId(user.tenantId)`). */
    writerTenant: string;
  },
): Promise<AssetAuthoringCardOwnerVerdict> {
  const cardId = typeof args.cardId === 'string' ? args.cardId.trim() : undefined;
  let owner: string | null = null;
  let resolverError = false;
  if (isPlankaIdShape(cardId)) {
    try {
      const boardId = await plankaCardBoardId(cardId);
      owner = boardId ? await plankaBoardOwnerTenant(boardId) : null;
    } catch {
      owner = null;
      resolverError = true;
    }
  }

  const verdict = classifyPublishCardOwner({ cardId, owner });
  let callerKind: AssetAuthoringCallerKind = 'human';
  try {
    callerKind = classifyPublishCallerKind(args.user);
  } catch {
    callerKind = 'human';
  }

  record({
    verdict,
    callerKind,
    cardId: args.cardId,
    owner,
    writerTenant: args.writerTenant,
    cardType: args.cardType,
    resolverError,
  });

  const err = refusal(verdict);
  if (err) throw err;
  return verdict;
}
