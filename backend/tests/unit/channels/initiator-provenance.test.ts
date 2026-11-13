// tests/unit/channels/initiator-provenance.test.ts
//
// `autoApproveForInitiator` decides whether a WRITE action runs inline or parks
// on an approvals queue that is currently ~1300 deep. Until 2026-09-04 the flag
// was DEAD on every path — `channels/index.ts` hardcoded `initiator:'agent'`
// and `routes/agui.ts` types the field `z.literal('agent')` — so four mutating
// actions (kanban.create_card, kanban.add_comment, agent.create_project,
// kaizen.log_candidate) would have parked a row on 100% of invocations,
// including a person typing a command.
//
// ⚠️ WHY THIS FILE EXISTS AT ALL. When the provenance flag was first wired,
// BOTH mutants survived: forcing the heuristic resolver to report
// `matchedDeterministically: true`, and dropping the identity requirement from
// the channel predicate, each left 560 tests passing. The authorisation
// decision had no test that could fail. These cases are written to die.

import { describe, expect, test } from 'bun:test';
import { initiatorFor } from '../../../src/channels/index';
import { HeuristicIntentResolver } from '../../../src/agent-core/resolver';
import '../../../src/routes/tools/kag';

describe('initiatorFor — both conditions required, neither sufficient', () => {
  test('deterministic grammar match + resolved identity → human (self-service)', () => {
    expect(initiatorFor({ matchedDeterministically: true }, 'user-1')).toBe('human');
  });

  test('deterministic match but NO identity → agent', () => {
    // An unlinked sender must never self-approve.
    expect(initiatorFor({ matchedDeterministically: true }, null)).toBe('agent');
    expect(initiatorFor({ matchedDeterministically: true }, undefined)).toBe('agent');
    expect(initiatorFor({ matchedDeterministically: true }, '')).toBe('agent');
  });

  test('resolved identity but NOT deterministic → agent', () => {
    // The LLM chose this action. A real user id does not launder that.
    expect(initiatorFor({ matchedDeterministically: false }, 'user-1')).toBe('agent');
  });

  test('neither → agent', () => {
    expect(initiatorFor({ matchedDeterministically: false }, null)).toBe('agent');
  });

  test('a MISSING flag is not a human claim', () => {
    // Fail closed: an older/foreign resolution that never set the field must
    // not be read as deterministic.
    expect(initiatorFor({}, 'user-1')).toBe('agent');
  });

  test('only the literal boolean true qualifies', () => {
    // Guards against a truthy non-boolean sneaking through a widened type.
    expect(initiatorFor({ matchedDeterministically: 1 as unknown as boolean }, 'user-1')).toBe(
      'agent',
    );
  });
});

describe('resolver provenance — deterministic is NOT the same as human', () => {
  test('the heuristic <tool>.<verb> escape hatch reports NOT deterministic', async () => {
    // The resolver answers `no-action` for an unregistered name, so the branch
    // under test uses a real registered action (kag.scrape_url, import-time).
    // THE TRAP. This path is also a regex, so "a regex matched" cannot be the
    // criterion. It is an AGENT-facing escape hatch: if it claimed determinism,
    // an agent could self-approve its own writes by formatting its request.
    const r = new HeuristicIntentResolver();
    const out = await r.resolveIntent({
      userId: 'u',
      channel: 'telegram',
      text: 'kag.scrape_url {"url":"https://x"}',
      correlationId: 'c1',
    } as never);
    expect(out.kind).toBe('action');
    expect((out as { matchedDeterministically?: boolean }).matchedDeterministically).toBe(false);
    // And it must not be credited as a human even with a real identity.
    expect(initiatorFor(out as { matchedDeterministically?: boolean }, 'user-1')).toBe('agent');
  });
});
