// tests/unit/services/agent-session-database-url-required.test.ts
//
// George ruling 2026-10-21: no service defaults to a host localhost:5432 Postgres.
// services/agent-session.ts used to fall back to `postgres:postgres@localhost:5432/fr`
// when DATABASE_URL was unset. It must now refuse on first use, naming the variable,
// and must never build a client. DB-free: the refusal fires before any connect.
//
// Each case runs the real module in a FRESH bun process with the env under test,
// so the module-level client cache starts empty without any reset hook.

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { AGENT_SESSION_DATABASE_URL_UNSET_MESSAGE } from '../../../src/services/agent-session';

const MODULE = resolve(import.meta.dir, '../../../src/services/agent-session.ts');

/** Calls issueAgentSession in a child process; returns its rejection message (or 'RESOLVED'). */
async function issueInChild(databaseUrl: string | undefined): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'DATABASE_URL') env[k] = v;
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  const script =
    `const m = await import(${JSON.stringify(MODULE)});` +
    `try { await m.issueAgentSession('00000000-0000-0000-0000-000000000001'); console.log('RESOLVED'); }` +
    `catch (e) { console.log(String(e && e.message)); }` +
    `process.exit(0);`;
  const proc = Bun.spawn([process.execPath, '-e', script], { env, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().split('\n').pop() ?? '';
}

describe('agent-session has no default DATABASE_URL', () => {
  test('unset DATABASE_URL refuses with a message naming the variable', async () => {
    expect(await issueInChild(undefined)).toBe(AGENT_SESSION_DATABASE_URL_UNSET_MESSAGE);
    expect(AGENT_SESSION_DATABASE_URL_UNSET_MESSAGE).toContain('DATABASE_URL is not set');
  });

  test('a whitespace-only DATABASE_URL is treated as unset', async () => {
    expect(await issueInChild('   ')).toContain('DATABASE_URL is not set');
  });

  test('the source carries no localhost DSN default', async () => {
    const src = await Bun.file(new URL('../../../src/services/agent-session.ts', import.meta.url)).text();
    expect(src).not.toMatch(/DATABASE_URL\s*\|\|\s*['"]postgres/);
  });
});
