import { describe, it, expect } from 'vitest';
import {
  pivotByFunding,
  dimCell,
  fundingLabel,
  formatUsd,
  formatTokens,
  windowError,
  lastDays,
  UNATTRIBUTED_LABEL,
  type UsageFundingRow,
} from './funding';

const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const row = (
  dims: Record<string, string | null>,
  cost_usd: number | null,
  events = 1,
  names: UsageFundingRow['names'] = {},
): UsageFundingRow => ({ dims, names, events, input_tokens: 0, output_tokens: 0, cost_usd });

describe('pivotByFunding', () => {
  it('one row per project × member, funding as columns, totals per row and column', () => {
    const p = pivotByFunding(
      [
        row({ project: P1, actor: A1, funding: 'platform_external' }, 10, 3, { project: 'Alpha', actor: 'Ada' }),
        row({ project: P1, actor: A1, funding: 'tenant_byo' }, 2, 1, { project: 'Alpha', actor: 'Ada' }),
        row({ project: null, actor: null, funding: 'local_gpu' }, 0.5, 4),
      ],
      ['project', 'actor', 'funding'],
    );
    expect(p.dims).toEqual(['project', 'actor']);
    expect(p.fundings).toEqual(['local_gpu', 'platform_external', 'tenant_byo']);
    expect(p.rows.map((r) => [r.byFunding, r.cost_usd, r.events, r.unattributed])).toEqual([
      [{ platform_external: 10, tenant_byo: 2 }, 12, 4, false],
      [{ local_gpu: 0.5 }, 0.5, 4, true],
    ]);
    expect(p.columnTotals).toEqual({ local_gpu: 0.5, platform_external: 10, tenant_byo: 2 });
  });

  it('sums input/output tokens across fundings per row (withheld cost does not hide tokens)', () => {
    const tok = (dims: Record<string, string | null>, cost: number | null, i: number, o: number): UsageFundingRow => ({
      ...row(dims, cost),
      input_tokens: i,
      output_tokens: o,
    });
    const p = pivotByFunding(
      [
        tok({ project: P1, funding: 'platform_external' }, null, 100, 10),
        tok({ project: P1, funding: 'tenant_byo' }, 2, 50, 5),
        tok({ project: null, funding: 'local_gpu' }, 0.1, 7, 3),
      ],
      ['project', 'funding'],
    );
    expect(p.rows.map((r) => [r.head.dims.project, r.input_tokens, r.output_tokens])).toEqual([
      [null, 7, 3],
      [P1, 150, 15],
    ]);
  });

  it('a withheld cell makes the row total and column total null — never a partial sum', () => {
    const p = pivotByFunding(
      [row({ project: P1, funding: 'platform_external' }, null), row({ project: P1, funding: 'tenant_byo' }, 2)],
      ['project', 'funding'],
    );
    expect(p.rows[0]!.byFunding).toEqual({ platform_external: null, tenant_byo: 2 });
    expect(p.rows[0]!.cost_usd).toBeNull();
    expect(p.columnTotals).toEqual({ platform_external: null, tenant_byo: 2 });
  });
});

describe('dimCell', () => {
  it('labels null project / member / app as Unattributed', () => {
    for (const d of ['project', 'actor', 'app']) {
      expect(dimCell(row({ [d]: null }, 1), d)).toMatchObject({ label: UNATTRIBUTED_LABEL, unattributed: true });
    }
  });
  it('maps member ids to names (email as sublabel) and flags unresolved ids', () => {
    expect(dimCell(row({ actor: A1 }, 1, 1, { actor: 'Ada', actor_email: 'ada@x.test' }), 'actor')).toEqual({
      label: 'Ada',
      sublabel: 'ada@x.test',
      unattributed: false,
      unnamed: false,
    });
    expect(dimCell(row({ actor: A1 }, 1, 1, { actor: null, actor_email: null }), 'actor')).toMatchObject({
      label: A1,
      unnamed: true,
      sublabel: 'not found in the directory',
    });
  });
});

describe('formatting', () => {
  it('funding labels, $ never hides a sub-cent spend, withheld is a dash', () => {
    expect(fundingLabel('tenant_byo')).toBe('Own key (BYO)');
    expect(fundingLabel('local_gpu')).toBe('Local GPU');
    expect(fundingLabel(null)).toBe('Unknown funding');
    expect(formatUsd(0.0012)).toBe('$0.0012');
    expect(formatUsd(null)).toBe('—');
  });
  it('window: ≤ 92 days, ordered, real dates', () => {
    expect(windowError('2026-09-01', '2026-09-07')).toBeNull();
    expect(windowError('2026-01-01', '2026-09-07')).not.toBeNull();
    expect(windowError('2026-09-08', '2026-09-07')).not.toBeNull();
    // Real clock: the window ends today (UTC) and spans 30 days inclusive.
    const { from, to } = lastDays(30);
    expect(to).toBe(new Date().toISOString().slice(0, 10));
    expect((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000).toBe(29);
    expect(windowError(from, to)).toBeNull();
  });
});

describe('formatTokens', () => {
  it('groups digits; null/non-finite is an em dash', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(Number.NaN)).toBe('—');
  });
});
