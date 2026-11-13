import { describe, expect, it } from 'vitest';

import { kataErrorText, KATA_STATES, type KataView } from '$lib/api/katas';
import {
  canRelease,
  canRollback,
  canStop,
  cordHeldSeconds,
  evidenceRows,
  evidenceWorkflowId,
  formatSeconds,
  holdingSentence,
  kataTimeline,
  KATA_STATE_LABEL,
  KATA_STATE_TONE,
  minutesSince,
  n8nUiBase,
  n8nVersionLink,
  newKataHref,
  oneLine,
  prettyJson,
  readNewKataPrefill,
  replaysLabel,
  rollbackPending,
  rollbackRefusedLabel,
  validateNewKata,
} from './helpers';

const T0 = Date.parse('2026-11-03T10:00:00.000Z');

function kata(over: Partial<KataView> = {}): KataView {
  return {
    id: '0195f48b-aaaa-7000-8000-000000000001',
    source_project_id: '0195f48b-bbbb-7000-8000-000000000002',
    source_tenant_id: null,
    source_card_id: 'c1',
    source_execution_id: null,
    source_board_id: null,
    source_phase: null,
    symptom: 'rewrite_plan.DOING blocks every card',
    opened_by: 'coach',
    signature: 'sig',
    root_cause_class: null,
    target_flow: null,
    target_flow_id: null,
    base_version_id: null,
    published_version_id: null,
    state: 'running',
    state_detail: null,
    replay_passed: null,
    replay_total: null,
    evidence: {},
    ops: null,
    replays: null,
    linked_cards: [],
    kata_board_id: null,
    kata_card_id: null,
    opened_at: '2026-11-03T09:00:00.000Z',
    qa_at: null,
    published_at: null,
    closed_at: null,
    failed_at: null,
    rollback_requested_at: null,
    rolled_back_at: null,
    cord_engaged_at: null,
    cord_held_seconds: 0,
    cord_released_at: null,
    cord_released_by: null,
    rollback_refused_at: null,
    rollback_refused_reason: null,
    updated_at: '2026-11-03T09:00:00.000Z',
    cord: { held: false, since: null },
    ...over,
  };
}

describe('state rules — mirror the backend transitions', () => {
  it('Stop only in running/qa, Rollback only in published/closed, never both', () => {
    expect(KATA_STATES.filter(canStop)).toEqual(['running', 'qa']);
    expect(KATA_STATES.filter(canRollback)).toEqual(['published', 'closed']);
    for (const s of KATA_STATES) expect(canStop(s) && canRollback(s)).toBe(false);
  });

  it('Release only for a FAILED kata that still holds the cord (George 2026-11-04)', () => {
    const held = { held: true, since: null };
    for (const st of KATA_STATES) expect(canRelease({ state: st, cord_released_at: null, cord: held })).toBe(st === 'failed');
    expect(canRelease({ state: 'failed', cord_released_at: '2026-11-04T10:00:00.000Z', cord: held })).toBe(false);
    // Not in the holder set (e.g. a break-glass clear): nothing to release.
    expect(canRelease({ state: 'failed', cord_released_at: null, cord: { held: false, since: null } })).toBe(false);
  });

  it('rollbackPending: requested and not yet rolled back', () => {
    expect(rollbackPending({ rollback_requested_at: null, rolled_back_at: null })).toBe(false);
    expect(rollbackPending({ rollback_requested_at: '2026-11-04T10:00:00.000Z', rolled_back_at: null })).toBe(true);
    expect(rollbackPending({ rollback_requested_at: '2026-11-04T10:00:00.000Z', rolled_back_at: '2026-11-04T11:00:00.000Z' })).toBe(false);
  });

  it('rollbackRefusedLabel names the guard reason, null when nothing was refused', () => {
    expect(rollbackRefusedLabel({ rollback_refused_reason: null })).toBeNull();
    expect(rollbackRefusedLabel({ rollback_refused_reason: 'kata_rollback_no_base' })).toContain('no base version');
    expect(rollbackRefusedLabel({ rollback_refused_reason: 'kata_rollback_superseded' })).toContain('later kata');
  });

  it('every state has a label and a tone', () => {
    for (const s of KATA_STATES) {
      expect(KATA_STATE_LABEL[s]).toBeTruthy();
      expect(KATA_STATE_TONE[s]).toBeTruthy();
    }
  });
});

