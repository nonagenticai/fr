// tests/unit/routes/_lib/no-duplicate-request-helpers.test.ts
//
// A ratchet, not a style rule.
//
// `readJsonBody` had TEN byte-identical definitions and the integration-error
// catch wrapper had EIGHT under three names, across 18 route files and 147 call
// sites. That duplication is not incidental to the defect class this PR closes
// -- it is the transmission mechanism. When #903 had to sweep 78 sites that
// reported a caller's mistake as an upstream failure, the reason there were 78
// is that the same six lines had been pasted eighteen times, and each paste
// could drift on its own.
//
// A reviewer noticing the nineteenth paste is not a mechanism. This is.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../../../../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

const FILES = walk(SRC);

// The scan must read something. A walker that silently returns [] would make
// every assertion below pass against an empty set — the failure mode a bare
// count cannot see.
const MIN_FILES = 300;

describe('the request helpers have exactly one definition each', () => {
  test('the scan reads a plausible number of files — a zero-file scan is an ERROR, not a pass', () => {
    expect(FILES.length).toBeGreaterThan(MIN_FILES);
  });

  // ⚠️ KEY ON THE BODY, NOT THE NAME. The census that preceded this PR grepped
  // for the identifier `readJsonBody` and reported 10 copies. There were 11 —
  // routes/tools/bridge.ts had the same six lines under the name `readJson`.
  // The catch wrapper had already played the same trick with three names. A
  // name-keyed ratchet would have blessed both.
  test('the JSON-body reader is defined once, whatever it is called', () => {
    const defs = FILES.filter((f) =>
      /return \(await req\.json\(\)\.catch\(/.test(readFileSync(f, 'utf8')),
    );
    expect(defs.map((f) => f.slice(SRC.length + 1))).toEqual(['routes/_lib/request.ts']);
  });

  test('the read-and-validate reader is defined once, whatever it is called', () => {
    const defs = FILES.filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /raw = await req\.json\(\);/.test(s) && /schema\.safeParse\(raw\)/.test(s);
    });
    expect(defs.map((f) => f.slice(SRC.length + 1))).toEqual(['routes/_lib/request.ts']);
  });

  test('the integration-error catch wrapper is defined once, under one name', () => {
    // All three historical names, so a re-copy cannot dodge this by renaming —
    // which is exactly what the eight copies had already done.
    const defs = FILES.filter((f) =>
      /(?:export )?(?:async )?function with(?:Sync)?(?:Integration)?Catch\b/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(defs.map((f) => f.slice(SRC.length + 1))).toEqual(['routes/_lib/request.ts']);
  });

  test('the field-requirement helpers are defined once each', () => {
    for (const name of ['requireStringField', 'requireArrayField']) {
      const defs = FILES.filter((f) =>
        new RegExp(`(?:export )?(?:async )?function ${name}\\b`).test(readFileSync(f, 'utf8')),
      );
      expect(defs.map((f) => f.slice(SRC.length + 1))).toEqual(['routes/_lib/request.ts']);
    }
  });

  test('query parsing has ONE core; the local adapters must delegate, not reimplement', () => {
    // `parseQuery` legitimately survives as a thin local adapter in three
    // places (a reversed argument order, a comma-split param, a re-export that
    // keeps four importers stable). What must NOT survive is a second copy of
    // the BODY, so this counts the safeParse-and-throw core rather than the
    // name.
    const cores = FILES.filter((f) => {
      const s = readFileSync(f, 'utf8');
      // Anchored on the QUERY core specifically — `raw` built from
      // searchParams — so it does not collide with the read-and-validate
      // family, which also safeParses a variable called `raw`.
      return /for \(const \[k, v\] of url\.searchParams\.entries\(\)\)/.test(s);
    });
    expect(cores.map((f) => f.slice(SRC.length + 1))).toEqual(['routes/_lib/request.ts']);
  });
});
