// tests/unit/lib/start-events.test.ts — U-PS-EVT (PSD §9; AT10's fr half): enum-only start
// events, free text refused by the schema, platform-only consumption.

import { describe, expect, test } from 'bun:test';

import {
  START_CHECK_CODES,
  START_EVENT_TYPES,
  consumableStartEvents,
  validateStartEvent,
} from '../../../src/lib/start-events';
import {
  AA_CONVEYOR_TENANT_ID,
  EXECUTION_TENANT_ID,
  INTERNAL_SYSTEM_TENANT_ID,
} from '../../../src/middleware/internal-tenant-only';

const CUSTOMER = '11111111-2222-4333-8444-555555555555';
const PROJECT = '0195f48b-0000-7000-8000-00000000abcd';
const TEMPLATE = `it.bug_hunt@${'a'.repeat(64)}`;
const ok = (over: Record<string, unknown> = {}) => ({
  event: 'start.outline_rejected',
  tenant_id: EXECUTION_TENANT_ID,
  project_id: PROJECT,
  template: TEMPLATE,
  outline_version: 2,
  code: 'scope_wrong',
  ...over,
});

describe('schema: ids and enum codes only', () => {
  test('positive control — one valid event of every type', () => {
    const samples: Record<string, unknown>[] = [
      ok({ event: 'start.template_question', code: 'multi_candidate', template: null, outline_version: null }),
      ok({ event: 'start.param_question', code: 'param:target_repo' }),
      ok({ event: 'start.check_failed', code: 'deferred_minter_missing' }),
      ok(),
      ...(['plan.gap_card', 'plan.reclassify', 'plan.split_beyond_plan'] as const).map((event) => {
        const { code: _c, ...rest } = ok({ event });
        return { ...rest, card_ids: ['1612345678901234567'] };
      }),
    ];
    expect(samples.map((s) => s.event)).toEqual([...START_EVENT_TYPES]);
    for (const s of samples) expect(validateStartEvent(s)).toMatchObject({ ok: true });
  });

  test('every PSD §7 check code is accepted on start.check_failed', () => {
    for (const code of START_CHECK_CODES) expect(validateStartEvent(ok({ event: 'start.check_failed', code })).ok).toBe(true);
  });

  test('MUST-FAIL: a free-text key (reason / message / comment) is refused, not stripped', () => {
    for (const key of ['reason', 'message', 'comment', 'reject_text']) {
      expect(validateStartEvent(ok({ [key]: 'the customer says the scope is wrong because…' })).ok).toBe(false);
    }
  });

  test('MUST-FAIL: free text in the code / a param name / a card id / the template is refused', () => {
    expect(validateStartEvent(ok({ code: 'scope is wrong, see call notes' })).ok).toBe(false);
    expect(validateStartEvent(ok({ event: 'start.param_question', code: 'param:the target repo please' })).ok).toBe(false);
    expect(validateStartEvent(ok({ event: 'start.check_failed', code: 'card_type_unknown: development_magic' })).ok).toBe(false);
    expect(validateStartEvent(ok({ template: 'my favourite template' })).ok).toBe(false);
    const { code: _c, ...plan } = ok({ event: 'plan.gap_card' });
    expect(validateStartEvent({ ...plan, card_ids: ['card one has a gap'] }).ok).toBe(false);
    expect(validateStartEvent({ ...plan, card_ids: ['1'], code: 'scope_wrong' }).ok).toBe(false);
  });

  test('an unknown event type is refused', () => {
    expect(validateStartEvent(ok({ event: 'start.freeform_note' })).ok).toBe(false);
  });
});

describe('consumption: platform-only (PSD §9 consumption rule)', () => {
  const platformEv = ok();
  const customerEv = ok({ tenant_id: CUSTOMER });

  test('a platform reader consumes platform-tenant events', () => {
    for (const reader of [EXECUTION_TENANT_ID, INTERNAL_SYSTEM_TENANT_ID, AA_CONVEYOR_TENANT_ID]) {
      expect(consumableStartEvents(reader, [platformEv]).events).toHaveLength(1);
    }
  });

  test('MUST-FAIL: a NON-platform reader consumes nothing, even platform events', () => {
    const r = consumableStartEvents(CUSTOMER, [platformEv, customerEv]);
    expect(r.events).toEqual([]);
    expect(r.dropped.non_platform_reader).toBe(2);
    expect(consumableStartEvents(null, [platformEv]).events).toEqual([]);
  });

  test('MUST-FAIL: a customer tenant’s event is never consumed by a platform reader', () => {
    const r = consumableStartEvents(EXECUTION_TENANT_ID, [customerEv, platformEv]);
    expect(r.events.map((e) => e.tenant_id)).toEqual([EXECUTION_TENANT_ID]);
    expect(r.dropped.non_platform_event).toBe(1);
  });

  test('an invalid (free-text) event is dropped and counted, never repaired', () => {
    const r = consumableStartEvents(EXECUTION_TENANT_ID, [ok({ reason: 'prose' }), platformEv]);
    expect(r.events).toHaveLength(1);
    expect(r.dropped.invalid).toBe(1);
  });
});
