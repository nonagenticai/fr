// src/services/kata-andon.ts
//
// The kata's hold on the conveyor n8n instance (George 2026-11-03).
//
// A kata runs entirely on its own n8n (kata-n8n). While it runs, the WHOLE conveyor n8n stops:
// the kata pulls the same instance cord the operator pulls (`n8n/n8n-worker` → 0,
// lib/k8s-scale.ts), but as one holder in a SET. `andon_state.kata_holders` (migration 225) is
// that set of kata project ids: a kata joins it (array_append when absent) and leaves it
// (array_remove). The worker comes back to 1 only when NOBODY holds — neither the operator
// (`andon_state.engaged`) nor any kata. The decision is in routes/andon.ts
// (`joinKataCordWith` / `leaveKataCordWith` / `handleDisengageAndon`); this module only writes
// the set. A kata never touches the operator's flag, and the operator's release never
// empties the set.
import { sql } from 'drizzle-orm';

import { db as defaultDb } from '../db/client';
import { isUuidShape } from '../lib/uuid-shape';
import { AppError } from '../utils/errors';
import { readKataHolders } from './project-andon';

type Db = Pick<typeof defaultDb, 'execute' | 'select'>;

/** Join the holder set. Idempotent: an existing holder stays one entry. */
export async function joinSystemKataAndon(kataId: string, database: Db = defaultDb): Promise<string[]> {
  if (!isUuidShape(kataId)) return await readKataHolders(database);
  await database.execute(sql`
    UPDATE andon_state
       SET kata_holders = array_append(kata_holders, ${kataId}::uuid)
     WHERE id = 1 AND NOT (${kataId}::uuid = ANY(kata_holders))
  `);
  const holders = await readKataHolders(database);
  // No andon_state singleton (migration 065's row): nothing could be held — say so, never a quiet
  // 200. (A holder set without this kata but with a row means a break-glass clear raced the join.)
  if (!holders.includes(kataId.toLowerCase()) && !(await andonStateExists(database))) {
    throw new AppError(503, "The andon state is missing, so the kata's hold could not be recorded; nothing changed").withCode(
      'andon_state_missing',
    );
  }
  return holders;
}

/** Leave the holder set: only this kata's own entry; others keep holding. */
export async function leaveSystemKataAndon(kataId: string, database: Db = defaultDb): Promise<{ released: boolean; holders: string[] }> {
  if (!isUuidShape(kataId)) return { released: false, holders: await readKataHolders(database) };
  const rows = (await database.execute(sql`
    UPDATE andon_state
       SET kata_holders = array_remove(kata_holders, ${kataId}::uuid)
     WHERE id = 1 AND ${kataId}::uuid = ANY(kata_holders)
    RETURNING id
  `)) as unknown as unknown[];
  return { released: Array.isArray(rows) && rows.length === 1, holders: await readKataHolders(database) };
}

async function andonStateExists(database: Db): Promise<boolean> {
  const rows = (await database.execute(sql`SELECT 1 FROM andon_state WHERE id = 1`)) as unknown as unknown[];
  return Array.isArray(rows) && rows.length === 1;
}

/**
 * Remove every holder with no `katas` row that holds (an orphan: nothing will ever release it).
 * A row holds while running | qa, or FAILED and not yet released by a super-admin (George
 * 2026-11-04: a failed kata is never pruned — only the super-admin Release frees it). Returns the
 * removed ids (lower-case). Run inside the operator's release, under the instance-cord lock.
 */
export async function pruneOrphanKataHolders(database: Db = defaultDb): Promise<string[]> {
  const rows = (await database.execute(sql`
    WITH cur AS (SELECT kata_holders FROM andon_state WHERE id = 1 FOR UPDATE),
         orphan AS (
           SELECT h FROM cur, unnest(cur.kata_holders) AS h
            WHERE NOT EXISTS (
                     SELECT 1 FROM katas k
                      WHERE k.id = h
                        AND (k.state IN ('running', 'qa') OR (k.state = 'failed' AND k.cord_released_at IS NULL))
                   )
         ),
         upd AS (
           UPDATE andon_state
              SET kata_holders = ARRAY(SELECT x FROM unnest(kata_holders) AS x WHERE x NOT IN (SELECT h FROM orphan))
            WHERE id = 1 AND EXISTS (SELECT 1 FROM orphan)
           RETURNING id
         )
    SELECT h::text AS id FROM orphan
  `)) as unknown as Array<{ id: string }>;
  return rows.map((r) => String(r.id).toLowerCase());
}
