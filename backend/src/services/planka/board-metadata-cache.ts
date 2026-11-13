// Board METADATA cache — the small, slow-changing half of `GET /api/boards/:id`.
//
// ── THE DEFECT (measured 2026-09-09) ────────────────────────────────────────
// `GET /api/cards/:id` (routes/cards/get.ts) fetched the ENTIRE board on every
// request in order to read two things: one list's NAME, and the board's
// customFieldId → (groupName, fieldName) mapping. Planka's board-detail
// endpoint has no projection parameter, so `included` also carries every card
// on the board AND every customFieldValue of every card. On the largest live
// board that is 3,943 cards / 44,092 customFieldValues ≈ 17 MB of raw JSON,
// which costs roughly 100–300 MB of transient heap to receive and parse.
//
// fr-backend runs with a 1 GiB container limit, so TWO concurrent card reads
// could exhaust it. On 2026-09-09 a sustained ~25/min sweep of
// `GET /api/cards/{id}` OOMKilled the pod twice (exit 137), the second time
// after 4m16s alive. Baseline RSS had been flat at 110–155 MiB for the six
// preceding hours; the step to 400+ MiB at 04:51 was a load-shape change, not
// a leak.
//
// ── WHY A CACHE AND NOT A NARROWER CALL ─────────────────────────────────────
// Checked against TWO independent sources: the vendored OpenAPI spec
// (`docs/planka-openapi.json`, generated from Planka's own swagger annotations)
// and the route table of the fork actually deployed — `planka-private` 2.1.0,
// `server/config/routes.js`, pinned by digest in
// `clusters/prod/services/kanban/deployment.yaml`. Both
// agree. There is NO narrower read:
//   * `/boards/{boardId}/lists`                — POST only. No GET. Planka has
//       no list-index action of ANY kind (`server/api/controllers/lists/` has
//       no `index`), so a board's list ids are unobtainable without the board
//       read. This half has no alternative at all.
//   * `/boards/{boardId}/custom-field-groups`  — POST only. No GET.
//   * `/lists/{id}`                            — GET exists, but it is NOT narrow:
//       `lists/show.js` eagerly loads that list's cards, cardMemberships,
//       cardLabels, taskLists, tasks, attachments AND customFieldValues. The
//       same fan-out as the board read, scoped to one list. O(list size).
//   * `/custom-field-groups/{id}`              — GET exists and IS narrow (for a
//       board-level group it short-circuits `customFieldValues` to []). It
//       loses anyway: it is id-addressed with no enumeration, so you must read
//       the board once regardless just to learn the 9 group ids — and it turns
//       one round-trip into nine. It would still leave `lists` unsolved.
//   * `GET /boards/{id}` takes no projection/`include`/`fields` parameter:
//       `boards/show.js` declares exactly two inputs (`id`, `subscribe`) and
//       builds `included` unconditionally.
// So the board read cannot be made cheaper. It can only be made RARER, and it
// can be stopped from happening CONCURRENTLY.
//
// ── WHAT THIS MODULE RETAINS ────────────────────────────────────────────────
// It never retains the expensive bags. The fetched payload is projected down to
// three small arrays (`lists`, `customFieldGroups`, `customFields`) and the
// response object is dropped on the same tick; `included.cards` and
// `included.customFieldValues` are never referenced, so they are unreachable as
// soon as the projection returns. A cached entry is a few KB, not 17 MB.
//
// ── THE TWO PROPERTIES THAT ACTUALLY FIX THE OOM ────────────────────────────
//  1. TTL: at most one board read per board per TTL window, instead of one per
//     card request. Under the observed 25/min single-board sweep that is 60
//     full-board reads/minute → 1.
//  2. SINGLE-FLIGHT: N concurrent misses for the same board share ONE in-flight
//     upstream read. This is the property that removes the concurrency
//     multiplier — without it, a cold cache under a burst still allocates N
//     copies of a 17 MB payload at once, which is exactly the OOM.
//
// ── BOUND ───────────────────────────────────────────────────────────────────
// `MAX_BOARDS = 256`, LRU by last read (Map insertion order is the recency
// order: a hit deletes and re-inserts the key, so the oldest key is always
// first). An unbounded per-board cache on a multi-tenant service trades an OOM
// for a slower OOM, so the bound is not optional.
//
// Worst-case retained size is small and computable. Per entry we keep only
// `{id,name}` for each list, `{id,name}` for each group and
// `{id,name,customFieldGroupId}` for each field. An AA board carries 9 groups
// and ~90 fields and single-digit lists — call it ~5 KB distilled. Even a
// pathological board with 100 lists and 1,000 custom fields distils to roughly
// 150 KB. So 256 boards is ~1.3 MB typical and bounded by ~38 MB in a
// pathology that does not exist on this estate — against the 100–300 MB that a
// SINGLE uncached request was costing.
//
// ── STALENESS ───────────────────────────────────────────────────────────────
// A cache entry can only be wrong about the board's SCHEMA. Everything the card
// detail actually asserts about the card — which list it is in, its field
// VALUES, its tasks, approvals, decisions — is read fresh from
// `GET /api/cards/:id` on every request and is never cached. In particular a
// card MOVING between lists is reflected immediately: `card.item.listId` is
// fresh, and only the mapping from that id to a display name comes from here.
//
// Additions self-invalidate. Callers pass the ids the fresh card actually
// references (`probeListId`, `probeFieldIds`); an id the cached entry has never
// heard of is positive proof the entry predates that list/field, and the entry
// is discarded and refetched ONCE. That covers "a new custom field was added
// and this card already has a value for it" and "the card was moved into a
// newly created list" — the two staleness modes that would otherwise silently
// drop data from the response.
//
// The residual, accepted staleness window is therefore exactly: a RENAME of an
// already-existing list, group, or custom field is visible up to TTL_MS late on
// this read path. That is safe here because (a) the AA phase lists and the 9 AA
// customFieldGroups are provisioned once from `improvement-cards/field-groups.ts`
// and renamed essentially never, (b) a rename changes a display label only — no
// value, no id, no authorization decision depends on it, and (c) this is a
// read-only detail view, so a 60-second-late label cannot corrupt anything
// downstream. Renames are NOT detectable by id-presence, which is why they are
// stated as accepted rather than claimed as handled.

