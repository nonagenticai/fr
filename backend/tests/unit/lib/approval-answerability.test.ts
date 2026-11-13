// tests/unit/lib/approval-answerability.test.ts
//
// The PURE half of the answerability gate: the classifier, the mode flag and
// the counter's label discipline. Hermetic — no database, no request context —
// which is why `lib/approval-answerability.ts` imports nothing at all and its
// metrics sibling imports only `middleware/request-context`.
//
// The DB-backed half (resolution through project/stream/project_request, the
// refusal actually leaving no row) lives in
// `tests/integration/approvals/answerability-gate.integration.test.ts`. Neither
// file can stand in for the other: a classifier that is right about facts it is
// handed proves nothing about whether the caller derives the right facts.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

import { ANSWERABILITY_KINDS, normaliseAnswerabilityKind, renderAnswerabilityMetrics } from '../../../src/lib/approval-answerability-metrics';
import {
  ANSWERABILITY_MODE_ENV,
  ANSWERABILITY_REASONS,
  answerabilityEnforces,
  answerabilityMode,
  answerabilityRefusalMessage,
  classifyAnswerability,
  type AnswerabilityFacts,
} from '../../../src/lib/approval-answerability';
import { approvalKindEnum } from '../../../src/db/schema';

/** Answerable on every arm — each case knocks out exactly one property. */
const ok = (over: Partial<AnswerabilityFacts> = {}): AnswerabilityFacts => ({
  requesterId: 'u-1',
  approverUserId: 'u-2',
  approverIsTenantMember: true,
  expiresAt: new Date(),
  metadata: { card_type: 'workflow_statistics_analysis' },
  ...over,
});

describe('classifyAnswerability', () => {
  test('a fully-formed row yields NO reasons — the baseline the arms are read against', () => {
    expect(classifyAnswerability(ok())).toEqual([]);
  });

  test('a missing requester is named', () => {
    expect(classifyAnswerability(ok({ requesterId: null }))).toEqual([
      'requester_unresolvable',
    ]);
    // Whitespace is absence, not content — the repo's `.trim() ? … :` idiom.
    expect(classifyAnswerability(ok({ requesterId: '   ' }))).toEqual([
      'requester_unresolvable',
    ]);
  });

  test('an approver outside the tenant is named — but NOT ESTABLISHED fails OPEN', () => {
    expect(classifyAnswerability(ok({ approverIsTenantMember: false }))).toEqual([
      'approver_foreign_tenant',
    ]);
    // ⛔ `null` means the lookup threw or there is no approver. A Postgres
    // wobble must not present as "every approval is unanswerable", which is the
    // most likely way a correct gate gets blamed and reverted.
    expect(classifyAnswerability(ok({ approverIsTenantMember: null }))).toEqual([]);
    // No approver named at all → the arm has no subject and must stay silent.
    expect(
      classifyAnswerability(ok({ approverUserId: null, approverIsTenantMember: false })),
    ).toEqual([]);
  });

  test('an absent deadline is named — for null AND undefined', () => {
    expect(classifyAnswerability(ok({ expiresAt: null }))).toEqual(['deadline_absent']);
    expect(classifyAnswerability(ok({ expiresAt: undefined }))).toEqual(['deadline_absent']);
  });

  test('card_type OR gate_terms satisfies the arm; neither does not', () => {
    expect(classifyAnswerability(ok({ metadata: { card_type: 'x' } }))).toEqual([]);
    expect(classifyAnswerability(ok({ metadata: { gate_terms: ['error rate < 2%'] } }))).toEqual(
      [],
    );
    expect(classifyAnswerability(ok({ metadata: {} }))).toEqual([
      'no_card_type_and_no_gate_terms',
    ]);
    expect(classifyAnswerability(ok({ metadata: null }))).toEqual([
      'no_card_type_and_no_gate_terms',
    ]);
  });

  test('an EMPTY or blank gate_terms array does NOT buy a pass', () => {
    // ⚠️ THE VACUOUS-GATE CASE. An absent key and an empty array are different
    // findings elsewhere and the mint paths preserve that — but for "does this
    // row state a condition a human can answer against?" they are the same
    // answer, and `[]` satisfying the guard would make it unable to fail.
    expect(classifyAnswerability(ok({ metadata: { gate_terms: [] } }))).toEqual([
      'no_card_type_and_no_gate_terms',
    ]);
    expect(classifyAnswerability(ok({ metadata: { gate_terms: ['', '  '] } }))).toEqual([
      'no_card_type_and_no_gate_terms',
    ]);
  });

  test('a policy_key tenant mismatch is named', () => {
    expect(classifyAnswerability(ok({ policyKeyTenantMismatch: 'tenant-0001' }))).toEqual([
      'tenant_policy_key_mismatch',
    ]);
  });

  test('EVERY reason is returned, not just the first', () => {
    // ⭐ Two defects in two different producers. Reporting only the first is
    // how a fix ships, the number does not move, and the second cause is never
    // found — so the order and the completeness are both asserted.
    expect(
      classifyAnswerability(
        ok({ requesterId: null, expiresAt: null, metadata: {} }),
      ),
    ).toEqual([
      'requester_unresolvable',
      'deadline_absent',
      'no_card_type_and_no_gate_terms',
    ]);
  });
});

