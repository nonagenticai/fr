// src/lib/components/llm-provider/key-test.ts
//
// Pure presentation for the per-tier "Test" button on /settings/llm-provider
// (owner ruling 2026-10-01: a green/red key test per tier). Kept out of the
// component so it is testable under vitest's node environment.

import type { LlmKeyTestResult } from '$lib/api/llm-provider';

export type KeyTestTone = 'ok' | 'fail';

export interface KeyTestView {
  /** green (`ok`) or red (`fail`) dot. */
  tone: KeyTestTone;
  /** One line: what was tested and why it passed or failed. */
  text: string;
  /** Set when the key works but something else needs attention. */
  warning: string | null;
}

/** Which row the test actually addressed — WM falls back to the default row. */
function target(r: LlmKeyTestResult): string {
  const parts = [r.provider, r.model].filter((p): p is string => typeof p === 'string' && !!p);
  return parts.join(' · ');
}

export function keyTestView(r: LlmKeyTestResult): KeyTestView {
  const what = target(r);
  if (r.ok) {
    const latency = typeof r.latency_ms === 'number' ? ` (${r.latency_ms} ms)` : '';
    return {
      tone: 'ok',
      text: `Key works${what ? ` — ${what}` : ''}${latency}`,
      warning: r.warning ?? null,
    };
  }
  return {
    tone: 'fail',
    text: r.error?.trim() || `Key test failed${what ? ` — ${what}` : ''}`,
    warning: null,
  };
}

/** A request that never reached a verdict (network, 403, 5xx). */
export function keyTestErrorView(err: unknown): KeyTestView {
  return {
    tone: 'fail',
    text: err instanceof Error && err.message ? err.message : 'Key test failed.',
    warning: null,
  };
}
