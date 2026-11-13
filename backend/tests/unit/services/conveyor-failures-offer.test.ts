// tests/unit/services/conveyor-failures-offer.test.ts
//
// R311 PR 5 (kanban-coach-errors.md §2.5, R-8) — the start retry OFFER is a pure
// function of fr's records (no judgement): the latest attempt's outcome and the
// `start_failed` notices that belong to it. And the retry key shape: attempt 0
// keeps the bare `<fr id>`, attempt n sends `<fr id>:retry-<n>`.
import { describe, expect, test } from 'bun:test';

import { CONVEYOR_START_REFUSAL_CODES } from '../../../src/services/conveyor-start-webhook';
import {
  REFUSAL_MESSAGE_UNKNOWN,
  REFUSAL_MESSAGES,
  NO_PROGRESS_MS,
  RESTART_NOT_DONE_MESSAGE,
  STALE_PENDING_MS,
  STALLED_MS,
  STALLED_RETRY_MARK,
  isStalledRestartRefusal,
  isStalledRetry,
  restartNotDone,
  cardPhaseFieldsOf,
  computeRestartOffer,
  computeRetryOffer,
  restartablePhases,
  isRestartAttempt,
  needsProgressFacts,
  restartIdempotencyKey,
  startIdempotencyKey,
  type AttemptRow,
} from '../../../src/services/conveyor-failures';

const P = '0199aaaa-0000-7000-8000-0000000c3e01';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

function attempt(n: number, outcome: AttemptRow['outcome'], createdMsAgo = 60_000, detail: string | null = null): AttemptRow {
  return {
    id: `a-${n}`,
    project_id: P,
    tenant_id: 't',
    attempt_n: n,
    idempotency_key: startIdempotencyKey(P, n),
    requested_by: n === 0 ? null : 'u',
    outcome,
    outcome_detail: detail,
    created_at: at(createdMsAgo),
    completed_at: null,
  };
}

const offer = (attempts: AttemptRow[], startFailures: Array<{ idempotency_key: string | null; created_at: Date }> = []) =>
  computeRetryOffer({ frProjectId: P, attempts, startFailures, now: NOW });

describe('startIdempotencyKey', () => {
  test('attempt 0 is the bare fr id (a start that never failed is unchanged); retry n is <fr id>:retry-<n>', () => {
    expect(startIdempotencyKey(P, 0)).toBe(P);
    expect(startIdempotencyKey(P, 1)).toBe(`${P}:retry-1`);
    expect(startIdempotencyKey(P, 12)).toBe(`${P}:retry-12`);
  });
});

