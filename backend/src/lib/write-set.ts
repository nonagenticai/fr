// src/lib/write-set.ts
//
// U4 — the WRITE SET of a PR-bearing proof card, and the path-level fence over it. PURE: no
// db, no env. The contract is FROZEN (2026-10-02, movies-d2 ⇄ implement-multi-repo-properly;
// ~/.claude/plans/program/20-designs/U4-diff-scope-recon.md §WRITE_SET CONTRACT / §SEAL):
//
//   write_set : every repo-relative path the PR may CREATE, MODIFY or DELETE.
//               format      repo-relative POSIX paths, compared by EXACT string equality,
//                           never glob-expanded: no '*' '?', no '..', no leading or
//                           trailing '/', no empty segment, no control char; '[' ']' '{' '}'
//                           are LITERAL characters (services/approvals/write-set-paths.ts)
//               cardinality 1 ≤ length ≤ WRITE_SET_MAX (40)
//               order       unique; stored sorted (byte order)
//   seal      : write_set_seal = sha256_hex( RFC8785( { "v":1, "write_set": <sorted array> } ) )
//               canonicaliser = the U2 one (lib/bug-report-hash.ts canonicalizeJcs), never a
//               second implementation.
//   fence     : changed = added ∪ modified ∪ deleted ∪ rename-old ∪ rename-new.
//               changed ⊆ write_set                         → in_set (proceed)
//               out-of-set, EVERY such path a test file      → write_set_test_path_mismatch
//                                                              (qa_needs_info: design predicted
//                                                              the wrong test path)
//               any out-of-set NON-test path                 → diff_outside_write_set (block)
//
// KNOWN LIMIT: path-granular. Inside an allowed file anything may change; symbol-level
// containment is the R10 grader's (U4b), not this fence's.
//
// Shared by GET /api/approvals/:id/write-set (re-seal on read) and the constraint-check
// landing gate, so the two can never disagree on what a path or a seal is. A3's mint
// validation (implement-multi-repo) imports `writeSetSeal` from here and
// `assertWriteSetPaths` / `isValidWriteSetPath` from services/approvals/write-set-paths.ts.

import { createHash } from 'node:crypto';

import { canonicalizeJcs } from './bug-report-hash';

// The path predicate, set validation and normalisation are NOT here: they live in ONE module,
// services/approvals/write-set-paths.ts, imported directly by every caller.
import { compareBytes } from '../services/approvals/write-set-paths';

export const WRITE_SET_SEAL_VERSION = 1 as const;

export const DIFF_OUTSIDE_WRITE_SET = 'diff_outside_write_set' as const;
export const WRITE_SET_TEST_PATH_MISMATCH = 'write_set_test_path_mismatch' as const;
/** Fence refusal (block class): no project tenant to scope the write-set read by. */
export const WRITE_SET_TENANT_UNRESOLVED = 'write_set_tenant_unresolved' as const;

/** write_set_seal = sha256_hex(RFC8785({v:1, write_set})) over the array AS GIVEN. */
export function writeSetSeal(writeSet: readonly string[]): string {
  return createHash('sha256')
    .update(canonicalizeJcs({ v: WRITE_SET_SEAL_VERSION, write_set: [...writeSet] }), 'utf8')
    .digest('hex');
}

/**
 * The test-path predicate the fence classifies with. fr has no repo-specific test-path
 * predicate, so this is the contract's own: `tests/**`, `**\/*.test.*`, `**\/*_test.*`.
 * (`tests/` matches only as the FIRST segment: the contract's tests root is the repo's.)
 */
export function isTestPath(p: string): boolean {
  if (p.startsWith('tests/')) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  return /^[^/]+\.test\.[^/]+$/.test(base) || /^[^/]+_test\.[^/]+$/.test(base);
}

export type WriteSetFenceOutcome = 'in_set' | typeof WRITE_SET_TEST_PATH_MISMATCH | typeof DIFF_OUTSIDE_WRITE_SET;

export interface WriteSetFenceResult {
  outcome: WriteSetFenceOutcome;
  /** Changed paths not in the write set, byte-ordered, de-duplicated. */
  offending: string[];
}

/**
 * The fence. `changed` must already be the FULL change set (both sides of every rename,
 * deletions included) — the caller's job, because only it knows the PR's file statuses.
 */
export function evaluateWriteSetFence(writeSet: readonly string[], changed: Iterable<string>): WriteSetFenceResult {
  const allowed = new Set(writeSet);
  const offending = [...new Set(changed)].filter((p) => !allowed.has(p)).sort(compareBytes);
  if (offending.length === 0) return { outcome: 'in_set', offending };
  return {
    outcome: offending.every(isTestPath) ? WRITE_SET_TEST_PATH_MISMATCH : DIFF_OUTSIDE_WRITE_SET,
    offending,
  };
}
