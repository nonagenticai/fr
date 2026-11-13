// Per-tier key test presentation (owner ruling 2026-10-01: green/red per tier
// plus the reason).
import { describe, expect, it } from 'vitest';
import { keyTestErrorView, keyTestView } from './key-test';

describe('keyTestView', () => {
  it('green with what was tested and the latency', () => {
    expect(keyTestView({ ok: true, provider: 'openai', model: 'gpt-4.1', latency_ms: 120 })).toEqual({
      tone: 'ok',
      text: 'Key works — openai · gpt-4.1 (120 ms)',
      warning: null,
    });
  });
  it('green keeps WM’s warning', () => {
    const v = keyTestView({ ok: true, provider: 'openai', model: 'x', warning: "model 'x' not listed" });
    expect(v.tone).toBe('ok');
    expect(v.warning).toBe("model 'x' not listed");
  });
  it('red shows WM’s reason', () => {
    expect(
      keyTestView({ ok: false, provider: 'openai', error: 'openai rejected the call with this key: 401' }),
    ).toEqual({ tone: 'fail', text: 'openai rejected the call with this key: 401', warning: null });
  });
  it('red without a reason still says it failed', () => {
    expect(keyTestView({ ok: false }).text).toBe('Key test failed');
  });
});

describe('keyTestErrorView', () => {
  it('red with the request error', () => {
    expect(keyTestErrorView(new Error('workspace-admin role required'))).toEqual({
      tone: 'fail',
      text: 'workspace-admin role required',
      warning: null,
    });
  });
});
