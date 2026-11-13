// tests/unit/services/keycloak-jwks-lazy.test.ts
//
// Pins that `src/services/keycloak.ts` can be IMPORTED with no Keycloak env.
//
// fr#1597 regression: `defaultJWKS` was built eagerly at module load with
// `new URL(`${config.keycloak.url}/realms/...`)`, which throws ERR_INVALID_URL
// when KEYCLOAK_URL is empty. P2-b added the edge
//   agent/project-asset-guard -> routes/assets/_lib/governed-asset-write-gate
//   -> middleware/request-context -> services/keycloak
// so any script importing it with NO Keycloak env crashed at import.
//
// ⚠️ WHY A SUBPROCESS WITH A SCRUBBED ENV. `tests/setup-env.ts` (bunfig
// preload) sets KEYCLOAK_URL for every test process, and a plain
// `Bun.spawnSync` inherits it. Every spawn here deletes every KEYCLOAK_* var first.

import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const BACKEND_DIR = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const KEYCLOAK_MODULE = join(BACKEND_DIR, 'src', 'services', 'keycloak.ts');

function envWithoutKeycloak(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('KEYCLOAK_')) continue;
    env[k] = v;
  }
  return env;
}

function spawn(cmd: string[]) {
  const proc = Bun.spawnSync(cmd, { cwd: BACKEND_DIR, env: envWithoutKeycloak() });
  return { exitCode: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe('services/keycloak — importable with no Keycloak env', () => {
  test('the scrubbed env really has no KEYCLOAK_URL (control)', () => {
    const r = spawn(['bun', '-e', 'console.log(JSON.stringify(process.env.KEYCLOAK_URL ?? null))']);
    expect(r.exitCode).toBe(0);
    expect(r.out.trim().split('\n').pop()).toBe('null');
  });

  test('importing the module does not throw; defaultJWKS is a resolver', () => {
    const script = `
      const m = await import(${JSON.stringify(KEYCLOAK_MODULE)});
      console.log('TYPE=' + typeof m.defaultJWKS);
    `;
    const r = spawn(['bun', '-e', script]);
    expect(r.out).not.toContain('ERR_INVALID_URL');
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('TYPE=function');
  });

  test('the invalid URL surfaces only on first key lookup, as a rejection', () => {
    const script = `
      const m = await import(${JSON.stringify(KEYCLOAK_MODULE)});
      try {
        await m.defaultJWKS({ alg: 'RS256', kid: 'x' }, { payload: '', signature: '' });
        console.log('RESULT=resolved');
      } catch (e) {
        console.log('RESULT=' + (e && e.code));
      }
    `;
    const r = spawn(['bun', '-e', script]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('RESULT=ERR_INVALID_URL');
  });
});