describe('computeRetryOffer', () => {
  test('no record at all ⇒ not offered (no_start_recorded); a start_failed with no attempt ⇒ retry 1', () => {
    expect(offer([])).toEqual({ available: false, reason: 'no_start_recorded' });
    expect(offer([], [{ idempotency_key: null, created_at: at(1) }])).toEqual({
      available: true,
      reason: 'start_failed',
      next_attempt_n: 1,
      next_idempotency_key: `${P}:retry-1`,
    });
  });

  test('delivered ⇒ started (not offered); inert ⇒ conveyor_not_configured', () => {
    expect(offer([attempt(0, 'delivered')])).toEqual({ available: false, reason: 'started' });
    expect(offer([attempt(0, 'inert')])).toEqual({ available: false, reason: 'conveyor_not_configured' });
  });

  test('board_link_failed ⇒ no_board_link (R-8); failed ⇒ not_delivered; next key follows the LATEST attempt', () => {
    expect(offer([attempt(0, 'delivered'), attempt(1, 'board_link_failed')])).toMatchObject({
      available: true,
      reason: 'no_board_link',
      next_attempt_n: 2,
      next_idempotency_key: `${P}:retry-2`,
    });
    expect(offer([attempt(0, 'failed')])).toMatchObject({ available: true, reason: 'not_delivered', next_attempt_n: 1 });
  });

  test('pending ⇒ start_in_flight; a pending older than the stale window reads as not_delivered', () => {
    expect(offer([attempt(0, 'pending', 5_000)])).toEqual({ available: false, reason: 'start_in_flight' });
    expect(offer([attempt(0, 'pending', STALE_PENDING_MS + 1)])).toMatchObject({ available: true, reason: 'not_delivered' });
  });

  test("a start_failed binds to the attempt by KEY: the latest attempt's re-opens the offer, an older attempt's does not", () => {
    const attempts = [attempt(0, 'delivered', 600_000), attempt(1, 'delivered', 60_000)];
    expect(offer(attempts, [{ idempotency_key: P, created_at: at(1) }])).toEqual({ available: false, reason: 'started' });
    expect(offer(attempts, [{ idempotency_key: `${P}:retry-1`, created_at: at(1) }])).toMatchObject({
      available: true,
      reason: 'start_failed',
      next_idempotency_key: `${P}:retry-2`,
    });
  });

  test('a start_failed with no key binds by time (fr clock): after the latest attempt only', () => {
    const attempts = [attempt(0, 'delivered', 60_000)];
    expect(offer(attempts, [{ idempotency_key: null, created_at: at(120_000) }])).toEqual({ available: false, reason: 'started' });
    expect(offer(attempts, [{ idempotency_key: null, created_at: at(1_000) }])).toMatchObject({ available: true, reason: 'start_failed' });
  });
});

describe('U1: the conveyor refused the start (409 {code}) or rejected it as malformed (400)', () => {
  test.each(CONVEYOR_START_REFUSAL_CODES.map((c) => [c]))('refused %s ⇒ not offered, refused_by_conveyor + the code + its text', (code) => {
    expect(offer([attempt(0, 'refused', 60_000, code)])).toEqual({
      available: false,
      reason: 'refused_by_conveyor',
      code,
      message: REFUSAL_MESSAGES[code],
    });
  });

  test('a refusal outranks a start_failed notice for the same attempt (a retry would be refused again)', () => {
    expect(offer([attempt(0, 'refused', 60_000, 'psra_exists')], [{ idempotency_key: P, created_at: at(1) }])).toMatchObject({
      available: false,
      reason: 'refused_by_conveyor',
      code: 'psra_exists',
    });
  });

  test('a refusal with an unknown or missing code ⇒ not offered, the generic text', () => {
    expect(offer([attempt(0, 'refused', 60_000, 'unrecognised')])).toEqual({
      available: false,
      reason: 'refused_by_conveyor',
      code: 'unrecognised',
      message: REFUSAL_MESSAGE_UNKNOWN,
    });
    expect(offer([attempt(0, 'refused', 60_000, null)])).toMatchObject({ code: 'unrecognised', message: REFUSAL_MESSAGE_UNKNOWN });
  });

  test('only the LATEST attempt counts: a refused attempt 0 followed by a failed retry 1 offers retry 2', () => {
    expect(offer([attempt(0, 'refused', 600_000, 'phase_not_setup'), attempt(1, 'failed', 60_000, 'HTTP 502')])).toMatchObject({
      available: true,
      reason: 'not_delivered',
      next_attempt_n: 2,
    });
  });

  test('failed with HTTP 400 ⇒ not offered (start_request_invalid); any other failure ⇒ not_delivered', () => {
    expect(offer([attempt(0, 'failed', 60_000, 'HTTP 400: the conveyor rejected the start request as malformed')])).toEqual({
      available: false,
      reason: 'start_request_invalid',
    });
    expect(offer([attempt(0, 'failed', 60_000, 'HTTP 400 missing_idempotency_key: x')])).toEqual({
      available: false,
      reason: 'start_request_invalid',
    });
    expect(offer([attempt(0, 'failed', 60_000, 'HTTP 4000')])).toMatchObject({ available: true, reason: 'not_delivered' });
    expect(offer([attempt(0, 'failed', 60_000, 'HTTP 401')])).toMatchObject({ available: true, reason: 'not_delivered' });
  });

  test('200 duplicate / resumed are recorded as delivered ⇒ started', () => {
    expect(offer([attempt(0, 'delivered', 60_000, 'HTTP 200 duplicate')])).toEqual({ available: false, reason: 'started' });
    expect(offer([attempt(0, 'delivered', 60_000, 'HTTP 200 resumed')])).toEqual({ available: false, reason: 'started' });
  });

  test('the member texts are customer copy: no internal system or card names, no codes', () => {
    for (const text of [...Object.values(REFUSAL_MESSAGES), REFUSAL_MESSAGE_UNKNOWN]) {
      expect(text).not.toMatch(/planka|n8n|psra|kanban|webhook|requirements[_ ]management|\brm\b|\bfr\b|card[ _-]?id|_/i);
      expect(text.length).toBeGreaterThan(30);
    }
    expect(Object.keys(REFUSAL_MESSAGES).sort()).toEqual([...CONVEYOR_START_REFUSAL_CODES].sort());
  });
});