/** A board's custom field group as Planka returns it in `included`. */
export interface BoardMetadataGroup {
  id: string;
  name: string;
}

/** A board's custom field as Planka returns it in `included`. */
export interface BoardMetadataField {
  id: string;
  name: string;
  customFieldGroupId: string;
}

/** A board's list, reduced to what a name lookup needs. */
export interface BoardMetadataList {
  id: string;
  name: string;
}

/**
 * The distilled projection of `GET /api/boards/:id`. These three arrays are
 * the ONLY parts of that payload any caller of this module needs.
 */
export interface BoardMetadata {
  lists: BoardMetadataList[];
  customFieldGroups: BoardMetadataGroup[];
  customFields: BoardMetadataField[];
}

/** The raw board-detail shape, narrowed to the parts we project. */
export interface RawBoardDetail {
  included?: {
    lists?: BoardMetadataList[];
    customFieldGroups?: BoardMetadataGroup[];
    customFields?: BoardMetadataField[];
  };
}

export const TTL_MS = 60_000;
export const MAX_BOARDS = 256;

interface Entry {
  meta: BoardMetadata;
  /** Every list id the board declared — the "is this entry stale?" probe. */
  listIds: Set<string>;
  /**
   * Every custom field id the board declared, INCLUDING fields in groups the
   * AA normaliser ignores. Using only AA field ids here would make every card
   * carrying a non-AA custom field look like a stale-cache hit and refetch on
   * every request, defeating the cache.
   */
  fieldIds: Set<string>;
  expiresAt: number;
}

/**
 * Project a board-detail response down to the three small arrays. The caller's
 * reference to the full response dies with the call, so `included.cards` and
 * `included.customFieldValues` become unreachable immediately.
 */
export function projectBoardMetadata(raw: RawBoardDetail): BoardMetadata {
  return {
    lists: (raw.included?.lists ?? []).map((l) => ({ id: l.id, name: l.name })),
    customFieldGroups: (raw.included?.customFieldGroups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
    })),
    customFields: (raw.included?.customFields ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      customFieldGroupId: f.customFieldGroupId,
    })),
  };
}

