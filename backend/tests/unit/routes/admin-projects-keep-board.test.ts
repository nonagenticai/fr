// Unit tests for `parseKeepBoard` (routes/admin/assets/projects.ts), the
// defensive body parser behind the admin DELETE's OPTIONAL `keep_board`
// modifier (fr#1142). No DB, no gate — pure Request -> boolean.

import { describe, expect, test } from 'bun:test';
import { parseKeepBoard } from '../../../src/routes/admin/assets/projects';

const req = (body?: string) =>
  new Request('http://localhost/api/admin/assets/projects/00000000-0000-0000-0000-000000000000', {
    method: 'DELETE',
    ...(body === undefined ? {} : { body }),
  });

describe('parseKeepBoard', () => {
  test('absent body -> false', async () => {
    expect(await parseKeepBoard(req())).toBe(false);
  });

  test('empty string body -> false', async () => {
    expect(await parseKeepBoard(req(''))).toBe(false);
  });

  test('whitespace-only body -> false', async () => {
    expect(await parseKeepBoard(req('   \n'))).toBe(false);
  });

  test('empty object -> false', async () => {
    expect(await parseKeepBoard(req('{}'))).toBe(false);
  });

  test('{"keep_board": true} -> true', async () => {
    expect(await parseKeepBoard(req(JSON.stringify({ keep_board: true })))).toBe(true);
  });

  test('{"keep_board": false} -> false', async () => {
    expect(await parseKeepBoard(req(JSON.stringify({ keep_board: false })))).toBe(false);
  });

  test('{"keep_board": "yes"} -> false (strict boolean, not truthy coercion)', async () => {
    expect(await parseKeepBoard(req(JSON.stringify({ keep_board: 'yes' })))).toBe(false);
  });

  test('{"keep_board": 1} -> false (strict boolean, not truthy coercion)', async () => {
    expect(await parseKeepBoard(req(JSON.stringify({ keep_board: 1 })))).toBe(false);
  });

  test('malformed JSON -> false, does not throw', async () => {
    expect(await parseKeepBoard(req('{not json'))).toBe(false);
  });

  test('JSON array body -> false (not an object with keep_board)', async () => {
    expect(await parseKeepBoard(req('[1,2,3]'))).toBe(false);
  });

  test('JSON null body -> false', async () => {
    expect(await parseKeepBoard(req('null'))).toBe(false);
  });
});
