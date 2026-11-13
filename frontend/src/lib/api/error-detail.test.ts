import { describe, it, expect } from 'vitest';
import { errorDetailFrom, errorDetailOf, humaniseCode } from './error-detail';

describe('errorDetailFrom', () => {
  it('is the regression guard for the [object Object] the operator actually saw', () => {
    // Verbatim shape of the live 2026-08-26 failure: fr's integration envelope
    // wrapping provisioning's 404. The old
    // `[error, detail].filter(Boolean).join(': ')` rendered this as
    // "[object Object]" after a 10.8s wait.
    const body = {
      error: {
        code: 'UPSTREAM_NOT_FOUND',
        message:
          'provisioning /api/provision 404: {"detail":"no active plan for licenses app \'meta_prompt_core_actions\'"}',
        service: 'provisioning',
        upstream: {
          status: 404,
          body: { detail: "no active plan for licenses app 'meta_prompt_core_actions'" },
        },
      },
    };
    const out = errorDetailFrom(body);
    expect(out).toBe("no active plan for licenses app 'meta_prompt_core_actions'");
    expect(out).not.toContain('[object Object]');
    // The offending app key must survive — it is the only actionable part.
    expect(out).toContain('meta_prompt_core_actions');
  });

  it('prefers the upstream sentence over fr\'s generic transport wrapper', () => {
    const out = errorDetailFrom({
      error: {
        code: 'UPSTREAM_NOT_FOUND',
        message: 'provisioning /api/provision 404: something',
        upstream: { status: 404, body: { detail: 'the real reason' } },
      },
    });
    expect(out).toBe('the real reason');
    expect(out).not.toContain('/api/provision');
  });

  it('falls back to message when upstream.body is absent', () => {
    // This is the pre-fix backend behaviour: provisioning.ts omitted
    // `upstreamBody`, so `upstream.body` came through undefined.
    expect(
      errorDetailFrom({
        error: {
          code: 'UPSTREAM_NOT_FOUND',
          message: 'provisioning /api/provision 404: no active plan',
          upstream: { status: 404, body: undefined },
        },
      }),
    ).toBe('provisioning /api/provision 404: no active plan');
  });

  it('falls back to a humanised code when there is no message at all', () => {
    expect(errorDetailFrom({ error: { code: 'upstream_unreachable' } })).toBe(
      'Upstream unreachable',
    );
  });

  it('still handles the plain string shape it always handled', () => {
    expect(errorDetailFrom({ error: 'super-admin only' })).toBe('super-admin only');
    expect(errorDetailFrom({ error: 'bad', detail: 'why' })).toBe('bad: why');
  });

  it('handles a bare FastAPI detail', () => {
    expect(errorDetailFrom({ detail: 'tenant not found' })).toBe('tenant not found');
  });

  it('flattens a FastAPI 422 validation array', () => {
    expect(
      errorDetailFrom({
        detail: [
          { loc: ['body', 'email'], msg: 'field required', type: 'missing' },
          { loc: ['body', 'apps'], msg: 'too short', type: 'too_short' },
        ],
      }),
    ).toBe('field required; too short');
  });

  it('surfaces remedy over code, because remedy is the only actionable half', () => {
    expect(
      errorDetailFrom({
        error: {
          upstream: {
            body: { detail: { error: 'all_tokens_expired', remedy: 'mint a new token' } },
          },
        },
      }),
    ).toBe('All tokens expired — mint a new token');
  });

  it('does not repeat a detail that merely echoes the error', () => {
    expect(errorDetailFrom({ error: 'same', detail: 'same' })).toBe('same');
  });

  it('returns empty string for shapes it cannot read, never a blob', () => {
    for (const body of [null, undefined, 'a string', 42, {}, { error: {} }, { error: [] }]) {
      const out = errorDetailFrom(body);
      expect(out).toBe('');
      expect(out).not.toContain('[object Object]');
    }
  });

  it('ignores whitespace-only strings rather than emitting a bare separator', () => {
    expect(errorDetailFrom({ error: '   ', detail: '  ' })).toBe('');
  });
});

describe('errorDetailOf', () => {
  it('reads a JSON response', async () => {
    const r = new Response(JSON.stringify({ error: 'nope' }), { status: 403 });
    expect(await errorDetailOf(r)).toBe('nope');
  });

  it('yields empty string for a non-JSON body instead of throwing', async () => {
    // The frontend proxy's own 502 is text/plain "Bad Gateway" — the exact
    // body served when fr-backend is unreachable (frontend/server.js).
    const r = new Response('Bad Gateway', { status: 502 });
    await expect(errorDetailOf(r)).resolves.toBe('');
  });
});

describe('humaniseCode', () => {
  it('converts snake_case to a sentence', () => {
    expect(humaniseCode('no_active_plan')).toBe('No active plan');
  });
  it('is empty-safe', () => {
    expect(humaniseCode('')).toBe('');
    expect(humaniseCode('   ')).toBe('');
  });
});
