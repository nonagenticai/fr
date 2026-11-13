// A 502 that says "502 Bad Gateway" sends the reader to the wrong service.
//
// On 2026-09-16 kag set `ALLOW_UNVOUCHED_TENANT_HEADER=false` and fr stopped
// vouching on `GET /api/documents`. kag answered 401; the backend mapped it to
// 502 (deliberately — a 401 to the browser makes a healthy session look
// expired); the picker rendered `err.message`, so the screen said
// "502 Bad Gateway". That reads as "KAG is down". It was not down: fr was not
// authorised to it, and `error.code` had said so all along.
//
// `assetErrorCause` is the hop that reads it. These tests pin three things the
// bug turned on: WHO is at fault, whether retrying could possibly help, and
// that we never tell a user their session is broken when it is not.

import { describe, expect, it } from 'vitest';
import { AssetError, assetErrorCause } from './assets';

describe('assetErrorCause', () => {
  it('names fr — not the user session — when fr credential is refused upstream', () => {
    const cause = assetErrorCause(
      new AssetError(
        'kag GET /api/documents returned 401',
        502,
        'UPSTREAM_UNAUTHORIZED',
        { detail: 'A bare X-Tenant-Id is not accepted; present a license token' },
        'kag',
      ),
    );

    expect(cause.operatorFault).toBe(true);
    expect(cause.headline).toContain('kag');
    // The load-bearing assertion. `$lib/bridge/errors.ts` renders this same
    // code as "Your session is no longer authorized", which is right for a
    // bridge mutation the user drove and wrong here. Telling the user to
    // re-login for an operator fault costs them a round trip and fixes nothing.
    expect(cause.headline).toContain('Your session is fine');
    // Retrying an unauthorised call just reproduces it.
    expect(cause.retryable).toBe(false);
    // The upstream's own sentence survives, so an operator can act without
    // opening the pod logs.
    expect(cause.detail).toBe(
      'A bare X-Tenant-Id is not accepted; present a license token',
    );
  });

  it('treats an unreachable upstream as retryable — the discriminator vs 401', () => {
    // Without this, `retryable: false` everywhere would pass the test above.
    const cause = assetErrorCause(
      new AssetError('kag unreachable: ECONNREFUSED', 502, 'UPSTREAM_UNREACHABLE', undefined, 'kag'),
    );
    expect(cause.retryable).toBe(true);
    expect(cause.operatorFault).toBe(true);
  });

  it('does not claim operator fault for a tenant-scoped 403', () => {
    // A 403 is a real permission answer about THIS tenant. Calling it an
    // operator fault would send someone to check a healthy deployment.
    const cause = assetErrorCause(
      new AssetError('forbidden', 403, 'UPSTREAM_FORBIDDEN', undefined, 'kag'),
    );
    expect(cause.operatorFault).toBe(false);
    expect(cause.retryable).toBe(false);
  });

  it('falls back to the message for a plain Error, without inventing a service', () => {
    const cause = assetErrorCause(new Error('network down'));
    expect(cause.headline).toBe('network down');
    expect(cause.operatorFault).toBe(false);
    expect(cause.detail).toBeUndefined();
  });

  it('names the upstream generically when the envelope carried no service', () => {
    const cause = assetErrorCause(
      new AssetError('boom', 502, 'UPSTREAM_UNAUTHORIZED', undefined, undefined),
    );
    // Never the string "undefined" in front of a user.
    expect(cause.headline).not.toContain('undefined');
    expect(cause.headline).toContain('the upstream service');
  });
});