describe('time', () => {
  it('minutesSince floors and never goes negative; null without a start', () => {
    expect(minutesSince('2026-11-03T09:47:30.000Z', T0)).toBe(12);
    expect(minutesSince('2026-11-03T10:05:00.000Z', T0)).toBe(0);
    expect(minutesSince(null, T0)).toBeNull();
    expect(minutesSince('garbage', T0)).toBeNull();
  });

  it('formatSeconds', () => {
    expect(formatSeconds(45)).toBe('45 s');
    expect(formatSeconds(720)).toBe('12 min');
    expect(formatSeconds(3 * 3600 + 5 * 60)).toBe('3 h 05 min');
  });

  it('cordHeldSeconds adds the live time of a still-held cord to the closed-out seconds', () => {
    expect(cordHeldSeconds({ cord_held_seconds: 100, cord_engaged_at: null }, T0)).toBe(100);
    expect(cordHeldSeconds({ cord_held_seconds: 100, cord_engaged_at: '2026-11-03T09:59:00.000Z' }, T0)).toBe(160);
  });

  it('holdingSentence: null when nothing holds; minutes when it does; says so when the start is unknown', () => {
    expect(holdingSentence(null, T0)).toBeNull();
    expect(holdingSentence({ kata_id: 'abcdef12-0000', since: '2026-11-03T09:30:00.000Z' }, T0)).toBe(
      'Conveyor paused by kata abcdef12 for 30 min',
    );
    expect(holdingSentence({ kata_id: 'abcdef12-0000', since: null }, T0)).toContain('unrecorded');
  });
});

