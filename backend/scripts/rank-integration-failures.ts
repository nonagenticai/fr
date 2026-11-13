#!/usr/bin/env bun
/**
 * Rank fr's OBSERVED integration failures from Loki.
 *
 * `logIntegrationFailure` (src/integrations/_lib/errors.ts) emits one JSON line
 * per converted failure from the CONVERTER, so every caller is covered by
 * construction rather than by remembering to use a wrapper. Alloy ships those to
 * Loki, which retains them across pod lifetimes — so this sees further back than
 * `kubectl logs`, which only ever shows the current pod.
 *
 * Usage:
 *   LOKI_URL=http://localhost:3100 bun scripts/rank-integration-failures.ts --days 7
 *
 * ⚠️ A count with no window is not a rank. The window, the line budget, and
 * whether that budget was HIT are printed with the table — a truncated scan that
 * silently looks complete is the exact failure mode this effort exists to remove.
 */

const LOKI_URL = process.env.LOKI_URL ?? 'http://loki.example.com:3100';
const NAMESPACE = process.env.FR_NAMESPACE ?? 'fr';

/**
 * Unit separator: cannot occur in a code, service, method, path or status.
 *
 * Written as an ESCAPE, never as a raw control byte in the source. A raw one is
 * what made `routes/client-errors.ts` binary to git -- 395 lines invisible to
 * both review and to gitleaks, which scans the diff.
 */
const SEP = '\u001F';

function numericArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DAYS = numericArg('--days', 7);
/** Loki refuses very large single responses; this is the line budget. */
const LIMIT = numericArg('--limit', 5000);

interface TelemetryLine {
  telemetry?: string;
  code?: string;
  /** null by DESIGN for caller-side refusals — nothing upstream was contacted. */
  service?: string | null;
  method?: string | null;
  path?: string | null;
  upstream_status?: number | null;
  http_status?: number | null;
  message?: string;
}

interface Group {
  code: string;
  service: string;
  method: string;
  path: string;
  upstreamStatus: string;
  count: number;
  firstSeenNs: bigint;
  lastSeenNs: bigint;
  sampleMessage: string;
}

/**
 * `service ?? null` is deliberate in the emitter: a caller-side refusal names no
 * upstream because none was contacted. Those lines are KEPT and labelled
 * `(caller-side)`. Dropping them would hide an entire failure family — the same
 * blindness this telemetry was added to end.
 */
export function groupKeyFor(l: TelemetryLine): string {
  return [
    l.code ?? 'UNKNOWN',
    l.service ?? '(caller-side)',
    l.method ?? '-',
    l.path ?? '-',
    l.upstream_status == null ? '-' : String(l.upstream_status),
  ].join(SEP);
}

export function rank(lines: { tsNs: string; line: string }[]): {
  groups: Group[];
  parsed: number;
  unparseable: number;
} {
  const groups = new Map<string, Group>();
  let parsed = 0;
  let unparseable = 0;

  for (const { tsNs, line } of lines) {
    let obj: TelemetryLine;
    try {
      obj = JSON.parse(line) as TelemetryLine;
    } catch {
      unparseable += 1;
      continue;
    }
    if (obj.telemetry !== 'integration_error') continue;
    parsed += 1;

    const key = groupKeyFor(obj);
    const ns = BigInt(tsNs);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (ns < existing.firstSeenNs) existing.firstSeenNs = ns;
      if (ns > existing.lastSeenNs) existing.lastSeenNs = ns;
      continue;
    }
    const parts = key.split(SEP);
    groups.set(key, {
      code: parts[0] ?? 'UNKNOWN',
      service: parts[1] ?? '-',
      method: parts[2] ?? '-',
      path: parts[3] ?? '-',
      upstreamStatus: parts[4] ?? '-',
      count: 1,
      firstSeenNs: ns,
      lastSeenNs: ns,
      sampleMessage: (obj.message ?? '').slice(0, 160),
    });
  }

  return {
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    parsed,
    unparseable,
  };
}

/** Pull the `values` pairs out of a Loki `query_range` response body. */
export function linesFromLokiBody(body: unknown): { tsNs: string; line: string }[] {
  const result =
    (body as { data?: { result?: { values?: [string, string][] }[] } } | null)?.data?.result ?? [];
  return result.flatMap((s) => (s.values ?? []).map(([tsNs, line]) => ({ tsNs, line })));
}

function fileArg(): string | null {
  const i = process.argv.indexOf('--file');
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

async function fetchLines(): Promise<{ lines: { tsNs: string; line: string }[]; truncated: boolean }> {
  // `--file` ranks a previously-fetched Loki response. fr's Loki is in-cluster
  // only, so this is how the analysis runs from a workstation — and it makes a
  // given ranking reproducible from the exact bytes it was derived from.
  const path = fileArg();
  if (path) {
    const body = JSON.parse(await Bun.file(path).text()) as unknown;
    const lines = linesFromLokiBody(body);
    return { lines, truncated: lines.length >= LIMIT };
  }

  const endNs = BigInt(Date.now()) * 1_000_000n;
  const startNs = endNs - BigInt(DAYS) * 86_400_000_000_000n;
  const query = `{namespace="${NAMESPACE}"} |= "integration_error"`;
  const url =
    `${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(query)}` +
    `&start=${startNs}&end=${endNs}&limit=${LIMIT}&direction=backward`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Loki ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  }
  const lines = linesFromLokiBody((await res.json()) as unknown);
  return { lines, truncated: lines.length >= LIMIT };
}

const isoOf = (ns: bigint): string => new Date(Number(ns / 1_000_000n)).toISOString();

async function main(): Promise<void> {
  const { lines, truncated } = await fetchLines();
  const { groups, parsed, unparseable } = rank(lines);

  console.log('# fr observed integration failures');
  console.log(`window:        last ${DAYS}d (Loki retention_period is 30d)`);
  console.log(
    `lines scanned: ${lines.length}` +
      (truncated ? ` -- HIT the ${LIMIT} cap, so counts are a LOWER BOUND` : ''),
  );
  console.log(`telemetry:     ${parsed} integration_error, ${unparseable} unparseable`);
  console.log(`distinct:      ${groups.length} failure group(s)`);
  console.log('');

  if (groups.length === 0) {
    // NOT "no failures". Zero observed events is also what a stopped shipper, a
    // wrong namespace, and an unexercised route look like — indistinguishable
    // without a positive control.
    console.log('No integration_error lines in the window.');
    console.log('This is NOT evidence that nothing is failing: an unexercised route,');
    console.log('a stopped log shipper and a healthy system all look identical here.');
    console.log('Run a known-good query first if you intend to report an absence.');
    return;
  }

  console.log('count  code / service / method path / upstream');
  console.log('-----  -------------------------------------------------------------');
  for (const g of groups) {
    console.log(
      `${String(g.count).padStart(5)}  ${g.code} / ${g.service} / ${g.method} ${g.path} / upstream=${g.upstreamStatus}`,
    );
    console.log(`       ${isoOf(g.firstSeenNs)} -> ${isoOf(g.lastSeenNs)}`);
    if (g.sampleMessage) console.log(`       ${g.sampleMessage}`);
  }
}

if (import.meta.main) {
  await main();
}