describe('R319: a delivered start that made no progress ("Start again")', () => {
  const waiting = { startCardLeftTodo: false, onHold: false, list: 'TODO' };
  const run = (attempts: AttemptRow[], progress: Parameters<typeof computeRetryOffer>[0]['progress'], failures: Array<{ idempotency_key: string | null; created_at: Date }> = []) =>
    computeRetryOffer({ frProjectId: P, attempts, startFailures: failures, now: NOW, progress });

  test('delivered ≥ 10 min ago + start card still in TODO ⇒ offered no_progress with the next retry key', () => {
    expect(run([attempt(0, 'delivered', NO_PROGRESS_MS + 1)], waiting)).toEqual({
      available: true,
      reason: 'no_progress',
      next_attempt_n: 1,
      next_idempotency_key: `${P}:retry-1`,
    });
    expect(run([attempt(0, 'delivered', NO_PROGRESS_MS * 3), attempt(1, 'delivered', NO_PROGRESS_MS)], waiting)).toMatchObject({
      reason: 'no_progress',
      next_idempotency_key: `${P}:retry-2`,
    });
  });

  test('the 10 minutes run from the ANSWER (completed_at), else from the attempt', () => {
    const a = { ...attempt(0, 'delivered', NO_PROGRESS_MS * 2), completed_at: at(60_000) };
    expect(run([a], waiting)).toEqual({ available: false, reason: 'started' });
    expect(run([{ ...a, completed_at: at(NO_PROGRESS_MS) }], waiting)).toMatchObject({ available: true, reason: 'no_progress' });
  });

  test('progress, unknown progress, a fresh delivery or a hold ⇒ nothing offered', () => {
    const old = [attempt(0, 'delivered', NO_PROGRESS_MS + 1)];
    expect(run(old, { startCardLeftTodo: true, onHold: false, list: 'DOING' })).toEqual({ available: false, reason: 'started' });
    expect(run(old, null)).toEqual({ available: false, reason: 'started' });
    expect(run(old, undefined)).toEqual({ available: false, reason: 'started' });
    expect(run([attempt(0, 'delivered', NO_PROGRESS_MS - 1_000)], waiting)).toEqual({ available: false, reason: 'started' });
    expect(run(old, { startCardLeftTodo: false, onHold: true })).toEqual({ available: false, reason: 'on_hold' });
  });

  test('progress never overrides the other outcomes (pending, refused, a start_failed keeps its own reason)', () => {
    expect(run([attempt(0, 'pending', 5_000)], waiting)).toEqual({ available: false, reason: 'start_in_flight' });
    expect(run([attempt(0, 'refused', NO_PROGRESS_MS * 2, 'psra_exists')], waiting)).toMatchObject({ reason: 'refused_by_conveyor' });
    expect(run([attempt(0, 'delivered', NO_PROGRESS_MS * 2)], waiting, [{ idempotency_key: P, created_at: at(1) }])).toMatchObject({
      available: true,
      reason: 'start_failed',
    });
  });

  test('needsProgressFacts: only a delivered start ≥ 10 min old that nothing else decides reads the board', () => {
    const needs = (attempts: AttemptRow[], failures: Array<{ idempotency_key: string | null; created_at: Date }> = []) =>
      needsProgressFacts({ frProjectId: P, attempts, startFailures: failures, now: NOW });
    expect(needs([attempt(0, 'delivered', NO_PROGRESS_MS + 1)])).toBe(true);
    expect(needs([attempt(0, 'delivered', 60_000)])).toBe(false);
    expect(needs([attempt(0, 'failed', NO_PROGRESS_MS * 2)])).toBe(false);
    expect(needs([attempt(0, 'pending', NO_PROGRESS_MS * 2)])).toBe(false);
    expect(needs([attempt(0, 'refused', NO_PROGRESS_MS * 2, 'psra_exists')])).toBe(false);
    expect(needs([])).toBe(false);
    expect(needs([attempt(0, 'delivered', NO_PROGRESS_MS * 2)], [{ idempotency_key: P, created_at: at(1) }])).toBe(false);
  });
});

