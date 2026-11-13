// tests/unit/routes/budget-threshold-helpers.test.ts
import { test, expect, describe } from 'bun:test';
import {
  BudgetThresholdPayloadSchema,
  buildBudgetEvent,
  budgetAlertCorrelationId,
  severityForThreshold,
  shouldNotify,
  NOTIFY_THRESHOLD_PCT,
  type BudgetThresholdPayload,
} from '../../../src/routes/webhooks/budget-threshold.helpers';

const VALID: BudgetThresholdPayload = {
  event: 'budget.threshold_crossed',
  tenant_id: '0a000000-0000-4000-8000-000000000001',
  budget_id: 'b-123',
  threshold_pct: 80,
  period_start: '2026-07-01T00:00:00+00:00',
  budget_tokens: 1_000_000,
  consumed_tokens: 832_145,
  usage_pct: 83.21,
  fired_at: '2026-07-19T03:55:00+00:00',
};

describe('BudgetThresholdPayloadSchema', () => {
  test('accepts a well-formed billing payload', () => {
    expect(BudgetThresholdPayloadSchema.parse(VALID)).toMatchObject({ threshold_pct: 80 });
  });

  test('rejects an unexpected event literal', () => {
    expect(() => BudgetThresholdPayloadSchema.parse({ ...VALID, event: 'something.else' })).toThrow();
  });

  test('rejects an unknown extra key (strict)', () => {
    expect(() => BudgetThresholdPayloadSchema.parse({ ...VALID, injected: true })).toThrow();
  });

  test('rejects a missing required field', () => {
    const rest = { ...VALID } as Partial<BudgetThresholdPayload>;
    delete rest.budget_id;
    expect(() => BudgetThresholdPayloadSchema.parse(rest)).toThrow();
  });
});

describe('shouldNotify', () => {
  test('gates below the 80% notify threshold', () => {
    expect(NOTIFY_THRESHOLD_PCT).toBe(80);
    expect(shouldNotify(50)).toBe(false);
    expect(shouldNotify(79)).toBe(false);
    expect(shouldNotify(80)).toBe(true);
    expect(shouldNotify(100)).toBe(true);
  });
});

describe('severityForThreshold', () => {
  test('80/90 → warning, 100 → error', () => {
    expect(severityForThreshold(80)).toBe('warning');
    expect(severityForThreshold(90)).toBe('warning');
    expect(severityForThreshold(100)).toBe('error');
  });
});

describe('budgetAlertCorrelationId', () => {
  test('is the billing dedupe tuple', () => {
    expect(budgetAlertCorrelationId(VALID)).toBe(
      'budget:b-123:80:2026-07-01T00:00:00+00:00',
    );
  });
});

describe('buildBudgetEvent', () => {
  test('80% crossing → warning event linking to the budget screen', () => {
    const ev = buildBudgetEvent(VALID, VALID.tenant_id);
    expect(ev.event_type).toBe('budget.threshold');
    expect(ev.severity).toBe('warning');
    expect(ev.tenant_id).toBe(VALID.tenant_id);
    expect(ev.link).toBe('/admin/budget');
    expect(ev.source).toBe('billing');
    expect(ev.project_id).toBeNull();
    expect(ev.title).toContain('80%');
    expect(ev.metadata).toMatchObject({
      budget_id: 'b-123',
      threshold_pct: 80,
      remaining_tokens: 1_000_000 - 832_145,
    });
  });

  test('100% crossing → error "exhausted" event, remaining clamped at 0', () => {
    const ev = buildBudgetEvent(
      { ...VALID, threshold_pct: 100, consumed_tokens: 1_050_000, usage_pct: 105 },
      VALID.tenant_id,
    );
    expect(ev.severity).toBe('error');
    expect(ev.title.toLowerCase()).toContain('exhausted');
    expect(ev.metadata).toMatchObject({ remaining_tokens: 0 });
  });
});

describe('BudgetThresholdPayloadSchema — period_start must be a real datetime', () => {
  const base = {
    event: 'budget.threshold_crossed' as const,
    tenant_id: 't1',
    budget_id: 'b1',
    threshold_pct: 80,
    period_start: '2026-07-01T00:00:00+00:00',
    budget_tokens: 10_000_000,
    consumed_tokens: 8_100_000,
    usage_pct: 81,
    fired_at: '2026-07-19T10:00:00+00:00',
  };

  test('accepts billing\'s isoformat output', () => {
    expect(() => BudgetThresholdPayloadSchema.parse(base)).not.toThrow();
  });

  test('rejects an unparseable period_start instead of 500-ing at insert time', () => {
    // Previously `z.string().min(1)`: this reached `new Date(...)` -> Invalid
    // Date -> TIMESTAMPTZ insert threw -> 500. billing reads non-2xx as
    // transient, so it re-POSTed the same bad payload every 60s forever.
    expect(() =>
      BudgetThresholdPayloadSchema.parse({ ...base, period_start: 'not-a-date' }),
    ).toThrow();
  });

  test('rejects an empty period_start', () => {
    expect(() => BudgetThresholdPayloadSchema.parse({ ...base, period_start: '' })).toThrow();
  });

  test('rejects an unparseable fired_at', () => {
    expect(() => BudgetThresholdPayloadSchema.parse({ ...base, fired_at: 'whenever' })).toThrow();
  });
});
