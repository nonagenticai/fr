// src/connectors/rss.ts
// RSS/Atom connector: fetches and parses feed items.
// Spec 2 Plan 2-B Track A.

import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { ConnectorConfig } from '../types/connectors';
type RssConnectorConfig = Extract<ConnectorConfig, { kind: 'rss' }>;
import type { Connector, DecryptedSecret, DryRunResult, FetchedRecord } from './types';
import { ConnectorError } from './types';
import { errorToDryRunError, takeAsyncIter } from './_helpers';
import { assertPublicUrl, safeFetch, SsrfBlockedError } from '../utils/ssrf-guard';

/**
 * Scheme version for the DERIVED (title+pubDate) stable_id, carried in the
 * emitted value the way `licenseRevokeIdempotencyKey` carries `fr-…-v1-`
 * (see `services/provisioning.ts`).
 *
 * Only the fallback branch is versioned: the `guid` and `link` branches pass an
 * upstream-supplied identifier through verbatim, so they have no preimage of
 * ours to version.
 *
 * It starts at `v2` because a `v1` is already in the wild — the historical,
 * UNPREFIXED `sha256(title + pubDate).slice(0, 32)`.
 *
 * Bumping this re-keys every derived stable_id, and therefore the
 * `action_idempotency` row derived from it (`deriveIdempotencyKey` hashes the
 * stable_id into the claim key). The direction of that breakage is SAFE — a key
 * that has never been claimed can only MISS the dedup cache, so affected items
 * are dispatched ONE MORE TIME, never dropped — but it is still a breaking
 * change to a persisted keyspace.
 */
export const RSS_DERIVED_ID_SCHEME = 'rss-v2';

/**
 * Netstring-style field encoding: `<length>:<value>`.
 *
 * A bare separator is NOT sufficient here. `title` and `pubDate` are arbitrary
 * text lifted out of a third-party feed by a non-validating XML parser, so any
 * byte we might pick as a delimiter can also occur INSIDE a field — at which
 * point the delimited preimage is re-splittable and the collision class is
 * merely narrowed, not closed. Prefixing each field with its exact length makes
 * the preimage unambiguously parseable, which makes the
 * `(title, pubDate) -> preimage` map injective for ALL inputs, with no
 * assumption whatsoever about the fields' contents.
 *
 * (The `\0` joiner below is then pure belt-and-braces readability, matching the
 * house domain-separator convention; injectivity does not depend on it.)
 */
function lengthPrefixed(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * Derived stable_id for feed items that supply neither a `guid`/`id` nor a
 * `link`.
 *
 * Replaces `sha256(title + pubDate)`, whose preimage had no field boundary at
 * all, so ("Release 2.0", "1 Jan 2026") and ("Release 2.01", " Jan 2026") both
 * hashed to 2b23f2f0589933e568f5f0458409e052. Two colliding items share one
 * stable_id, so one of them loses the `action_idempotency` claim race in
 * `workers/scheduled-trigger-tick.ts` and is silently swallowed — never
 * dispatched, and never reported as skipped.
 *
 * The `rss-v2-` prefix also shrinks a second, latent collision class: before it,
 * a feed whose `guid` happened to BE another item's 32-hex derived id collided
 * across branches. Now that requires a guid literally equal to
 * `rss-v2-<32 hex>`, which at least announces itself.
 */
export function derivedStableId(title: string, pubDate: string): string {
  const preimage = `${RSS_DERIVED_ID_SCHEME}\0${lengthPrefixed(title)}\0${lengthPrefixed(pubDate)}`;
  const digest = createHash('sha256').update(preimage, 'utf8').digest('hex').slice(0, 32);
  return `${RSS_DERIVED_ID_SCHEME}-${digest}`;
}

function stableId(item: Record<string, unknown>): string {
  const guid = item['guid'] ?? item['id'];
  if (guid && typeof guid === 'string') return guid;
  if (guid && typeof guid === 'object' && guid !== null) {
    const v = (guid as Record<string, unknown>)['#text'] ?? (guid as Record<string, unknown>)['_text'];
    if (v && typeof v === 'string') return v;
  }
  const link = item['link'];
  if (link && typeof link === 'string') return link;
  const title = String(item['title'] ?? '');
  const pubDate = String(item['pubDate'] ?? item['published'] ?? '');
  return derivedStableId(title, pubDate);
}

export const rssConnector: Connector = {
  async *fetch(
    config: unknown,
    _secret: DecryptedSecret | null,
  ): AsyncGenerator<FetchedRecord> {
    const cfg = config as RssConnectorConfig;

    // SSRF guard: feed_url is user-supplied and reachable by ANY authenticated
    // user via POST /api/connectors/test-connection, so without this it is a
    // probe against every internal host (the whole Tailnet is 100.64.0.0/10).
    // Must run before fetch, and its failure must NOT be reported as
    // "unreachable" — a blocked target is a client error, not an upstream one.
    try {
      await assertPublicUrl(cfg.feed_url);
    } catch (err) {
      // CONFIG_MISMATCH, not UPSTREAM_*: the feed_url is the problem, and
      // reporting it as an upstream condition would turn this into an existence
      // oracle for internal hosts (blocked vs unreachable would be
      // distinguishable). Matches the n8n-webhook preflight.
      throw new ConnectorError('CONFIG_MISMATCH', (err as Error).message, err);
    }

    let response: Response;
    try {
      // H3: safeFetch re-checks every redirect hop; a plain fetch followed a
      // public 302 to an internal host.
      response = await safeFetch(cfg.feed_url);
    } catch (err) {
      // A refused redirect is a config problem, exactly like the pre-check.
      if (err instanceof SsrfBlockedError) {
        throw new ConnectorError('CONFIG_MISMATCH', err.message, err);
      }
      throw new ConnectorError('UPSTREAM_UNREACHABLE', `Cannot reach ${cfg.feed_url}`, err);
    }

    if (!response.ok) {
      throw new ConnectorError(
        'UPSTREAM_ERROR',
        `RSS feed returned HTTP ${response.status}: ${cfg.feed_url}`,
      );
    }

    const text = await response.text();

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => name === 'item' || name === 'entry',
    });

    let parsed: Record<string, unknown>;
    try {
      parsed = parser.parse(text) as Record<string, unknown>;
    } catch (err) {
      throw new ConnectorError('PARSE_ERROR', 'Failed to parse RSS/Atom XML', err);
    }

    // RSS 2.0: rss.channel.item[]
    // Atom: feed.entry[]
    let items: Record<string, unknown>[] = [];
    const rss = parsed['rss'] as Record<string, unknown> | undefined;
    const feed = parsed['feed'] as Record<string, unknown> | undefined;

    if (rss?.['channel']) {
      const channel = rss['channel'] as Record<string, unknown>;
      items = (channel['item'] as Record<string, unknown>[]) ?? [];
    } else if (feed?.['entry']) {
      items = (feed['entry'] as Record<string, unknown>[]) ?? [];
    } else {
      throw new ConnectorError('PARSE_ERROR', 'Unrecognized feed format — expected RSS 2.0 or Atom');
    }

    const maxItems = cfg.max_items ?? 50;
    const slice = items.slice(0, maxItems);

    for (const item of slice) {
      yield {
        stable_id: stableId(item),
        raw: item,
      };
    }
  },

  async dryRun(config, secret): Promise<DryRunResult> {
    try {
      const sample = await takeAsyncIter(this.fetch(config, secret), 3);
      return { ok: true, sample_count: sample.length, sample };
    } catch (err) {
      return { ok: false, error: errorToDryRunError(err) };
    }
  },
};
