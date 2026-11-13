// $lib/usage/funding.ts
//
// Pure helpers for the funding-split usage views:
//   /admin/billing        GET /api/tenant/usage/breakdown  (project × member × funding)
//   /settings/usage       GET /api/me/usage/funding        (my project × funding)
//   (retired R6)          ProjectCost.funding was read by the removed home cost panel;
//                         the Cost page uses the richer project_costs block instead
//
// Funding is WHO PAID: fr's local GPUs, fr's provider keys, or the tenant's own
// key (BYO). A null project / actor / app dim is spend billing could not tie to
// one — it is labelled "Unattributed", never dropped and never blank.
//
// ⚠️ Types MIRROR backend/src/routes/tenant/usage-breakdown.ts — frontend tests
// must never import backend/ (the frontend CI job installs frontend/ only).

export const FUNDING_ORDER = ['local_gpu', 'platform_external', 'tenant_byo', 'unknown'] as const;

export const FUNDING_LABELS: Record<string, string> = {
  local_gpu: 'Local GPU',
  platform_external: 'Platform-paid',
  tenant_byo: 'Own key (BYO)',
  unknown: 'Unknown funding',
};

export const UNATTRIBUTED_LABEL = 'Unattributed';

export type CostBasis = 'incurred' | 'billed' | 'unavailable';

export interface FundingTotal {
  funding: string;
  events: number;
  input_tokens?: number;
  output_tokens?: number;
  /** null when withheld (markup unknown). */
  cost_usd: number | null;
}