describe('R320: a STALLED start card (READY/DOING) — the offer matrix', () => {
  const answered = (n: number, minutesAgo: number, outcome: AttemptRow['outcome'] = 'delivered', detail: string | null = 'HTTP 200'): AttemptRow => ({
    ...attempt(n, outcome, (minutesAgo + 1) * 60_000, detail),
    completed_at: at(minutesAgo * 60_000),
  });
  const facts = (list: string, o: { movedMinutesAgo?: number | null; pending?: boolean; hold?: boolean } = {}) => ({
    startCardLeftTodo: list !== 'TODO',
    list,
    listChangedAt: o.movedMinutesAgo == null ? null : at(o.movedMinutesAgo * 60_000).toISOString(),
    pendingApproval: o.pending ?? false,
    onHold: o.hold ?? false,
  });
  const run = (attempts: AttemptRow[], progress: ReturnType<typeof facts> | null, stalledRetry: boolean) =>
    computeRetryOffer({ frProjectId: P, attempts, startFailures: [], now: NOW, progress, stalledRetry });
  const STALLED_MIN = STALLED_MS / 60_000;

  const cases: Array<[string, string, number, boolean, boolean, boolean, string]> = [];
  for (const list of ['READY', 'DOING'])
    for (const age of [STALLED_MIN - 1, STALLED_MIN, STALLED_MIN * 3])
      for (const pending of [false, true])
        for (const hold of [false, true])
          for (const flag of [false, true]) {
            const expected = !flag || age < STALLED_MIN || pending ? 'started' : hold ? 'on_hold' : 'stalled';
            cases.push([list, `${age}m`, age, pending, hold, flag, expected]);
          }
  test.each(cases)('%s, %s since the last change, pending=%p, hold=%p, flag=%p ⇒ %s', (list, _label, age, pending, hold, flag, expected) => {
    // The card moved and the start was answered `age` minutes ago (the newer of the two counts).
    const offer = run([answered(0, age + 5)], facts(list, { movedMinutesAgo: age, pending, hold }), flag);
    expect(offer.reason as string).toBe(expected);
    if (expected === 'stalled') expect(offer).toEqual({ available: true, reason: 'stalled', next_attempt_n: 1, next_idempotency_key: `${P}:retry-1` });
    else expect(offer.available).toBe(false);
  });

  test('the newer of the card move and the start answer counts; an absent or unparseable move stamp counts as absent', () => {
    expect(run([answered(0, STALLED_MIN - 1)], facts('DOING', { movedMinutesAgo: 120 }), true).reason).toBe('started');
    expect(run([answered(0, STALLED_MIN)], facts('DOING', { movedMinutesAgo: null }), true).reason).toBe('stalled');
    expect(run([answered(0, STALLED_MIN)], { ...facts('DOING'), listChangedAt: 'not a date' }, true).reason).toBe('stalled');
  });

  test('QA, DONE, BLOCKED and an unknown list never stall; TODO keeps its R319 no_progress', () => {
    for (const list of ['QA', 'DONE', 'BLOCKED', '']) {
      expect(run([answered(0, 120)], facts(list, { movedMinutesAgo: 120 }), true)).toEqual({ available: false, reason: 'started' });
    }
    expect(run([answered(0, 120)], facts('TODO', { movedMinutesAgo: 120 }), true).reason).toBe('no_progress');
  });

  test('unknown progress ⇒ nothing new, flag on or off', () => {
    expect(run([answered(0, 120)], null, true)).toEqual({ available: false, reason: 'started' });
  });

  test("the old answers to a stalled restart ⇒ restart_not_done with the member's text, until it stalls again", () => {
    const mark = ` ${STALLED_RETRY_MARK}`;
    for (const [outcome, detail] of [
      ['refused', `psra_exists${mark}`],
      ['delivered', `HTTP 200 duplicate${mark}`],
      ['delivered', `HTTP 200${mark}`],
    ] as const) {
      const recent = [answered(0, 120), answered(1, 2, outcome, detail)];
      expect(run(recent, facts('DOING', { movedMinutesAgo: 120 }), true)).toEqual({
        available: false,
        reason: 'restart_not_done',
        message: RESTART_NOT_DONE_MESSAGE,
      });
      // Another STALLED_MS after that answer ⇒ offered again: nothing is stranded.
      const later = [answered(0, 120), answered(1, STALLED_MIN, outcome, detail)];
      expect(run(later, facts('DOING', { movedMinutesAgo: 120 }), true)).toMatchObject({ available: true, reason: 'stalled', next_attempt_n: 2 });
      // A pending approval keeps it at "could not restart" (no new offer).
      expect(run(later, facts('DOING', { movedMinutesAgo: 120, pending: true }), true).reason).toBe('restart_not_done');
    }
  });

  test('the new answers (restarted, running, resumed) ⇒ started; the card moving on ⇒ the refusal reads as before', () => {
    const mark = ` ${STALLED_RETRY_MARK}`;
    for (const detail of ['HTTP 200 restarted', 'HTTP 200 running', 'HTTP 200 resumed']) {
      expect(run([answered(0, 120), answered(1, 2, 'delivered', detail + mark)], facts('DOING', { movedMinutesAgo: 120 }), true)).toEqual({
        available: false,
        reason: 'started',
      });
    }
    const refused = [answered(0, 120), answered(1, 2, 'refused', `psra_exists${mark}`)];
    expect(run(refused, facts('QA', { movedMinutesAgo: 1 }), true)).toMatchObject({ reason: 'refused_by_conveyor', code: 'psra_exists' });
    expect(run(refused, null, true)).toMatchObject({ reason: 'refused_by_conveyor', code: 'psra_exists', message: REFUSAL_MESSAGES.psra_exists });
    // Flag turned off after the restart: the existing wording.
    expect(run(refused, facts('DOING', { movedMinutesAgo: 120 }), false)).toMatchObject({ reason: 'refused_by_conveyor', code: 'psra_exists' });
  });

  test('isStalledRetry / restartNotDone read the mark; an unmarked refusal is final as before', () => {
    expect(isStalledRetry({ outcome_detail: `psra_exists ${STALLED_RETRY_MARK}` })).toBe(true);
    expect(isStalledRetry({ outcome_detail: 'psra_exists' })).toBe(false);
    expect(isStalledRetry({ outcome_detail: null })).toBe(false);
    expect(restartNotDone({ outcome: 'failed', outcome_detail: `HTTP 502 ${STALLED_RETRY_MARK}` })).toBe(false);
    expect(run([answered(0, 2, 'refused', 'psra_exists')], facts('DOING', { movedMinutesAgo: 120 }), true)).toMatchObject({
      reason: 'refused_by_conveyor',
    });
  });

  test('needsProgressFacts (flag on): a stalled restart\'s answer is read at once; a refused one too', () => {
    const needs = (attempts: AttemptRow[], stalledRetry = true) => needsProgressFacts({ frProjectId: P, attempts, startFailures: [], now: NOW, stalledRetry });
    expect(needs([answered(0, 120), answered(1, 1, 'delivered', `HTTP 200 duplicate ${STALLED_RETRY_MARK}`)])).toBe(true);
    expect(needs([answered(0, 120), answered(1, 1, 'refused', `psra_exists ${STALLED_RETRY_MARK}`)])).toBe(true);
    expect(needs([answered(0, 120), answered(1, 1, 'failed', `HTTP 502`)])).toBe(false);
    // Flag off: R319's rule exactly — a fresh answer or a refusal is never read.
    expect(needs([answered(0, 120), answered(1, 1, 'delivered', `HTTP 200 duplicate ${STALLED_RETRY_MARK}`)], false)).toBe(false);
    expect(needs([answered(0, 120), answered(1, 120, 'refused', `psra_exists ${STALLED_RETRY_MARK}`)], false)).toBe(false);
    expect(needs([answered(0, 120)], false)).toBe(true);
  });

  // Parity with main (bc9947c14): with the flag OFF the offer for every board fr can read is
  // R319's — TODO (one or more start cards, all in TODO) ⇒ no_progress, anything past TODO ⇒ started.
  const PARITY: Array<[string, ReturnType<typeof facts> | { startCardLeftTodo: boolean; onHold: boolean; list: string; listChangedAt: null }, string]> = [
    ['one start card in TODO', facts('TODO', { movedMinutesAgo: 120 }), 'no_progress'],
    ['two start cards both in TODO', { startCardLeftTodo: false, onHold: false, list: '', listChangedAt: null }, 'no_progress'],
    ['READY', facts('READY', { movedMinutesAgo: 120 }), 'started'],
    ['DOING', facts('DOING', { movedMinutesAgo: 120 }), 'started'],
    ['BLOCKED', facts('BLOCKED', { movedMinutesAgo: 120 }), 'started'],
    ['two start cards, one past TODO', { startCardLeftTodo: true, onHold: false, list: '', listChangedAt: null }, 'started'],
  ];
  test.each(PARITY)('parity (flag off): %s ⇒ %s, as on main', (_label, progress, expected) => {
    const attempts = [answered(0, 120)];
    expect(needsProgressFacts({ frProjectId: P, attempts, startFailures: [], now: NOW, stalledRetry: false })).toBe(true);
    const offer = computeRetryOffer({ frProjectId: P, attempts, startFailures: [], now: NOW, progress, stalledRetry: false });
    // main's rule, written out: progress && !startCardLeftTodo && delivered ≥ 10 min ⇒ no_progress (on_hold when held), else started.
    const main = !progress.startCardLeftTodo ? 'no_progress' : 'started';
    expect(main).toBe(expected);
    expect(offer.reason as string).toBe(expected);
    // Held ⇒ on_hold only where main offered no_progress.
    const held = computeRetryOffer({ frProjectId: P, attempts, startFailures: [], now: NOW, progress: { ...progress, onHold: true }, stalledRetry: false });
    expect(held.reason as string).toBe(expected === 'no_progress' ? 'on_hold' : 'started');
  });

  test('flag on: two start cards both in TODO still offer no_progress (the exactly-one rule is only for stalled)', () => {
    const twoInTodo = { startCardLeftTodo: false, onHold: false, list: '', listChangedAt: null };
    expect(computeRetryOffer({ frProjectId: P, attempts: [answered(0, 120)], startFailures: [], now: NOW, progress: twoInTodo, stalledRetry: true }).reason).toBe(
      'no_progress',
    );
    const twoPast = { startCardLeftTodo: true, onHold: false, list: '', listChangedAt: null };
    expect(computeRetryOffer({ frProjectId: P, attempts: [answered(0, 120)], startFailures: [], now: NOW, progress: twoPast, stalledRetry: true }).reason).toBe(
      'started',
    );
  });

  test('only a marked 409 psra_exists is non-final; any other marked refusal code is final as before', () => {
    expect(isStalledRestartRefusal({ outcome: 'refused', outcome_detail: 'psra_exists stalled_retry' })).toBe(true);
    expect(isStalledRestartRefusal({ outcome: 'refused', outcome_detail: 'psra_exists' })).toBe(false);
    expect(isStalledRestartRefusal({ outcome: 'delivered', outcome_detail: 'HTTP 200 stalled_retry' })).toBe(false);
    for (const code of ['phase_not_setup', 'project_mismatch', 'tenant_mismatch', 'something_new']) {
      const detail = `${code} ${STALLED_RETRY_MARK}`;
      expect(isStalledRestartRefusal({ outcome: 'refused', outcome_detail: detail })).toBe(false);
      expect(restartNotDone({ outcome: 'refused', outcome_detail: detail })).toBe(false);
      const refused = answered(1, STALLED_MIN * 3, 'refused', detail);
      const base = { frProjectId: P, attempts: [refused], startFailures: [], now: NOW, stalledRetry: true };
      expect(needsProgressFacts(base)).toBe(false);
      expect(computeRetryOffer({ ...base, progress: facts('DOING', { movedMinutesAgo: 120 }) })).toMatchObject({
        available: false,
        reason: 'refused_by_conveyor',
        code,
      });
    }
  });

  test('the restart text is customer copy', () => {
    expect(RESTART_NOT_DONE_MESSAGE).not.toMatch(/planka|n8n|psra|kanban|webhook|conveyor|\brm\b|\bfr\b|_/i);
  });
});

