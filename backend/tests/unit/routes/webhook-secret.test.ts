// tests/unit/routes/webhook-secret.test.ts
//
// src/utils/webhook-secret.ts — the ONE shared X-Webhook-Secret check behind
// every n8n / upstream webhook receiver.
//
// The regression being pinned: an unset N8N_WEBHOOK_SECRET used to mean "skip
// authentication" in EVERY environment, so blanking or rotating the env var
// turned the receivers into open endpoints instead of breaking loudly. The
// production branch below is the fail-closed guarantee; the non-production
// branch is the dev-loop convenience that must survive.
//
// How the environment is set: `src/config.ts` captures NODE_ENV and
// N8N_WEBHOOK_SECRET when it loads, and bun caches the module for the rest of
// the process. So each scenario runs the REAL modules in a fresh child `bun`
// process started with exactly those two variables — no mutation of the
// config singleton, nothing that can leak into other files in this process.
import { describe, test, expect } from 'bun:test';
import { resolve } from 'node:path';

const BACKEND = resolve(import.meta.dir, '../../..');

type Outcome = { threw: boolean; unauthorized?: boolean; status?: number; message?: string };

/**
 * Runs `body` (an async JS function body that returns a JSON-able value) in a
 * child bun process with NODE_ENV / N8N_WEBHOOK_SECRET set as given. Inside
 * `body`: `ws` is src/utils/webhook-secret, `req(headers)` builds a webhook request, and
 * `outcome(fn)` runs fn and reports whether it threw an UnauthorizedError.
 */
function inChild(nodeEnv: string, secret: string, body: string): unknown {
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: nodeEnv, N8N_WEBHOOK_SECRET: secret };
  const script = `
    const ws = await import('./src/utils/webhook-secret.ts');
    const { UnauthorizedError } = await import('./src/utils/errors.ts');
    const req = (headers = {}) =>
      new Request('http://fr/api/webhooks/n8n/execution-event', { method: 'POST', headers });
    const outcome = async (fn) => {
      try { await fn(); return { threw: false }; }
      catch (e) {
        return { threw: true, unauthorized: e instanceof UnauthorizedError, status: e?.statusCode, message: e?.message };
      }
    };
    const result = await (async () => { ${body} })();
    console.log('RESULT ' + JSON.stringify(result));
  `;
  const p = Bun.spawnSync(['bun', '-e', script], { cwd: BACKEND, env });
  const out = p.stdout.toString();
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  if (p.exitCode !== 0 || !line) {
    throw new Error(`child failed (exit ${p.exitCode}):\n${out}\n${p.stderr.toString()}`);
  }
  return JSON.parse(line.slice('RESULT '.length));
}

