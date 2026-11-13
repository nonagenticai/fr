/**
 * Plan 3 — Generic NDJSON streaming reader.
 *
 * The fr backend serves NDJSON (one JSON value per line, terminated `\n`)
 * for `/api/agui/invoke` and `/api/agent/chat`. This helper turns the
 * fetch response body into an async iterator of typed events.
 *
 * Implementation: delegates chunk-boundary parsing to `parseNdjson` and
 * the request lifecycle to `fetchWithBudget` so soft/slow/hard timeouts
 * + cancellation are uniform across the codebase.
 */

import { parseNdjson } from '$lib/net/ndjson';
import { fetchWithBudget, type BudgetOptions } from '$lib/net/fetchWithBudget';

export interface StreamOptions extends RequestInit {
  /** Bearer token to attach as `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Optional budget overrides; defaults are 5s soft / 30s slow / 90s hard. */
  budget?: Pick<
    BudgetOptions,
    'softTimeoutMs' | 'slowTimeoutMs' | 'hardTimeoutMs' | 'onStillWorking' | 'onTakingLonger'
  >;
}

/**
 * Typed error for non-2xx upstream responses. Exposes `.status` so retry
 * classifiers don't have to parse the message string.
 */
export class HttpStreamError extends Error {
  readonly status: number;
  constructor(status: number, snippet: string) {
    super(`${status} ${snippet}`);
    this.name = 'HttpStreamError';
    this.status = status;
  }
}

/**
 * POST a JSON body to `url`, expect an NDJSON response, yield each parsed
 * line as a typed event.
 *
 * Error semantics:
 * - Pre-stream auth/parse failures (4xx returned with a single NDJSON error
 *   line) are yielded as the only event and the iterator completes.
 * - Mid-stream parse failures throw — these indicate a backend bug.
 * - The fetch itself rejecting (network error) propagates as an exception.
 */
export async function* streamNdjson<T>(
  url: string,
  body: unknown,
  options: StreamOptions = {},
): AsyncGenerator<T> {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('Accept')) headers.set('Accept', 'application/x-ndjson');
  if (options.bearerToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${options.bearerToken}`);
  }

  // The agent-session bearer is supplied explicitly by callers (agentClient).
  // We must not let `fetchWithBudget`'s default `authFetch` overwrite it with
  // a Keycloak token, so use the global `fetch` as the inner impl.
  const res = await fetchWithBudget(
    url,
    {
      ...options,
      method: options.method ?? 'POST',
      headers,
      body: JSON.stringify(body),
    },
    {
      ...(options.budget ?? {}),
      signal: options.signal ?? undefined,
      fetchImpl: globalThis.fetch.bind(globalThis),
    },
  );

  // Upstream-error short-circuit. fr-backend (and the Istio ingress in
  // front of it) sometimes returns non-NDJSON bodies for 4xx/5xx — e.g.
  // Envoy's plain-text "no healthy upstream" during a rolling restart.
  // Without this guard parseNdjson immediately throws
  // `Unexpected token 'o', "no healthy upstream" is not valid JSON`,
  // which surfaces as a confusing parser error in the UI. Read the body
  // as text and raise a typed Error with the upstream status + snippet
  // so callers can render a sensible message.
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const snippet = text.trim().slice(0, 200) || res.statusText || 'request failed';
    throw new HttpStreamError(res.status, snippet);
  }

  if (!res.body) {
    // Some browsers / fetch polyfills return undefined body; fall back to
    // a one-shot text read so callers still see the response shape.
    const text = await res.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      yield JSON.parse(trimmed) as T;
    }
    return;
  }

  for await (const ev of parseNdjson<T>(res.body)) {
    if (!ev.ok) {
      // Mid-stream parse failures throw — these indicate a backend bug,
      // matching the prior contract.
      throw ev.error instanceof Error
        ? ev.error
        : new SyntaxError(`malformed NDJSON line: ${ev.raw}`);
    }
    yield ev.value;
  }
}