// George 2026-10-31: "Start again" is ALSO a real restart of the project or its current phase.
describe('restart: the key, the offer, and how a restart attempt reads in the start-card retry offer', () => {
  const restartAttempt = (n: number, outcome: AttemptRow['outcome'], createdMsAgo = 60_000): AttemptRow => ({
    ...attempt(n, outcome, createdMsAgo),
    idempotency_key: restartIdempotencyKey(P, n),
  });
  const restartOffer = (over: Partial<Parameters<typeof computeRestartOffer>[0]> = {}) =>
    computeRestartOffer({
      frProjectId: P,
      attempts: [attempt(0, 'delivered')],
      now: NOW,
      live: true,
      delivered: false,
      phase: 'execution',
      configured: true,
      onHold: false,
      ...over,
    });

  test('the key is <fr id>:restart-<n>, in the same numbering; isRestartAttempt tells it from a retry', () => {
    expect(restartIdempotencyKey(P, 3)).toBe(`${P}:restart-3`);
    expect(isRestartAttempt(restartAttempt(3, 'pending'))).toBe(true);
    expect(isRestartAttempt(attempt(3, 'pending'))).toBe(false);
    expect(isRestartAttempt(attempt(0, 'delivered'))).toBe(false);
  });

  test('offered for an active, undelivered project with the next attempt number and the RM phase', () => {
    expect(restartOffer()).toEqual({ available: true, phase: 'execution', next_attempt_n: 1, next_idempotency_key: `${P}:restart-1` });
    expect(restartOffer({ attempts: [attempt(0, 'delivered'), attempt(1, 'delivered')] })).toMatchObject({ next_attempt_n: 2 });
    // No attempt on record: still offered (n starts at 1 — 0 is the create's bare key).
    expect(restartOffer({ attempts: [] })).toMatchObject({ available: true, next_attempt_n: 1 });
    // Phase unknown: a project restart is still offered; the phase is null.
    expect(restartOffer({ phase: null })).toMatchObject({ available: true, phase: null });
  });

  test('offered whatever the start card is doing (a delivered, refused or failed start does not matter)', () => {
    for (const o of ['delivered', 'refused', 'failed', 'board_link_failed'] as const) {
      expect(restartOffer({ attempts: [attempt(0, o)] }).available).toBe(true);
    }
  });

  test('not offered: delivered, not active, off the conveyor, on hold, not configured, or a start/restart being sent right now', () => {
    expect(restartOffer({ delivered: true })).toEqual({ available: false, reason: 'delivered', phase: 'execution' });
    expect(restartOffer({ live: false })).toEqual({ available: false, reason: 'not_active', phase: 'execution' });
    expect(restartOffer({ configured: false })).toMatchObject({ available: false, reason: 'conveyor_not_configured' });
    expect(restartOffer({ onConveyor: false })).toMatchObject({ available: false, reason: 'not_on_conveyor' });
    // The hold comes first, as for the start retry: before configuration and before an in-flight start.
    expect(restartOffer({ onHold: true })).toEqual({ available: false, reason: 'on_hold', phase: 'execution' });
    expect(restartOffer({ onHold: true, configured: false })).toMatchObject({ reason: 'on_hold' });
    expect(restartOffer({ onHold: true, attempts: [restartAttempt(1, 'pending')] })).toMatchObject({ reason: 'on_hold' });
    expect(restartOffer({ attempts: [attempt(0, 'delivered'), restartAttempt(1, 'pending')] })).toMatchObject({
      available: false,
      reason: 'start_in_flight',
    });
    // A pending older than the stale window is lost: a restart is offered again.
    expect(restartOffer({ attempts: [restartAttempt(1, 'pending', STALE_PENDING_MS + 1)] })).toMatchObject({
      available: true,
      next_attempt_n: 2,
    });
  });

  test('the start-card retry skips a restart that was not delivered (refused / failed / unlinked) but numbers after it', () => {
    expect(offer([attempt(0, 'delivered'), restartAttempt(1, 'refused')])).toEqual({ available: false, reason: 'started' });
    expect(offer([attempt(0, 'failed'), restartAttempt(1, 'failed')])).toMatchObject({
      available: true,
      reason: 'not_delivered',
      next_attempt_n: 2,
      next_idempotency_key: `${P}:retry-2`,
    });
  });

  test('a pending restart holds the start-card retry (start_in_flight); a delivered one is the latest start', () => {
    expect(offer([attempt(0, 'failed'), restartAttempt(1, 'pending')])).toEqual({ available: false, reason: 'start_in_flight' });
    expect(offer([attempt(0, 'failed'), restartAttempt(1, 'delivered')])).toEqual({ available: false, reason: 'started' });
  });
});

