// Unit tests for the E-7 inbound channel registry.
//
// The registry is a process-wide Map that server.ts fills at boot with the
// real channels. bun runs every test file in one process, so registering a
// channel here would leak into any later file that boots the server (and make
// its `registerChannel` throw DuplicateChannelError). Each case therefore runs
// in a fresh child `bun` process with a clean module state, registering the
// REAL channel modules exactly as server.ts does.
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const BACKEND = resolve(import.meta.dir, '../../..');

function runInChild(script: string): { code: number | null; out: string } {
  const p = Bun.spawnSync(['bun', '-e', script], { cwd: BACKEND, env: process.env });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

describe('channel registry', () => {
  test('register + getChannel round-trip with the real web channel', () => {
    const r = runInChild(`
      const reg = await import('./src/channels/index.ts');
      const { webChannel } = await import('./src/channels/web.ts');
      if (reg.getChannel('web') !== undefined) throw new Error('registry not empty at start');
      reg.registerChannel(webChannel);
      console.log(JSON.stringify({
        same: reg.getChannel('web') === webChannel,
        listed: reg.listChannels().includes(webChannel),
        count: reg.listChannels().length,
      }));
    `);
    expect(r.code).toBe(0);
    expect(r.out).toContain('{"same":true,"listed":true,"count":1}');
  });

  test('duplicate name throws DuplicateChannelError and keeps the first registration', () => {
    const r = runInChild(`
      const reg = await import('./src/channels/index.ts');
      const { webChannel } = await import('./src/channels/web.ts');
      reg.registerChannel(webChannel);
      let error = null;
      try {
        reg.registerChannel(webChannel);
      } catch (e) {
        error = e instanceof reg.DuplicateChannelError ? e.message : 'wrong error: ' + String(e);
      }
      console.log(JSON.stringify({ error, kept: reg.getChannel('web') === webChannel }));
    `);
    expect(r.code).toBe(0);
    expect(r.out).toContain('{"error":"Channel already registered: web","kept":true}');
  });
});