describe('row text', () => {
  it('replaysLabel is a dash before QA reports, n/total after', () => {
    expect(replaysLabel({ replay_passed: null, replay_total: null })).toBe('—');
    expect(replaysLabel({ replay_passed: 2, replay_total: 3 })).toBe('2/3');
    expect(replaysLabel({ replay_passed: null, replay_total: 3 })).toBe('0/3');
  });

  it('oneLine keeps the first non-empty line and truncates', () => {
    expect(oneLine('\n  first line \nsecond')).toBe('first line');
    expect(oneLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(oneLine(null)).toBe('');
  });
});

describe('kataTimeline', () => {
  it('only the timestamps the row carries, oldest first', () => {
    const tl = kataTimeline(
      kata({
        qa_at: '2026-11-03T09:10:00.000Z',
        published_at: '2026-11-03T09:20:00.000Z',
        rollback_requested_at: '2026-11-03T09:40:00.000Z',
        rolled_back_at: '2026-11-03T09:41:00.000Z',
      }),
    );
    expect(tl.map((e) => e.key)).toEqual(['opened', 'qa', 'published', 'rollback_requested', 'rolled_back']);
    expect(tl[0]!.label).toBe('Opened by coach');
  });

  it('a just-opened kata has exactly one event', () => {
    expect(kataTimeline(kata()).map((e) => e.key)).toEqual(['opened']);
  });
});

describe('json rendering', () => {
  it('prettyJson treats null and empty containers as absent', () => {
    expect(prettyJson(null)).toBeNull();
    expect(prettyJson({})).toBeNull();
    expect(prettyJson([])).toBeNull();
    expect(prettyJson([{ op: 'set' }])).toBe(JSON.stringify([{ op: 'set' }], null, 2));
  });

  it('evidenceRows keeps scalars inline and nests objects as blocks', () => {
    const rows = evidenceRows({ node: 'Parse', check: 3, data: { a: 1 }, block_text: 'a\nb', none: null });
    expect(rows).toEqual([
      { key: 'node', value: 'Parse', block: false },
      { key: 'check', value: '3', block: false },
      { key: 'data', value: JSON.stringify({ a: 1 }, null, 2), block: true },
      { key: 'block_text', value: 'a\nb', block: true },
      { key: 'none', value: '—', block: false },
    ]);
  });
});

describe('n8n links', () => {
  it('base comes from VITE_N8N_UI_URL, trailing slash stripped, prod alias by default', () => {
    expect(n8nUiBase({ VITE_N8N_UI_URL: 'https://n8n.example/' })).toBe('https://n8n.example');
    expect(n8nUiBase({})).toBe('https://n8n.nonagentic.ai');
  });

  it('an exact version link needs a workflow id; without one it is a search for the flow name', () => {
    expect(n8nVersionLink('https://n', 'wf1', 'v9', 'x.DOING')).toEqual({ href: 'https://n/workflow/wf1/history/v9', exact: true });
    expect(n8nVersionLink('https://n', null, 'v9', 'bug_analysis.DOING')).toEqual({
      href: 'https://n/home/workflows?search=bug_analysis.DOING',
      exact: false,
    });
    expect(n8nVersionLink('https://n', null, 'v9', null)).toBeNull();
  });

  it('evidenceWorkflowId reads the coach evidence', () => {
    expect(evidenceWorkflowId({ workflow_id: 'abc' })).toBe('abc');
    expect(evidenceWorkflowId({ workflowId: ' def ' })).toBe('def');
    expect(evidenceWorkflowId({})).toBeNull();
  });
});

describe('New kata — prefill round trip and validation', () => {
  it('the card action URL prefills the form', () => {
    const href = newKataHref({ projectId: '0195f48b-bbbb-7000-8000-000000000002', cardId: 'c 1', tenantId: 't1' });
    expect(href.startsWith('/admin/kata?')).toBe(true);
    const p = readNewKataPrefill(new URL(href, 'https://fr').searchParams);
    expect(p).toEqual({ open: true, tenant: 't1', project: '0195f48b-bbbb-7000-8000-000000000002', card: 'c 1', execution: '' });
  });

  it('without ?new=1 the form stays closed', () => {
    expect(readNewKataPrefill(new URLSearchParams('project=x')).open).toBe(false);
  });

  it('validates what the backend OperatorOpenBody requires', () => {
    expect(validateNewKata({ project: '', card: '', execution: '', symptom: ' ' })).toEqual([
      'Pick a project.',
      'A card id is required.',
      'Describe the symptom.',
    ]);
    expect(
      validateNewKata({ project: '0195f48b-bbbb-7000-8000-000000000002', card: 'c1', execution: '', symptom: 'broken' }),
    ).toEqual([]);
  });
});

describe('kataErrorText — the API error, verbatim', () => {
  it('status, code and the server sentence', () => {
    const body = JSON.stringify({ error: "A kata in state 'failed' cannot move to 'failed'; nothing changed", code: 'kata_invalid_transition' });
    expect(kataErrorText(409, body)).toEqual({
      code: 'kata_invalid_transition',
      message: "HTTP 409 kata_invalid_transition: A kata in state 'failed' cannot move to 'failed'; nothing changed",
    });
  });

  it('a zod body carries its details', () => {
    const body = JSON.stringify({ error: 'Validation error', details: [{ path: ['symptom'], message: 'Required' }] });
    expect(kataErrorText(422, body).message).toBe('HTTP 422: Validation error — symptom: Required');
  });

  it('a non-JSON body is shown raw, an empty one as the status', () => {
    expect(kataErrorText(502, 'Bad Gateway').message).toBe('HTTP 502: Bad Gateway');
    expect(kataErrorText(503, '').message).toBe('HTTP 503');
  });
});
