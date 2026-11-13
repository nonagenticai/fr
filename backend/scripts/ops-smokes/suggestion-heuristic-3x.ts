#!/usr/bin/env bun
// scripts/ops-smokes/suggestion-heuristic-3x.ts
//
// Op smoke #3 — suggestion heuristic determinism.
//
// Runs detectCandidates against a fixed RunRow set three times and asserts:
//   1. Identical output across all three runs (heuristic must be pure).
//   2. Total wall-clock under 60s (sanity bound; heuristic is in-memory).
//
// Used by ops/CI to detect a regression that introduces non-determinism
// (e.g. a non-stable sort, Math.random, time-keyed cache miss).
//
// Usage:
//   bun scripts/ops-smokes/suggestion-heuristic-3x.ts
//
// Exit codes: 0 = deterministic + on-budget, 1 = non-deterministic or
// over-budget; cron-metric harness reads exit code.

import { detectCandidates, type RunRow } from '../../src/services/suggestion-heuristic';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-aaaa00000001';
const USER = '00000000-0000-4000-8000-bbbb00000001';

// 4 manual runs, all within ±15min of 14:00 UTC, on 4 distinct days —
// enough to clear the REQUIRED_DAYS=3 threshold and emit a candidate.
const FIXTURE: RunRow[] = [
  {
    tenant_id: TENANT,
    project_id: PROJECT,
    triggered_by_user_id: USER,
    kind: 'manual',
    fired_at: new Date('2026-04-28T14:05:00Z'),
  },
  {
    tenant_id: TENANT,
    project_id: PROJECT,
    triggered_by_user_id: USER,
    kind: 'manual',
    fired_at: new Date('2026-04-29T13:58:00Z'),
  },
  {
    tenant_id: TENANT,
    project_id: PROJECT,
    triggered_by_user_id: USER,
    kind: 'manual',
    fired_at: new Date('2026-04-30T14:11:00Z'),
  },
  {
    tenant_id: TENANT,
    project_id: PROJECT,
    triggered_by_user_id: USER,
    kind: 'manual',
    fired_at: new Date('2026-05-01T14:02:00Z'),
  },
];

const BUDGET_MS = 60_000;

function main(): void {
  const start = Date.now();

  const r1 = detectCandidates(FIXTURE);
  const r2 = detectCandidates(FIXTURE);
  const r3 = detectCandidates(FIXTURE);

  const elapsed = Date.now() - start;

  const s1 = JSON.stringify(r1);
  const s2 = JSON.stringify(r2);
  const s3 = JSON.stringify(r3);

  if (s1 !== s2 || s2 !== s3) {
    console.error('[heuristic-3x] FAIL: non-deterministic outputs across 3 runs');
    console.error('  run1:', s1.slice(0, 200));
    console.error('  run2:', s2.slice(0, 200));
    console.error('  run3:', s3.slice(0, 200));
    process.exit(1);
  }
  if (elapsed > BUDGET_MS) {
    console.error(
      `[heuristic-3x] FAIL: 3 runs took ${elapsed}ms, exceeds ${BUDGET_MS}ms budget`,
    );
    process.exit(1);
  }
  if (r1.length === 0) {
    console.error('[heuristic-3x] FAIL: fixture should yield ≥1 candidate, got 0');
    process.exit(1);
  }
  console.log(
    `[heuristic-3x] PASS deterministic=true runs=3 candidates=${r1.length} elapsed_ms=${elapsed} budget_ms=${BUDGET_MS}`,
  );
  process.exit(0);
}

main();
