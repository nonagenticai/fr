// src/services/approvals/write-set-paths.ts
//
// U4 — THE write-set path predicate. ONE module, imported directly by the write-set read
// (services/approvals/write-set.ts + routes/approval-write-set.ts) AND by the constraint-check
// fence (routes/project-constraint-check.ts). There is no other copy, and
// tests/unit/services/approvals/write-set-paths-single-definition.test.ts keeps it that way:
// a second predicate is how the read route and the fence come to disagree on a path.
//
// Contract (U4-diff-scope-recon.md § WRITE_SET PATH FORMAT, AMENDED + FROZEN 2026-10-02):
//
//   format: repo-relative POSIX paths, EXACT STRING match (never glob-expanded).
//           REFUSE: '*', '?', '..' segments, leading '/', trailing '/', empty segments,
//                   NUL and other control chars, backslash.
//           ALLOW as literal characters: '[' ']' '{' '}' '(' ')' '+' '~' '@' '#' '%' ' '
//           Rationale: comparison is string equality, so none of these can expand.
//                      Measured on fr origin/main: '+' in 219 paths, '(' / ')' in 84,
//                      '[' / ']' in 116 — refusing any of them blocks correct PRs.
//   exports: isValidWriteSetPath(p: string): boolean
//            assertWriteSetPaths(paths: readonly string[])  // non-empty, unique, sorted, cap 40
//
// So `src/[id].ts` in a write set covers exactly `src/[id].ts` — never `src/i.ts`.

import { AppError } from '../../utils/errors';

export const WRITE_SET_MAX = 40;

const GLOB_METACHAR = /[*?]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** True iff `p` is an exact repo-relative POSIX path under the frozen format above. */
export function isValidWriteSetPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.startsWith('/') || p.endsWith('/')) return false;
  if (GLOB_METACHAR.test(p) || CONTROL.test(p) || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '..');
}

/** Byte-order (UTF-8) comparison — the contract's "stored sorted (byte order)". */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export type WriteSetPathsCode = 'write_set_invalid' | 'write_set_too_broad';

/** 409 + `code` when it escapes to a route; `pathsCode` is the typed cause for callers that map it. */
export class WriteSetPathsError extends AppError {
  constructor(
    readonly pathsCode: WriteSetPathsCode,
    readonly detail: string,
  ) {
    super(409, detail);
    this.name = 'WriteSetPathsError';
    this.withCode(pathsCode);
  }
}

/**
 * Assert a STORED write set exactly as the contract states it: 1..40 valid paths, unique,
 * already in byte order. Throws WriteSetPathsError (`write_set_too_broad` over the cap, else
 * `write_set_invalid`). An unsorted set is refused, never re-sorted: the seal is over the
 * stored order, and a reader that silently sorted would accept a row no conforming minter
 * could have written. Runtime-checks element types, so it is safe on untyped JSON.
 */
export function assertWriteSetPaths(paths: readonly string[]): void {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new WriteSetPathsError('write_set_invalid', 'write_set must be a non-empty array');
  }
  if (paths.length > WRITE_SET_MAX) {
    throw new WriteSetPathsError('write_set_too_broad', `write_set has ${paths.length} paths (max ${WRITE_SET_MAX})`);
  }
  for (let i = 0; i < paths.length; i++) {
    if (!isValidWriteSetPath(paths[i] as string)) {
      throw new WriteSetPathsError('write_set_invalid', `write_set[${i}] is not an exact repo-relative path`);
    }
    if (i > 0) {
      const c = compareBytes(paths[i - 1] as string, paths[i] as string);
      if (c === 0) throw new WriteSetPathsError('write_set_invalid', `write_set[${i}] is a duplicate`);
      if (c > 0) throw new WriteSetPathsError('write_set_invalid', `write_set is not in byte order at [${i}]`);
    }
  }
}
