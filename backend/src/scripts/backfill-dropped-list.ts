// src/scripts/backfill-dropped-list.ts
//
// Adds the NON-DONE terminal `DROPPED` list (domain/engagement/proof-subset.ts
// DROPPED_LIST_NAME; RM default board template, services/catalogue/board-template.ts) to every EXISTING board fr
// knows (streams + projects planka_board_id). New boards get it at creation.
//
// Measured 2026-10-05 (kanban DB on worker4, BEGIN READ ONLY): 26 boards carry the six
// active lists TODO/READY/DOING/QA/BLOCKED/DONE; none has a DROPPED list. ncn's receiver
// must not route a DROP to DROPPED on a board that lacks it — run this (apply) BEFORE the
// ncn DROP re-target is armed.
//
//   bun run src/scripts/backfill-dropped-list.ts            # DRY-RUN (default): reports only
//   bun run src/scripts/backfill-dropped-list.ts --apply    # creates the missing lists
//
// Idempotent: a board that already has an active list named DROPPED is `ok`. The list is
// appended AFTER the board's last active list. A board 404 is skipped, anything else is an
// error (exit 1).

import { db } from '../db/client';
import { streams, projects } from '../db/schema';
import { PlankaClient } from '../services/planka';
import { DROPPED_LIST_NAME } from '../domain/engagement/proof-subset';
import { PlankaNotFoundError } from '../services/planka/errors';

/**
 * True only for Planka's 404 on the board read. That means "gone OR not
 * visible to this caller" — NOT proof of absence; only good for skipping.
 * Matched on the typed error / HTTP status, never on message text, so a 5xx or
 * auth failure whose message happens to say "not found" stays an error.
 */
export function isBoard404Error(err: unknown): boolean {
  if (err instanceof PlankaNotFoundError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'PlankaNotFoundError' &&
    (err as { status?: unknown }).status === 404
  );
}

export interface BoardList {
  name: string | null;
  position?: number | null;
  type?: string | null;
}

export interface BackfillDroppedOpts {
  apply: boolean;
  loadBoardIds: () => Promise<string[]>;
  listBoardLists: (boardId: string) => Promise<BoardList[]>;
  createList: (boardId: string, name: string, position: number) => Promise<void>;
}

export interface BackfillDroppedSummary {
  total: number;
  ok: number;
  added: number;
  would_add: number;
  skipped_board_404: number;
  errors: number;
}

/** Pure: does the board need the list, and at which position? */
export function planDroppedList(lists: readonly BoardList[]): { needed: boolean; position: number } {
  const active = lists.filter((l) => (l.type ?? 'active') === 'active' && typeof l.name === 'string');
  if (active.some((l) => l.name!.trim().toUpperCase() === DROPPED_LIST_NAME)) {
    return { needed: false, position: 0 };
  }
  const maxPos = active.reduce((m, l) => Math.max(m, typeof l.position === 'number' ? l.position : 0), 0);
  return { needed: true, position: maxPos + 65536 };
}

export async function runBackfillDropped(opts: BackfillDroppedOpts): Promise<BackfillDroppedSummary> {
  const log = (m: string) => console.log(m);
  const s: BackfillDroppedSummary = { total: 0, ok: 0, added: 0, would_add: 0, skipped_board_404: 0, errors: 0 };
  for (const boardId of await opts.loadBoardIds()) {
    s.total += 1;
    try {
      const plan = planDroppedList(await opts.listBoardLists(boardId));
      if (!plan.needed) {
        s.ok += 1;
        continue;
      }
      if (!opts.apply) {
        s.would_add += 1;
        log(`[dry-run] board ${boardId}: would add ${DROPPED_LIST_NAME} at position ${plan.position}`);
        continue;
      }
      await opts.createList(boardId, DROPPED_LIST_NAME, plan.position);
      s.added += 1;
      log(`[apply] board ${boardId}: added ${DROPPED_LIST_NAME} at position ${plan.position}`);
    } catch (err) {
      if (isBoard404Error(err)) {
        s.skipped_board_404 += 1;
        log(`[skip] board ${boardId}: 404`);
        continue;
      }
      s.errors += 1;
      log(`[error] board ${boardId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`[summary] ${JSON.stringify(s)}`);
  return s;
}

async function loadAllBoardIdsFromDb(): Promise<string[]> {
  const rows = [
    ...(await db.select({ board: streams.planka_board_id }).from(streams)),
    ...(await db.select({ board: projects.planka_board_id }).from(projects)),
  ];
  return [...new Set(rows.map((r) => r.board).filter((b): b is string => !!b && b !== 'planka-tbd'))];
}

if (import.meta.main) {
  const client = PlankaClient.fromConfig().asAgent();
  runBackfillDropped({
    apply: process.argv.includes('--apply'),
    loadBoardIds: loadAllBoardIdsFromDb,
    listBoardLists: (boardId) => client.lists.listByBoard(boardId) as Promise<BoardList[]>,
    createList: async (boardId, name, position) => {
      await client.lists.create({ boardId, name, position });
    },
  })
    .then((s) => process.exit(s.errors > 0 ? 1 : 0))
    .catch((err) => {
      console.error('[fatal]', err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    });
}
