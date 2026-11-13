// Drift guard for the hand-maintained backend<->frontend channel mirrors.
//
// `event-types.ts` documents itself as "mirrored in
// frontend/src/lib/api/notifications.ts", but nothing enforced it — the two
// lists are edited by hand. What must hold is that the two mirrors describe
// EXACTLY the same set: a channel on one side only renders an option the server
// refuses, or hides one it accepts. ChannelKind must agree with both.
import { test, expect, describe } from 'bun:test';
import { NOTIFICATION_CHANNELS } from '../../../../src/domain/engagement/event-types';

const FRONTEND_DIR = `${import.meta.dir}/../../../../../frontend/src/lib/api`;

async function readSource(file: string): Promise<string> {
  return Bun.file(`${FRONTEND_DIR}/${file}`).text();
}

/** Pull `export const NOTIFICATION_CHANNELS = [...] as const;` out of the source. */
function parseChannelArray(src: string): string[] {
  const m = src.match(/export const NOTIFICATION_CHANNELS\s*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error('frontend NOTIFICATION_CHANNELS not found — did it move?');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** Pull the union members out of `export type ChannelKind = 'a' | 'b';`. */
function parseChannelKind(src: string): string[] {
  const m = src.match(/export type ChannelKind\s*=\s*([^;]+);/);
  if (!m) throw new Error('frontend ChannelKind not found — did it move?');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('backend <-> frontend notification channel mirrors', () => {
  test('every frontend channel is accepted by the backend', async () => {
    const frontend = parseChannelArray(await readSource('notifications.ts'));
    expect(frontend.length).toBeGreaterThan(0);
    for (const ch of frontend) {
      expect(NOTIFICATION_CHANNELS as readonly string[]).toContain(ch);
    }
  });

  test('ChannelKind and NOTIFICATION_CHANNELS describe the same set', async () => {
    const kinds = parseChannelKind(await readSource('channel-prefs.ts')).sort();
    const channels = parseChannelArray(await readSource('notifications.ts')).sort();
    expect(kinds).toEqual(channels);
  });

  test('telegram is surfaced in the UI (budget alerts rely on it)', async () => {
    const frontend = parseChannelArray(await readSource('notifications.ts'));
    expect(frontend).toContain('telegram');
    expect(frontend).toContain('email');
  });

  test('backend and frontend describe the SAME set, and signal is gone from both', async () => {
    const frontend = parseChannelArray(await readSource('notifications.ts'));
    expect(frontend.length).toBeGreaterThan(0);
    expect([...frontend].sort()).toEqual([...(NOTIFICATION_CHANNELS as readonly string[])].sort());
    expect(NOTIFICATION_CHANNELS as readonly string[]).not.toContain('signal');
    expect(frontend).not.toContain('signal');
  });
});