describe('R349: the restartable phases and the card phase field (pure)', () => {
  const phases = [{ name: 'setup' }, { name: 'preliminary' }, { name: 'execution' }, { name: 'closure' }];

  test('the current phase and every earlier one, in RM order; unknown current ⇒ none', () => {
    expect(restartablePhases(phases, 'execution').map((p) => p.name)).toEqual(['setup', 'preliminary', 'execution']);
    expect(restartablePhases(phases, 'setup').map((p) => p.name)).toEqual(['setup']);
    expect(restartablePhases(phases, null)).toEqual([]);
    expect(restartablePhases(phases, 'not-a-phase')).toEqual([]);
  });

  test("a card's phase is its `phase` custom field, trimmed; other fields and empty values place nothing", () => {
    const board = {
      included: {
        customFields: [
          { id: 'f-phase', name: 'phase' },
          { id: 'f-type', name: 'card_type' },
        ],
        customFieldValues: [
          { cardId: 'c1', customFieldId: 'f-phase', content: ' preliminary ' },
          { cardId: 'c2', customFieldId: 'f-type', content: 'project_phase_start' },
          { cardId: 'c3', customFieldId: 'f-phase', content: '' },
        ],
      },
    };
    expect(Object.fromEntries(cardPhaseFieldsOf(board))).toEqual({ c1: 'preliminary' });
    expect(cardPhaseFieldsOf(null).size).toBe(0);
  });
});