/** Observable counters — the acceptance evidence for "the board read got rarer". */
export interface BoardMetadataCacheStats {
  hits: number;
  misses: number;
  /** Misses that joined an already-in-flight fetch instead of starting one. */
  coalesced: number;
  /** Entries discarded because a fresh card referenced an id they lacked. */
  staleRefetches: number;
  evictions: number;
  /** Upstream `GET /api/boards/:id` calls actually issued. */
  upstreamReads: number;
  size: number;
}

export interface GetBoardMetadataArgs {
  boardId: string;
  /** Issues the upstream `GET /api/boards/:id`. Errors propagate unchanged. */
  fetchBoard: () => Promise<RawBoardDetail>;
  /** The list id the FRESH card is in. An unknown id proves the entry is stale. */
  probeListId?: string;
  /** Custom field ids the FRESH card has values for. Unknown ⇒ entry is stale. */
  probeFieldIds?: Iterable<string>;
}

export class BoardMetadataCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<BoardMetadata>>();

  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private staleRefetches = 0;
  private evictions = 0;
  private upstreamReads = 0;

  stats(): BoardMetadataCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      staleRefetches: this.staleRefetches,
      evictions: this.evictions,
      upstreamReads: this.upstreamReads,
      size: this.entries.size,
    };
  }

  async get(args: GetBoardMetadataArgs): Promise<BoardMetadata> {
    const { boardId, fetchBoard, probeListId, probeFieldIds } = args;

    const entry = this.entries.get(boardId);
    if (entry) {
      if (entry.expiresAt <= Date.now()) {
        this.entries.delete(boardId);
      } else if (this.entryKnows(entry, probeListId, probeFieldIds)) {
        // LRU touch: re-insert so this key moves to the END of the insertion
        // order, keeping the FIRST key the least-recently-used one.
        this.entries.delete(boardId);
        this.entries.set(boardId, entry);
        this.hits += 1;
        return entry.meta;
      } else {
        // The fresh card references a list or field this entry has never seen,
        // so the entry provably predates a schema addition. Discard it.
        this.entries.delete(boardId);
        this.staleRefetches += 1;
      }
    }

    this.misses += 1;

    // ── Single-flight ───────────────────────────────────────────────────────
    // This is the property that bounds CONCURRENT full-board parses to one per
    // board. Without it a burst on a cold entry allocates N × 17 MB at once,
    // which is the OOM this module exists to remove.
    const existing = this.inflight.get(boardId);
    if (existing) {
      this.coalesced += 1;
      return existing;
    }

    const flight = (async (): Promise<BoardMetadata> => {
      this.upstreamReads += 1;
      const raw = await fetchBoard();
      const meta = projectBoardMetadata(raw);
      this.store(boardId, meta);
      return meta;
    })();

    // Registered BEFORE the first await point of any joiner, and removed in a
    // finally so a FAILED read never leaves a poisoned promise behind. A
    // failure is not cached: the next caller retries upstream.
    this.inflight.set(boardId, flight);
    try {
      return await flight;
    } finally {
      this.inflight.delete(boardId);
    }
  }

  private entryKnows(
    entry: Entry,
    probeListId?: string,
    probeFieldIds?: Iterable<string>,
  ): boolean {
    if (probeListId !== undefined && !entry.listIds.has(probeListId)) {
      return false;
    }
    if (probeFieldIds) {
      for (const id of probeFieldIds) {
        if (!entry.fieldIds.has(id)) return false;
      }
    }
    return true;
  }

  private store(boardId: string, meta: BoardMetadata): void {
    this.entries.delete(boardId);
    this.entries.set(boardId, {
      meta,
      listIds: new Set(meta.lists.map((l) => l.id)),
      fieldIds: new Set(meta.customFields.map((f) => f.id)),
      expiresAt: Date.now() + TTL_MS,
    });
    while (this.entries.size > MAX_BOARDS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }
}

/**
 * Process-wide instance. fr-backend runs one board-metadata cache per process;
 * a per-request cache would never hit and would not have prevented the OOM.
 */
export const boardMetadataCache = new BoardMetadataCache();
