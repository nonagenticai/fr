// fr/backend/src/domain/bridge/dedup.ts
//
// Stable-id + content-digest dedup for the analysis-to-kanban bridge.
// See spec §Dedup. Order: stable_id first, content_digest fallback.
//
// Canonical stable_id formulas (sha256 hex of the joined string):
//   coding:    "coding|" + tool + "|" + rule_id + "|" + file_path + "|" + line_number
//   kag:       "kag|" + session_id + "|" + url
//   artifacts: "artifacts|" + artifact_id + "|" + version
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { cardBridgeLinks } from '../../db/schema';
import { emitSpan } from '../../telemetry/spans';
import type {
  BridgeDb,
  DedupLookupResult,
  ProducerId,
} from './types';

/**
 * Canonical idempotency tuple-key for a set of output_ids. Stable under
 * permutation: callers pass output_ids in any order, this returns a single
 * comparable string. Used to stamp `metadata.output_ids_key` on draft rows
 * (route + action paths share this helper so a route-stamped key matches an
 * action-stamped key).
 */
export function outputIdsKey(outputIds: string[]): string {
  return JSON.stringify([...outputIds].sort());
}

export type StableIdInput =
  | {
      producer: 'coding';
      tool: string;
      rule_id: string;
      file_path: string;
      line_number: number;
    }
  | {
      producer: 'kag';
      session_id: string;
      url: string;
    }
  | {
      producer: 'artifacts';
      artifact_id: string;
      version: string;
    };

function sha256Hex(input: string): string {
  return new Bun.CryptoHasher('sha256').update(input).digest('hex');
}

/**
 * Producer-keyed canonical stable_id. Matches spec §Dedup verbatim — change
 * the formula here and you orphan every previously-promoted card.
 */
export function computeStableId(input: StableIdInput): string {
  switch (input.producer) {
    case 'coding':
      return sha256Hex(
        `coding|${input.tool}|${input.rule_id}|${input.file_path}|${input.line_number}`,
      );
    case 'kag':
      return sha256Hex(`kag|${input.session_id}|${input.url}`);
    case 'artifacts':
      return sha256Hex(`artifacts|${input.artifact_id}|${input.version}`);
  }
}

/**
 * Whitespace + case-insensitive content fingerprint. Used as the secondary
 * dedup key when a producer changes its stable_id schema mid-flight.
 */
export function computeContentDigest(title: string, body: string): string {
  const normalize = (s: string) =>
    s.trim().replace(/\s+/g, ' ').toLowerCase();
  return sha256Hex(`${normalize(title)}\n${normalize(body)}`);
}

/**
 * Two-stage lookup: stable_id first, content_digest fallback. Emits
 * `fr.bridge.dedup.hit` on either hit. Returns `{ match: null }` on miss.
 */
export async function lookup(
  db: BridgeDb,
  projectId: string,
  producer: ProducerId,
  stableId: string,
  contentDigest: string,
): Promise<DedupLookupResult> {
  // Stage 1 — stable_id match (the authoritative producer-supplied key).
  const stableHits = await db
    .select()
    .from(cardBridgeLinks)
    .where(
      and(
        eq(cardBridgeLinks.project_id, projectId),
        eq(cardBridgeLinks.producer, producer),
        eq(cardBridgeLinks.stable_id, stableId),
      ),
    )
    .limit(1);

  const stableHit = stableHits[0];
  if (stableHit) {
    await emitSpan(
      'fr.bridge.dedup.hit',
      {
        producer,
        existing_card_id: stableHit.card_id,
        match_type: 'stable_id',
      },
      async () => undefined,
    );
    return { match: 'stable_id', card_id: stableHit.card_id };
  }

  // Stage 2 — digest fallback (catches producer schema drift).
  const digestHits = await db
    .select()
    .from(cardBridgeLinks)
    .where(
      and(
        eq(cardBridgeLinks.project_id, projectId),
        eq(cardBridgeLinks.producer, producer),
        eq(cardBridgeLinks.content_digest, contentDigest),
      ),
    )
    .limit(1);

  const digestHit = digestHits[0];
  if (digestHit) {
    await emitSpan(
      'fr.bridge.dedup.hit',
      {
        producer,
        existing_card_id: digestHit.card_id,
        match_type: 'digest',
      },
      async () => undefined,
    );
    return { match: 'digest', card_id: digestHit.card_id };
  }

  return { match: null };
}

/**
 * Single-roundtrip batch lookup. For an array of `(stable_id, content_digest)`
 * inputs, runs ONE SELECT covering both the stable_id-column and
 * content_digest-column matches, then buckets the rows back to per-input
 * results. stable_id wins when both match for the same input (it's the
 * authoritative producer-supplied key).
 *
 * Returns a Map keyed by input.stable_id. Inputs with no match are still
 * present in the map with `{ match: null }` so callers can iterate inputs
 * 1:1.
 */
export async function lookupBatch(
  db: BridgeDb,
  projectId: string,
  producer: ProducerId,
  items: { stable_id: string; content_digest: string }[],
): Promise<Map<string, DedupLookupResult>> {
  const result = new Map<string, DedupLookupResult>();
  if (items.length === 0) return result;

  const stableIds = items.map((i) => i.stable_id);
  const digests = items.map((i) => i.content_digest);

  const rows = await db
    .select()
    .from(cardBridgeLinks)
    .where(
      and(
        eq(cardBridgeLinks.project_id, projectId),
        eq(cardBridgeLinks.producer, producer),
        or(
          inArray(cardBridgeLinks.stable_id, stableIds),
          inArray(cardBridgeLinks.content_digest, digests),
        ),
      ),
    );

  // Index hits both ways so each input can resolve via stable_id-first.
  const byStableId = new Map<string, (typeof rows)[number]>();
  const byDigest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!byStableId.has(r.stable_id)) byStableId.set(r.stable_id, r);
    if (!byDigest.has(r.content_digest)) byDigest.set(r.content_digest, r);
  }

  for (const item of items) {
    const sHit = byStableId.get(item.stable_id);
    if (sHit) {
      result.set(item.stable_id, {
        match: 'stable_id',
        card_id: sHit.card_id,
      });
      continue;
    }
    const dHit = byDigest.get(item.content_digest);
    if (dHit) {
      result.set(item.stable_id, { match: 'digest', card_id: dHit.card_id });
      continue;
    }
    result.set(item.stable_id, { match: null });
  }

  return result;
}

export interface RecordCommitInput {
  project_id: string;
  producer: ProducerId;
  stable_id: string;
  card_id: string;
  run_id: string;
  content_digest: string;
}

/**
 * Idempotent insert into `card_bridge_links`. On (project_id, producer,
 * stable_id) conflict updates card_id / run_id / content_digest / last_seen_at
 * — i.e. last writer wins on rerun, matching spec §Dedup step 5.
 */
export async function recordCommit(
  db: BridgeDb,
  input: RecordCommitInput,
): Promise<void> {
  await db
    .insert(cardBridgeLinks)
    .values({
      project_id: input.project_id,
      producer: input.producer,
      stable_id: input.stable_id,
      card_id: input.card_id,
      run_id: input.run_id,
      content_digest: input.content_digest,
    })
    .onConflictDoUpdate({
      target: [
        cardBridgeLinks.project_id,
        cardBridgeLinks.producer,
        cardBridgeLinks.stable_id,
      ],
      set: {
        card_id: input.card_id,
        run_id: input.run_id,
        content_digest: input.content_digest,
        last_seen_at: sql`now()`,
      },
    });
}
