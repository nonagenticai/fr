import { test, expect, describe, afterEach } from 'bun:test';

import { handle } from '../../../../../src/routes/assets/_lib/handler';
import { IntegrationError } from '../../../../../src/integrations/_lib/errors';

describe('handle()', () => {
  test('passes resolved value through mapper to Response', async () => {
    const res = await handle(
      async () => ({ ok: true, n: 42 }),
      (v) => new Response(JSON.stringify(v), { status: 200 }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, n: 42 });
  });

  test('IntegrationError is converted via integrationErrorResponse (UPSTREAM_NOT_FOUND -> 404)', async () => {
    const res = await handle(
      async () => {
        throw new IntegrationError({
          code: 'UPSTREAM_NOT_FOUND',
          message: 'missing thing',
          service: 'unit-test',
        });
      },
      () => new Response('should-not-be-used', { status: 200 }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string; service: string } };
    expect(body.error.code).toBe('UPSTREAM_NOT_FOUND');
    expect(body.error.message).toBe('missing thing');
    expect(body.error.service).toBe('unit-test');
  });

  test('non-IntegrationError is rethrown unchanged', async () => {
    const boom = new Error('kapow');
    await expect(
      handle(
        async () => {
          throw boom;
        },
        () => new Response('nope', { status: 200 }),
      ),
    ).rejects.toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// The cause must survive the error->Response conversion.
//
// Regression guard for the 2026-08-26 blind spot: `handle` turns an
// IntegrationError into a Response, so a handler wrapped in `emitSpan` returns
// instead of throwing and the span writes `outcome:"error"` with NO code and
// NO upstream status. Three live 502s on /api/tools/n8n/executions were
// undiagnosable from fr's own logs because of it.
// ---------------------------------------------------------------------------

function captureStderr(): { lines: string[]; restore: () => void } {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return { lines, restore: () => { console.error = original; } };
}

describe('handle() — integration failure logging', () => {
  let cap: { lines: string[]; restore: () => void } | null = null;
  afterEach(() => { cap?.restore(); cap = null; });

  test('logs a structured line naming code, service and upstream status', async () => {
    cap = captureStderr();
    await handle(
      async () => {
        throw new IntegrationError({
          code: 'UPSTREAM_BAD_STATUS',
          message: 'n8n GET /executions returned 502',
          service: 'n8n',
          method: 'GET',
          path: '/executions',
          upstreamStatus: 502,
        });
      },
      () => new Response('unused', { status: 200 }),
    );
    cap.restore();

    const parsed = cap.lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o): o is Record<string, unknown> => o?.telemetry === 'integration_error');

    expect(parsed).toHaveLength(1);
    const line = parsed[0]!;
    // Each of these was absent from the production log line and each was
    // needed to tell the three candidate causes apart.
    expect(line.code).toBe('UPSTREAM_BAD_STATUS');
    expect(line.service).toBe('n8n');
    expect(line.method).toBe('GET');
    expect(line.path).toBe('/executions');
    expect(line.upstream_status).toBe(502);
  });

  test('distinguishes unreachable from bad-status — the whole point', async () => {
    cap = captureStderr();
    await handle(
      async () => {
        throw new IntegrationError({
          code: 'UPSTREAM_UNREACHABLE',
          message: 'n8n unreachable: connect ECONNREFUSED',
          service: 'n8n',
        });
      },
      () => new Response('unused', { status: 200 }),
    );
    cap.restore();
    // Find-then-assert, never parse-then-hope: if nothing was logged this must
    // fail on the assertion below, not explode inside JSON.parse. A RED check
    // that dies on a TypeError proves the test is broken, not the code.
    const raw = cap.lines.find((l) => l.includes('integration_error'));
    expect(raw).toBeDefined();
    const line = JSON.parse(raw!);
    expect(line.code).toBe('UPSTREAM_UNREACHABLE');
    expect(line.upstream_status).toBeNull();
  });

  test('does NOT log the upstream body — it can carry tokens and PII', async () => {
    cap = captureStderr();
    await handle(
      async () => {
        throw new IntegrationError({
          code: 'UPSTREAM_UNAUTHORIZED',
          message: 'nope',
          service: 'n8n',
          upstreamStatus: 401,
          upstreamBody: { apiKey: 'super-secret-value-1234' },
        });
      },
      () => new Response('unused', { status: 200 }),
    );
    cap.restore();
    expect(cap.lines.join('\n')).not.toContain('super-secret-value-1234');
  });

  test('a successful call logs nothing', async () => {
    cap = captureStderr();
    await handle(async () => ({ ok: true }), (v) => new Response(JSON.stringify(v)));
    cap.restore();
    expect(cap.lines.filter((l) => l.includes('integration_error'))).toHaveLength(0);
  });

  test('a non-IntegrationError still rethrows and is not logged as one', async () => {
    cap = captureStderr();
    await expect(
      handle(async () => { throw new Error('kapow'); }, () => new Response('x')),
    ).rejects.toThrow('kapow');
    cap.restore();
    expect(cap.lines.filter((l) => l.includes('integration_error'))).toHaveLength(0);
  });
});
