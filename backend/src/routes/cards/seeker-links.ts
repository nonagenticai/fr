// src/routes/cards/seeker-links.ts
//
// Plan 6 Wave D — POST /api/cards/:cardId/seeker-links
//
// n8n's `ActionWriteSeekerLinks` step (ready-prefetch.json, runs after
// the Gaps worker) POSTs the entity-list it computed against the card
// context. Each row lands in `card_seeker_links` (migration 063) and is
// surfaced by GET /api/cards/:cardId under the `kag_seeker` field —
// closing the W-1 stub at cards/get.ts:303-308 (the Seeker half of the
// compounding-memory loop the trilogy plan demos).
//
// Idempotent on (card_id, kag_entity_id): ON CONFLICT updates score +
// created_at so a retried n8n step does not double-insert or stale-fill.
//
// Auth: authenticated AND tenant-authorized. `validateAuth` alone is NOT
// enough — the row is keyed on the attacker-controllable `cardId` and the
// write goes straight to the DB with the admin connection (no Planka
// board-membership check), so any authed user in any tenant could otherwise
// poison `kag_seeker[]` on ANY card. We therefore fetch the card with the
// ADMIN Planka agent (existence check), resolve its owning tenant
// (board → project/stream, the SAME resolver the read gate uses) and
// require it to equal the caller's tenant — fail-closed to 404 otherwise.
//
// This does NOT "lock Seeker to one tenant": the gate locks to the CALLER'S
// tenant (execution included), exactly like the live write
// `POST /api/cards/improvement`. The n8n Seeker step authenticates AS the
// card's tenant (the Fr-node `bearerTokenOverride`/`tenantIdOverride` mint a
// per-tenant token), so legit execution-tenant writes pass via equality.
// Stricter than the GET read gate on purpose: GET keeps internal/system
// framework cards readable cross-tenant (the UI renders shared framework
// cards) — a WRITE has no such legit cross-tenant path.

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db as defaultDb, cardSeekerLinks } from '../../db/client';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { UnauthorizedError } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import { clientSafeCaughtErrorText } from '../../integrations/_lib/errors';
import { PlankaClient } from '../../services/planka';
import { PlankaError } from '../../services/planka/errors';
import { loadCardTenantByBoardId } from './get';

// Minimal shape of the Planka card-detail response — we only need the
// board id to resolve the card's owning tenant.
interface CardItem {
  item: { boardId: string };
}

const linkEntrySchema = z.object({
  kag_entity_id: z.string().uuid(),
  score: z.number().finite().optional(),
});

const writeSchema = z.object({
  links: z.array(linkEntrySchema).max(500),
});

function authErrorToResponse(e: unknown): Response {
  const code = (e as { code?: string }).code;
  const isJoseAuthError = typeof code === 'string' && code.startsWith('ERR_JWT_');
  if (e instanceof UnauthorizedError || isJoseAuthError) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  throw e;
}

async function insertLinksToDb(
  cardId: string,
  rows: { kag_entity_id: string; score: number | null }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map((r) => ({
    card_id: cardId,
    kag_entity_id: r.kag_entity_id,
    score: r.score,
  }));
  // ON CONFLICT (card_id, kag_entity_id) DO UPDATE — refreshes score +
  // created_at on retries. drizzle's setWhere is excluded.* so the row
  // reflects the latest payload from n8n.
  await defaultDb
    .insert(cardSeekerLinks)
    .values(values)
    .onConflictDoUpdate({
      target: [cardSeekerLinks.card_id, cardSeekerLinks.kag_entity_id],
      set: {
        score: sql`excluded.score`,
        created_at: sql`now()`,
      },
    });
  return rows.length;
}

export async function handleWriteSeekerLinks(
  req: Request,
  cardId: string,
): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }

  if (!cardId) {
    return jsonResponse({ error: 'card_id_required' }, 400);
  }

  // ── Cross-tenant write gate ───────────────────────────────────────────
  // Fetch the card with the ADMIN Planka agent purely to (a) confirm it
  // exists and (b) get its boardId so we can resolve its owning tenant.
  // Resolve via the SAME chain the read gate uses, then require the card's
  // tenant to equal the caller's tenant. Fail-closed: a foreign tenant, an
  // un-attributable board, or a lookup error all 404 — identical to "card
  // not found" so a foreign id leaks nothing.
  const planka = PlankaClient.fromConfig().asAgent();
  let card: CardItem;
  try {
    card = (await planka.http.request(
      'GET',
      `/api/cards/${encodeURIComponent(cardId)}`,
      {},
    )) as CardItem;
  } catch (e) {
    if (e instanceof PlankaError && e.status === 404) {
      return jsonResponse({ error: 'card_not_found', card_id: cardId }, 404);
    }
    throw e;
  }
  const boardId = card.item.boardId;
  const loadTenant = (id: string) => loadCardTenantByBoardId(id);
  let tenant: string | null;
  try {
    tenant = await loadTenant(boardId);
  } catch (e) {
    console.error(
      '[POST /api/cards/:id/seeker-links] tenant gate lookup failed',
      e,
    );
    return jsonResponse({ error: 'card_not_found', card_id: cardId }, 404);
  }
  if (tenant !== ctxTenantId(user.tenantId)) {
    return jsonResponse({ error: 'card_not_found', card_id: cardId }, 404);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  let parsed: z.infer<typeof writeSchema>;
  try {
    parsed = writeSchema.parse(body);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return jsonResponse(
        { error: 'validation_failed', issues: e.issues },
        400,
      );
    }
    return jsonResponse(
      { error: 'validation_failed', issues: [{ message: String(e) }] },
      400,
    );
  }

  const rows = parsed.links.map((l) => ({
    kag_entity_id: l.kag_entity_id,
    score: l.score ?? null,
  }));

  try {
    const written = await insertLinksToDb(cardId, rows);
    return jsonResponse({ card_id: cardId, written }, 200);
  } catch (e) {
    console.error('[POST /api/cards/:id/seeker-links] insert failed', e);
    return jsonResponse(
      {
        error: 'seeker_links_insert_failed',
        // Raw Postgres text (constraint/table names) for super-admins only;
        // the full error is on the log line above.
        detail: clientSafeCaughtErrorText(e, 'insert failed'),
      },
      500,
    );
  }
}
