// src/scripts/backfill-dropped-list.test.ts — the DROPPED-list backfill (liveness-DONE row #2).
import { describe, expect, test } from 'bun:test';

import { isBoard404Error, planDroppedList } from './backfill-dropped-list';
import { mapPlankaError } from '../services/planka/errors';

const SIX = ['TODO', 'READY', 'DOING', 'QA', 'BLOCKED', 'DONE'].map((name, i) => ({ name, position: (i + 1) * 65536, type: 'active' }));
const SYSTEM = [{ name: null, position: null, type: 'archive' }, { name: null, position: null, type: 'trash' }];

describe('planDroppedList', () => {
  test('a six-list board needs DROPPED after its last active list', () => {
    expect(planDroppedList([...SIX, ...SYSTEM])).toEqual({ needed: true, position: 7 * 65536 });
  });
  test('idempotent: a board that has DROPPED needs nothing', () => {
    expect(planDroppedList([...SIX, { name: 'DROPPED', position: 1, type: 'active' }]).needed).toBe(false);
  });
});

describe('isBoard404Error (moved here from the deleted backfill-runtime-state-fields.ts)', () => {
  async function plankaError(status: number, message: string) {
    return mapPlankaError(
      new Response(JSON.stringify({ code: 'E_X', message }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
      '/api/boards/x',
    );
  }
  test('only a Planka 404 is a skip; 401/403/plain errors are not', async () => {
    expect(isBoard404Error(await plankaError(401, 'Unauthorized'))).toBe(false);
    expect(isBoard404Error(await plankaError(403, 'Forbidden'))).toBe(false);
    expect(isBoard404Error(new Error('Board not found'))).toBe(false);
    expect(isBoard404Error(await plankaError(404, 'Board not found'))).toBe(true);
  });
});
