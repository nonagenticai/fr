// tests/unit/routes/assets/kag-cursor-is-not-forwarded.test.ts
//
// A STATIC guard over an ABSENCE, which is the hard kind to write honestly: an
// absence assertion is satisfied by any bug that makes the thing unobservable.
// So this file does not merely assert that `next_cursor` is missing — it first
// proves it can SEE a `next_cursor` when one is there, using the upstream type
// declaration as a positive control. Without that control, renaming the field,
// moving the handler, or breaking the reader would all read as "fixed".
//
// WHAT IT GUARDS. kag's GET /api/documents mints
//   next_cursor = str(offset + limit)   when len(items) >= limit
// but it reads the set from graph-adapter's `GET /nodes/`, whose OpenAPI
// declares only `label`, `properties` and `envelope`. FastAPI drops undeclared
// query params, so `limit` and `offset` never take effect and every "page" is
// the identical full set. Measured live 2026-09-06: 559 rows returned
// alongside `next_cursor: "100"`. A client that follows that cursor re-requests
// the same 559 rows forever.
//
// Re-adding the forward is therefore not a feature — it is the loop. If
// graph-adapter ever declares limit/offset, delete this file in the same commit
// that restores the cursor, and say so in the message.

import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES_DIR = join(import.meta.dir, '../../../../src/routes/assets');
const INTEGRATIONS_DIR = join(import.meta.dir, '../../../../src/integrations');

/** The body of `export async function <name>(` up to the next top-level export. */
function handlerBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start === -1) throw new Error(`handler not found: ${name}`);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

const HANDLERS: ReadonlyArray<readonly [string, string]> = [
  ['kag.ts', 'handleKagListDocuments'],
  ['kag-documents.ts', 'handleListKagDocumentsAsset'],
];

describe('the looping kag document cursor is not forwarded', () => {
  // POSITIVE CONTROL. If this fails, the field has been renamed or the
  // integration no longer declares it, and every assertion below has gone
  // vacuous — they would pass against a handler that forwards the new name.
  test('the upstream type still declares next_cursor, so absence below is meaningful', () => {
    const src = readFileSync(join(INTEGRATIONS_DIR, 'kag.ts'), 'utf-8');
    expect(src).toContain('next_cursor');
  });

  for (const [file, name] of HANDLERS) {
    test(`${file} :: ${name} does not forward next_cursor`, () => {
      const body = handlerBody(readFileSync(join(ROUTES_DIR, file), 'utf-8'), name);
      // Strip comments first. The handlers EXPLAIN this decision at length and
      // both explanations name the field, so a naive substring search matches
      // the prose that documents the fix and can never fail.
      const code = body
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      expect(code).not.toContain('next_cursor');
    });
  }

  // The other half of the pair: neither route may substitute a row count for
  // the total it cannot obtain. `total` is null upstream on every call today.
  for (const [file, name] of HANDLERS) {
    test(`${file} :: ${name} never derives a total from a row count`, () => {
      const body = handlerBody(readFileSync(join(ROUTES_DIR, file), 'utf-8'), name);
      const code = body
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      expect(code).not.toMatch(/total:\s*\w+\.length/);
    });
  }
});
