// tests/unit/lib/action-decision-identity.test.ts
//
// ⛔ P1-TEAM-c audit 2 (George 2026-10-15): an agent ACTION runs as the person who approves
// it, so only a VERIFIED-identity seat may decide one. This file is the guard that keeps the
// allowlist (src/lib/action-decision-identity.ts) complete: it enumerates every channel id
// the source can produce and FAILS when one is not classified — a new channel is unverified
// (fail closed) until someone writes down why its sender identity can be trusted.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACTION_DECISION_CHANNEL_TRUST,
  ACTION_DECISION_UNVERIFIED_CODE,
  actionDecisionSeatRefusal,
  assertActionDecisionSeatVerified,
  isVerifiedActionDecisionSeat,
} from '../../../src/lib/action-decision-identity';
import { AppError } from '../../../src/utils/errors';

const SRC = join(import.meta.dir, '../../../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every channel id the inbound adapters can put on an InboundMessage / register under. */
function channelIdsInAdapters(): Set<string> {
  const ids = new Set<string>();
  const dir = join(SRC, 'channels');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const m of text.matchAll(/^\s*name:\s*'([a-z0-9_-]+)'/gm)) ids.add(m[1]!);
    for (const m of text.matchAll(/\bchannel:\s*'([a-z0-9_-]+)'/g)) ids.add(m[1]!);
  }
  return ids;
}

/** Every `handleWebhook('<channel>'` call site in src, with its file. */
function handleWebhookCallSites(): Array<{ file: string; channel: string; index: number; text: string }> {
  const sites: Array<{ file: string; channel: string; index: number; text: string }> = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/handleWebhook\(\s*'([a-z0-9_-]+)'/g)) {
      sites.push({ file, channel: m[1]!, index: m.index ?? 0, text });
    }
  }
  return sites;
}

describe('the action-decision channel allowlist is COMPLETE (fails on an unclassified channel)', () => {
  test('every channel id an inbound adapter can produce is classified', () => {
    const ids = channelIdsInAdapters();
    // Positive control: the scan must actually see the channels (an empty scan would pass).
    for (const known of ['web', 'inapp', 'telegram', 'teams', 'email', 'voice']) expect(ids.has(known)).toBe(true);
    const unclassified = [...ids].filter((id) => !Object.prototype.hasOwnProperty.call(ACTION_DECISION_CHANNEL_TRUST, id));
    expect(unclassified).toEqual([]);
  });

  test('every channel the dispatcher is invoked for (`handleWebhook(\'<channel>\'`) is classified', () => {
    const sites = handleWebhookCallSites();
    // Non-vacuity only: the scan must see the call sites. No count is pinned.
    expect(sites.length).toBeGreaterThan(0);
    const unclassified = sites
      .filter((s) => !Object.prototype.hasOwnProperty.call(ACTION_DECISION_CHANNEL_TRUST, s.channel))
      .map((s) => `${s.channel} @ ${s.file}`);
    expect(unclassified).toEqual([]);
  });

  test('a TRANSPORT-trusted channel (telegram) is dispatched ONLY after its webhook-secret check', () => {
    const transportTrusted = Object.entries(ACTION_DECISION_CHANNEL_TRUST)
      .filter(([, t]) => t === 'telegram_bot_webhook')
      .map(([c]) => c);
    expect(transportTrusted.sort()).toEqual(['telegram']);
    for (const channel of transportTrusted) {
      const sites = handleWebhookCallSites().filter((s) => s.channel === channel);
      expect(sites.length).toBeGreaterThan(0);
      for (const s of sites) {
        const secretAt = s.text.indexOf('isAuthorizedBySharedSecret(');
        expect(secretAt).toBeGreaterThan(-1);
        expect(secretAt).toBeLessThan(s.index);
      }
    }
  });
});

describe('isVerifiedActionDecisionSeat — what each channel must prove', () => {
  test('web / inapp: only with fr\'s own authentication of THIS request', () => {
    for (const channel of ['web', 'inapp']) {
      expect(isVerifiedActionDecisionSeat({ channel, evidence: { keycloakSession: true } })).toBe(true);
      expect(isVerifiedActionDecisionSeat({ channel })).toBe(false);
      expect(isVerifiedActionDecisionSeat({ channel, evidence: { teamsJwt: true } })).toBe(false);
    }
  });

  test('telegram: verified by its authenticated transport', () => {
    expect(isVerifiedActionDecisionSeat({ channel: 'telegram' })).toBe(true);
  });

  test('teams: ONLY with the Bot Framework JWT identity', () => {
    expect(isVerifiedActionDecisionSeat({ channel: 'teams', evidence: { teamsJwt: true } })).toBe(true);
    expect(isVerifiedActionDecisionSeat({ channel: 'teams' })).toBe(false);
    expect(isVerifiedActionDecisionSeat({ channel: 'teams', evidence: { keycloakSession: true } })).toBe(false);
  });

  test('⛔ email, voice, an unknown channel, a prototype key: never verified, whatever the evidence', () => {
    const all = { keycloakSession: true, teamsJwt: true };
    for (const channel of ['email', 'voice', 'p0asig', 'whatsapp', '', 'constructor', '__proto__', 'toString']) {
      expect(isVerifiedActionDecisionSeat({ channel, evidence: all })).toBe(false);
    }
  });
});

describe('the refusal (action rows only)', () => {
  const action = { id: '0b100000-aaaa-4000-8000-0000000000ff', action_id: 'act-1' };
  const plain = { id: '0b100000-aaaa-4000-8000-0000000000fe', action_id: null };

  test('a NON-action approval is never refused here, on any channel', () => {
    for (const channel of ['email', 'teams', 'p0asig']) {
      expect(actionDecisionSeatRefusal({ approval: plain, seat: { channel } })).toBeNull();
    }
  });

  test('an action approval from email ⇒ "approve this in fr" with the link; the throwing form is 403 + code', () => {
    const text = actionDecisionSeatRefusal({ approval: action, seat: { channel: 'email' } });
    expect(text).toContain('Nothing was recorded');
    expect(text).toContain(`Approve it in fr: /approvals/${action.id}`);
    let thrown: unknown;
    try {
      assertActionDecisionSeatVerified({ approval: action, seat: { channel: 'email' } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(403);
    expect((thrown as AppError).code).toBe(ACTION_DECISION_UNVERIFIED_CODE);
  });
});