describe('validateWebhookSecret', () => {
  test('production + unset secret → throws 401 naming the missing var', () => {
    // No header at all, and none would help: the endpoint has no way to
    // authenticate anyone, so it must refuse rather than admit everyone.
    const o = inChild('production', '', 'return outcome(() => ws.validateWebhookSecret(req()));') as Outcome;
    expect(o.threw).toBe(true);
    expect(o.unauthorized).toBe(true);
    expect(o.status).toBe(401);
    expect(o.message).toContain('WEBHOOK_AUTH_NOT_CONFIGURED');
    expect(o.message).toContain('N8N_WEBHOOK_SECRET');
  });

  test('production + unset secret → throws even when a header is supplied', () => {
    // Guards against a "compare against empty string" implementation, where an
    // empty X-Webhook-Secret header would sail through.
    const o = inChild(
      'production',
      '',
      `return outcome(() => ws.validateWebhookSecret(req({ 'X-Webhook-Secret': '' })));`,
    ) as Outcome;
    expect(o.threw).toBe(true);
    expect(o.message).toContain('WEBHOOK_AUTH_NOT_CONFIGURED');
  });

  test('non-production + unset secret → returns (dev skip preserved)', () => {
    for (const env of ['development', 'test', 'staging']) {
      const o = inChild(env, '', 'return outcome(() => ws.validateWebhookSecret(req()));') as Outcome;
      expect(o).toEqual({ threw: false });
    }
  });

  test('production + configured secret: match passes, wrong / prefix / missing header → 401', () => {
    const r = inChild(
      'production',
      'sup3r-s3cret',
      `return {
        match: await outcome(() => ws.validateWebhookSecret(req({ 'X-Webhook-Secret': 'sup3r-s3cret' }))),
        // Same length as the real secret, so this fails on CONTENT, not on the
        // length short-circuit inside timingSafeEquals.
        wrong: await outcome(() => ws.validateWebhookSecret(req({ 'X-Webhook-Secret': 'sup3r-s3creT' }))),
        // A prefix of the real secret must also fail (length mismatch path).
        prefix: await outcome(() => ws.validateWebhookSecret(req({ 'X-Webhook-Secret': 'sup3r' }))),
        // timingSafeEquals takes strings; a null header must be caught by the
        // explicit guard and surface as a clean 401, not a TypeError.
        missing: await outcome(() => ws.validateWebhookSecret(req())),
      };`,
    ) as Record<string, Outcome>;
    expect(r.match).toEqual({ threw: false });
    expect(r.wrong!.unauthorized).toBe(true);
    expect(r.wrong!.message).toBe('Invalid or missing webhook secret');
    expect(r.prefix!.unauthorized).toBe(true);
    expect(r.missing!.unauthorized).toBe(true);
    expect(r.missing!.status).toBe(401);
    expect(r.missing!.message).toBe('Invalid or missing webhook secret');
  });

  test('a configured secret is enforced in dev too — dev-skip is unset-only', () => {
    const o = inChild(
      'development',
      'sup3r-s3cret',
      `return outcome(() => ws.validateWebhookSecret(req({ 'X-Webhook-Secret': 'nope' })));`,
    ) as Outcome;
    expect(o.unauthorized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAuthorizedBySharedSecret — the boolean form, for receivers that carry their
// OWN secret and/or must answer 200 even when they reject (Telegram disables a
// webhook that errors repeatedly, so a 401 there is self-harm).
//
// The regression pinned here is the same one, in more places: an unset
// TELEGRAM_WEBHOOK_SECRET skipped the check in EVERY environment. These vars
// are deliberately NOT in validateProductionConfig's
// required list — fr's image also runs as kag-frontend/kag, whose secret does
// not carry them, and a boot guard on a var one deployment lacks CrashLoops
// that deployment. Failing closed at REQUEST time is safe either way.
// ---------------------------------------------------------------------------
describe('isAuthorizedBySharedSecret', () => {
  const calls = (pairs: Array<[string | null | undefined, string | null]>): string =>
    `return ${JSON.stringify(pairs.map(([s, p]) => [s === undefined ? '__undef__' : s, p]))}.map(([secret, provided]) =>
      ws.isAuthorizedBySharedSecret({
        secret: secret === '__undef__' ? undefined : secret,
        provided,
        envVarName: 'TELEGRAM_WEBHOOK_SECRET',
        receiver: 'telegram-webhook',
      }));`;

  test('production: unset secret → false (FAIL CLOSED); set → exact constant-time match only', () => {
    const r = inChild(
      'production',
      '',
      calls([
        ['', 'anything'],
        [undefined, 'anything'],
        [null, null],
        ['s3cret', 's3cret'],
        ['s3cret', 'nope'],
        ['s3cret', null],
        // near-miss values compare unequal (constant-time path, not ===)
        ['abcdef', 'abcdeg'],
        ['abcdef', 'abcde'],
        ['abcdef', 'abcdeff'],
      ]),
    );
    expect(r).toEqual([false, false, false, true, false, false, false, false, false]);
  });

  test('development: unset secret → true (dev skip); a configured secret is still enforced', () => {
    // The dev skip is for "no secret configured", not "secret configured but
    // wrong" — otherwise a dev deploy with a real secret would accept anything.
    const r = inChild(
      'development',
      '',
      calls([
        ['', null],
        ['s3cret', 'nope'],
        ['s3cret', 's3cret'],
      ]),
    );
    expect(r).toEqual([true, false, true]);
  });
});