export interface UsageFundingRow {
  dims: Record<string, string | null>;
  names: { project?: string | null; actor?: string | null; actor_email?: string | null };
  events: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

export interface UsageFundingBreakdown {
  scope: 'tenant' | 'me';
  tenant_id: string;
  actor_id?: string;
  from: string;
  to: string;
  group_by: string[];
  cost_basis: CostBasis;
  totals: { events: number; input_tokens: number; output_tokens: number; cost_usd: number | null };
  by_funding: FundingTotal[];
  rows: UsageFundingRow[];
  truncated: boolean;
  names_unavailable: { projects: boolean; actors: boolean };
}

export function fundingLabel(f: string | null | undefined): string {
  return FUNDING_LABELS[f ?? 'unknown'] ?? f ?? FUNDING_LABELS.unknown!;
}

/** Fundings in canonical order (unrecognised ones last, alphabetically). */
export function sortFundings(values: Iterable<string>): string[] {
  const rank = (f: string) => {
    const i = (FUNDING_ORDER as readonly string[]).indexOf(f);
    return i === -1 ? FUNDING_ORDER.length : i;
  };
  return [...new Set(values)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * USD for display. Sub-cent amounts keep 4 decimals so a small non-zero spend
 * never reads "$0.00"; null (withheld) is an em dash, never $0.
 */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export const DIM_HEADERS: Record<string, string> = {
  project: 'Project',
  actor: 'Member',
  app: 'App',
  provider: 'Provider',
  model: 'Model',
  day: 'Day',
  funding: 'Funding',
};

/** One cell's label + whether it is the unattributed bucket / an unresolved id. */
export function dimCell(
  row: Pick<UsageFundingRow, 'dims' | 'names'>,
  dim: string,
): { label: string; sublabel: string | null; unattributed: boolean; unnamed: boolean } {
  const v = row.dims[dim] ?? null;
  if (v === null) {
    return dim === 'project' || dim === 'actor' || dim === 'app'
      ? { label: UNATTRIBUTED_LABEL, sublabel: null, unattributed: true, unnamed: false }
      : { label: '—', sublabel: null, unattributed: false, unnamed: false };
  }
  if (dim === 'project') {
    const name = row.names.project ?? null;
    return { label: name ?? v, sublabel: name ? null : 'project not found in this workspace', unattributed: false, unnamed: !name };
  }
  if (dim === 'actor') {
    const name = row.names.actor ?? null;
    const email = row.names.actor_email ?? null;
    return {
      label: name ?? email ?? v,
      sublabel: name ? email : email ? null : 'not found in the directory',
      unattributed: false,
      unnamed: !name && !email,
    };
  }
  if (dim === 'funding') return { label: fundingLabel(v), sublabel: null, unattributed: false, unnamed: false };
  return { label: v, sublabel: null, unattributed: false, unnamed: false };
}

export interface PivotRow {
  key: string;
  /** The source row for `dimCell` (dims WITHOUT funding). */
  head: Pick<UsageFundingRow, 'dims' | 'names'>;
  /** cost per funding column; absent = no spend under that funding; null = withheld. */
  byFunding: Record<string, number | null>;
  cost_usd: number | null;
  events: number;
  input_tokens: number;
  output_tokens: number;
  unattributed: boolean;
}

export interface Pivot {
  /** Non-funding dims, in the order asked for. */
  dims: string[];
  /** Funding columns present in the data, canonical order. */
  fundings: string[];
  rows: PivotRow[];
  /** Column totals of the VISIBLE rows (may be < the true totals when truncated). */
  columnTotals: Record<string, number | null>;
}

const micros = (n: number) => Math.round(n * 1e6);

/**
 * Turn breakdown rows (which carry a `funding` dim) into one row per non-funding
 * key with a cost per funding column. A withheld part makes its cell AND the row
 * total null — never a partial dollar sum.
 */
export function pivotByFunding(rows: readonly UsageFundingRow[], groupBy: readonly string[]): Pivot {
  const dims = groupBy.filter((d) => d !== 'funding');
  const fundings = sortFundings(rows.map((r) => r.dims.funding ?? 'unknown'));
  type Acc = { row: PivotRow; m: Record<string, number>; nulls: Set<string> };
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const keyDims: Record<string, string | null> = {};
    for (const d of dims) keyDims[d] = r.dims[d] ?? null;
    const key = JSON.stringify(dims.map((d) => keyDims[d]));
    let a = acc.get(key);
    if (!a) {
      a = {
        row: {
          key,
          head: { dims: keyDims, names: r.names },
          byFunding: {},
          cost_usd: 0,
          events: 0,
          input_tokens: 0,
          output_tokens: 0,
          unattributed: dims.some((d) => (d === 'project' || d === 'actor' || d === 'app') && keyDims[d] === null),
        },
        m: {},
        nulls: new Set(),
      };
      acc.set(key, a);
    }
    const f = r.dims.funding ?? 'unknown';
    a.row.events += r.events;
    a.row.input_tokens += r.input_tokens ?? 0;
    a.row.output_tokens += r.output_tokens ?? 0;
    if (r.cost_usd === null) a.nulls.add(f);
    else a.m[f] = (a.m[f] ?? 0) + micros(r.cost_usd);
  }
  const out: PivotRow[] = [];
  const colMicros: Record<string, number> = {};
  const colNull = new Set<string>();
  for (const { row, m, nulls } of acc.values()) {
    let total = 0;
    for (const f of new Set([...Object.keys(m), ...nulls])) {
      if (nulls.has(f)) {
        row.byFunding[f] = null;
        colNull.add(f);
      } else {
        row.byFunding[f] = m[f]! / 1e6;
        total += m[f]!;
        colMicros[f] = (colMicros[f] ?? 0) + m[f]!;
      }
    }
    row.cost_usd = nulls.size ? null : total / 1e6;
    out.push(row);
  }
  out.sort((a, b) => (b.cost_usd ?? -1) - (a.cost_usd ?? -1) || b.events - a.events || a.key.localeCompare(b.key));
  const columnTotals: Record<string, number | null> = {};
  for (const f of fundings) columnTotals[f] = colNull.has(f) ? null : (colMicros[f] ?? 0) / 1e6;
  return { dims, fundings, rows: out, columnTotals };
}

/** Token count for display: grouped integer; non-finite → em dash. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/** Share of a total, 0..100, or null when either side is withheld/zero. */
export function fundingShare(part: number | null, total: number | null): number | null {
  if (part === null || total === null || !(total > 0)) return null;
  return (part / total) * 100;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** billing caps a window at 92 days (to − from). */
export const MAX_WINDOW_DAYS = 92;

export function windowError(from: string, to: string): string | null {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return 'Pick both a start and an end date.';
  if (from > to) return 'The start date must be on or before the end date.';
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_WINDOW_DAYS) return `Pick a range of at most ${MAX_WINDOW_DAYS} days.`;
  return null;
}

/** The last `days` days ending today (UTC), inclusive of both ends. */
export function lastDays(days: number): { from: string; to: string } {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}
