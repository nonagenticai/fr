// The RM pass-through table (src/routes/assets/_lib/rm-passthrough.ts) against
// RM's own declaration (the generated OPERATIONS, from RM's openapi.json):
// every row's URL builder is the one of the operation it is keyed by, and fr
// forwards a header or a body only where RM declares one. A spec refresh that
// drops a header RM used to take reddens this instead of fr sending a header
// RM ignores.
import { describe, expect, test } from 'bun:test';
import { OPERATIONS, type OperationName } from '@fr/service-client-requirements';

import { RM_DOWNLOADS, RM_PASSTHROUGH, downloadHeaders, type Passthrough } from '../../../../src/routes/assets/_lib/rm-passthrough';

const rows = Object.entries(RM_PASSTHROUGH) as Array<[OperationName, Passthrough]>;
const pascal = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);

describe('RM pass-through table', () => {
  test('is not empty', () => expect(rows.length).toBeGreaterThan(0));

  for (const [name, row] of rows) {
    const op = OPERATIONS[name] as { method: string; headers: readonly string[]; body?: string };
    test(`${name}: its URL builder is get${pascal(name)}Url`, () => {
      expect(row.url.name).toBe(`get${pascal(name)}Url`);
    });
    test(`${name}: forwards only what RM declares`, () => {
      const forwarded = [row.ifMatch ? 'If-Match' : null, row.idempotencyKey ? 'Idempotency-Key' : null].filter((h): h is string => h !== null);
      expect(forwarded.filter((h) => !op.headers.includes(h))).toEqual([]);
      // A body only on a verb that carries one; an empty 204 only for a DELETE.
      expect(row.body === true && !['POST', 'PUT', 'PATCH'].includes(op.method)).toBe(false);
      expect(row.ok === 204 && op.method !== 'DELETE').toBe(false);
    });
  }
});

describe('RM downloads table', () => {
  for (const [name, url] of Object.entries(RM_DOWNLOADS) as Array<[OperationName, Passthrough['url']]>) {
    test(`${name}: its URL builder is get${pascal(name)}Url, a GET`, () => {
      expect(url.name).toBe(`get${pascal(name)}Url`);
      expect(OPERATIONS[name].method).toBe('GET');
    });
  }
});

describe('downloadHeaders', () => {
  test("relays RM's type and disposition as RM sent them", () => {
    const upstream = new Headers({ 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="m.zip"', etag: '"7"' });
    expect(downloadHeaders(upstream)).toEqual({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="m.zip"',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    });
  });

  test('an inline disposition is never relayed: the file stays an attachment', () => {
    expect(downloadHeaders(new Headers({ 'content-type': 'image/svg+xml', 'content-disposition': 'inline; filename="v.svg"' }))['Content-Disposition']).toBe('attachment');
  });

  test('an answer without them is still an attachment of unknown type, never sniffed', () => {
    expect(downloadHeaders(new Headers())).toEqual({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    });
  });
});
