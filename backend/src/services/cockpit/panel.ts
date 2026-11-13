// src/services/cockpit/panel.ts
//
// Cockpit read model v2 (R-CK8): the PANEL envelope and the fetch kit behind it.
//
//   Panel<T> = { data, as_of, health: ok | degraded | down, down_since?, detail_code? }
//
// Every cockpit panel resolves to this shape, whatever happened upstream:
//   * ok        — data is current (`as_of` = when it was read).
//   * degraded  — data is SHOWN but is not current or not complete: the last known value after a
//                 failed read (then `down_since` says since when the source has been failing), or
//                 a value with a known gap (`detail_code` names it).
//   * down      — nothing is known: `data` is null and `detail_code` names why.
//
// ⛔ `detail_code` is a short machine code (`planka_timeout`, `rm_upstream_unreachable`), never an
// upstream message, URL or body. The UI shows it only behind "Details"; the main view says it in
// plain words. That is what removes the raw-error class (UPSTREAM_UNREACHABLE printed into the
// page body) at the type level: there is no field a raw message could travel in.
//
// `fetchPanel` runs one source with a per-source timeout and keeps the last good value per key, so
// one slow or dead upstream never blanks a panel that was readable a minute ago, and never holds
// the whole page past its own timeout.
import { isIntegrationError, reportSwallowedFailure } from '../../integrations/_lib/errors';

export type PanelHealth = 'ok' | 'degraded' | 'down';

export interface Panel<T> {
  data: T | null;
  /** When `data` was read (ISO). null only when nothing was ever read (health `down`). */
  as_of: string | null;
  health: PanelHealth;
  /** Since when the source has been failing (ISO). Present only while it is failing. */
  down_since?: string;
  /** Machine code for "Details" (never an upstream message). */
  detail_code?: string;
}

/** A source that is not applicable to this project (no board, no RM link, …): not a failure. */
export class PanelNotApplicable extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PanelNotApplicable';
  }
}

/** A source that did not answer within its per-source timeout. */
export class PanelTimeoutError extends Error {
  constructor(public readonly source: string, public readonly ms: number) {
    super(`${source} did not answer within ${ms} ms`);
    this.name = 'PanelTimeoutError';
  }
}

const CODE_RE = /[^a-z0-9_]+/g;

/** `planka` + an IntegrationError(UPSTREAM_UNREACHABLE) → `planka_upstream_unreachable`. */
export function detailCodeOf(source: string, err: unknown): string {
  let tail: string;
  if (err instanceof PanelTimeoutError) tail = 'timeout';
  else if (err instanceof PanelNotApplicable) tail = err.code;
  else if (isIntegrationError(err)) tail = err.code;
  else {
    const code = (err as { code?: unknown } | null)?.code;
    tail = typeof code === 'string' && code.length > 0 ? code : 'error';
  }
  return `${source}_${tail}`.toLowerCase().replace(CODE_RE, '_').replace(/_+/g, '_').slice(0, 64);
}

export function okPanel<T>(data: T, asOf: Date | string = new Date()): Panel<T> {
  return { data, as_of: typeof asOf === 'string' ? asOf : asOf.toISOString(), health: 'ok' };
}

export function downPanel<T = never>(detailCode: string, downSince?: string): Panel<T> {
  return { data: null, as_of: null, health: 'down', detail_code: detailCode, ...(downSince ? { down_since: downSince } : {}) };
}

/** Not applicable to this project: nothing to show, and nothing is wrong. */
export function naPanel<T = never>(detailCode: string): Panel<T> {
  return { data: null, as_of: new Date().toISOString(), health: 'ok', detail_code: detailCode };
}

/** Data shown with a known gap. */
export function degradedPanel<T>(data: T, detailCode: string, asOf: Date | string = new Date()): Panel<T> {
  return {
    data,
    as_of: typeof asOf === 'string' ? asOf : asOf.toISOString(),
    health: 'degraded',
    detail_code: detailCode,
  };
}

/** The worst of several healths (down > degraded > ok). */
export function worstHealth(...hs: PanelHealth[]): PanelHealth {
  if (hs.includes('down')) return 'down';
  if (hs.includes('degraded')) return 'degraded';
  return 'ok';
}

// ── last-known cache ────────────────────────────────────────────────────────

interface CacheEntry {
  data: unknown;
  asOf: string;
  /** Wall-clock ms of the read. */
  at: number;
  /** First failure since the last good read (ISO), else undefined. */
  downSince?: string;
}

/** Entries older than this are never served as "last known": a day-old board is not a board. */
export const LAST_KNOWN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 2000;

const cache = new Map<string, CacheEntry>();

function touch(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export interface FetchPanelOptions {
  /** Per-source timeout. */
  timeoutMs: number;
  /**
   * Serve the cached value WITHOUT asking the source while it is younger than this. For sources
   * that are expensive to read and change slowly (the conveyor history reads every card's
   * comments). 0 / absent = always ask.
   */
  freshForMs?: number;
}

function withTimeout<T>(source: string, ms: number, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PanelTimeoutError(source, ms)), ms);
    run().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Read one source into a Panel. Never throws.
 *
 * `key` MUST scope the value to everything it depends on — tenant, project, and the caller class
 * when the value differs by caller (the cost basis does) — because the cached value is served to
 * the next caller with the same key while the source is down.
 */
export async function fetchPanel<T>(
  key: string,
  source: string,
  run: () => Promise<T>,
  opts: FetchPanelOptions,
): Promise<Panel<T>> {
  const hit = cache.get(key);
  if (hit && opts.freshForMs && !hit.downSince && Date.now() - hit.at < opts.freshForMs) {
    return { data: hit.data as T, as_of: hit.asOf, health: 'ok' };
  }
  try {
    const data = await withTimeout(source, opts.timeoutMs, run);
    const asOf = new Date().toISOString();
    touch(key, { data, asOf, at: Date.now() });
    return { data, as_of: asOf, health: 'ok' };
  } catch (err) {
    if (err instanceof PanelNotApplicable) {
      cache.delete(key);
      return naPanel<T>(detailCodeOf(source, err));
    }
    const code = detailCodeOf(source, err);
    reportSwallowedFailure(err, { service: source, degradedTo: `cockpit panel ${key.split(':').pop()} -> last known / down (${code})` });
    const prev = cache.get(key);
    const downSince = prev?.downSince ?? new Date().toISOString();
    if (prev && Date.now() - prev.at < LAST_KNOWN_MAX_AGE_MS) {
      touch(key, { ...prev, downSince });
      return { data: prev.data as T, as_of: prev.asOf, health: 'degraded', down_since: downSince, detail_code: code };
    }
    // Remember when the failure started, so the next read can say "down since".
    touch(key, { data: null, asOf: '', at: -Infinity, downSince });
    return downPanel<T>(code, downSince);
  }
}