describe('the mode flag', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ANSWERABILITY_MODE_ENV];
    delete process.env[ANSWERABILITY_MODE_ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ANSWERABILITY_MODE_ENV];
    else process.env[ANSWERABILITY_MODE_ENV] = saved;
  });

  test('DEFAULT IS OBSERVE — unset, empty, misspelt and truthy all read observe', () => {
    // ⛔ The failure mode of an accidental `enforce` is the conveyor stopping
    // fleet-wide. Every value that is not exactly the word must fall safe.
    for (const v of [undefined, '', '  ', 'true', '1', 'ENFORCED', 'enforcing', 'yes']) {
      if (v === undefined) delete process.env[ANSWERABILITY_MODE_ENV];
      else process.env[ANSWERABILITY_MODE_ENV] = v;
      expect(answerabilityMode()).toBe('observe');
      expect(answerabilityEnforces()).toBe(false);
    }
  });

  test('only `enforce` arms it, case- and whitespace-insensitively', () => {
    for (const v of ['enforce', 'ENFORCE', '  Enforce  ']) {
      process.env[ANSWERABILITY_MODE_ENV] = v;
      expect(answerabilityEnforces()).toBe(true);
    }
  });

  test('it is read at CALL time, not at module load', () => {
    // A module-level constant is captured once per process, so a later env
    // change would not be seen — and a gate whose enforce branch can never be
    // entered by a test is a gate that cannot fail.
    delete process.env[ANSWERABILITY_MODE_ENV];
    expect(answerabilityEnforces()).toBe(false);
    process.env[ANSWERABILITY_MODE_ENV] = 'enforce';
    expect(answerabilityEnforces()).toBe(true);
  });
});

describe('the refusal message', () => {
  test('names every reason AND the flag that armed it', () => {
    const msg = answerabilityRefusalMessage(
      ['requester_unresolvable', 'no_card_type_and_no_gate_terms'],
      'card-7',
    );
    expect(msg).toContain('card-7');
    expect(msg).toContain('requester_unresolvable');
    expect(msg).toContain('no_card_type_and_no_gate_terms');
    // An operator reading an n8n execution must be able to tell a deliberate
    // refusal from a defect without reading fr's source.
    expect(msg).toContain(ANSWERABILITY_MODE_ENV);
    // …and be told what to send instead. A refusal with no remedy is the same
    // dead end as the approval it refused.
    expect(msg).toContain('APPROVAL_FALLBACK_APPROVER_USER_ID'.slice(0, 8));
  });
});

describe('the counter', () => {
  test('the kind list MIRRORS db/schema.ts approvalKindEnum', () => {
    // ⚠️ `ANSWERABILITY_KINDS` is a deliberate LOCAL mirror so the metrics
    // module stays free of `db/client`. A mirror with no pin drifts silently,
    // and a kind missing from it collapses into `other` — a producer's whole
    // series quietly merging into another's.
    const declared = [...new Set<string>(approvalKindEnum.enumValues)].sort();
    const mirrored = [
      ...new Set<string>(ANSWERABILITY_KINDS.filter((k) => k !== 'other')),
    ].sort();
    expect(mirrored).toEqual(declared);
  });

  test('an unknown kind collapses to `other` rather than minting a series', () => {
    expect(normaliseAnswerabilityKind('not-a-kind')).toBe('other');
    expect(normaliseAnswerabilityKind(null)).toBe('other');
    expect(normaliseAnswerabilityKind('generic')).toBe('generic');
  });

  test('every reason is exported from process start (pre-seeded, not minted on first fire)', () => {
    // ⭐ The intended end state of `approver_foreign_tenant` is ZERO, so a series
    // that only appears once it fires is indistinguishable from an exporter that
    // was never wired up. (Values are process-global; only presence is asserted.)
    const lines = renderAnswerabilityMetrics().filter((l) => !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    for (const reason of ANSWERABILITY_REASONS) {
      expect(lines.some((l) => l.includes(`reason="${reason}"`))).toBe(true);
    }
  });

  test('`none` pairs only with `clean`, and no other reason does', () => {
    const lines = renderAnswerabilityMetrics().filter((l) => !l.startsWith('#'));
    const none = lines.filter((l) => l.includes('reason="none"'));
    expect(none.every((l) => l.includes('outcome="clean"'))).toBe(true);
    const others = lines.filter((l) => !l.includes('reason="none"'));
    expect(others.some((l) => l.includes('outcome="clean"'))).toBe(false);
  });

  test('no label value can break the exposition format', () => {
    // Closed sets on all three labels, so no caller-supplied string reaches a
    // label. A single unescaped quote here takes EVERY fr metric to up=0.
    for (const line of renderAnswerabilityMetrics()) {
      expect(line.includes('\n')).toBe(false);
      expect((line.match(/"/g) ?? []).length % 2).toBe(0);
    }
  });
});
