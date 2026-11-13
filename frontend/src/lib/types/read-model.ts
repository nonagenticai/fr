// read-model.ts
// ============
// Frontend mirror of the backend read-model kit's Block envelope
// (backend/src/services/read-models/_lib.ts). Every cockpit read-model
// endpoint returns a composition of independently-sourced BLOCKS; each block
// carries its own provenance + freshness + availability so the UI degrades
// per-block (rendering a "source unavailable" card) instead of failing the
// whole page when one upstream is down. Keep these types in lock-step with the
// backend `BlockMeta` / `Block<T>` definitions.

/** Where a block's data came from — mirrors backend `BlockSource` (open union). */
export type BlockSource =
  | 'fr-db'
  | 'planka'
  | 'n8n'
  | 'worker-management'
  | 'metering'
  | 'kag'
  | 'requirements'
  | 'composed'
  | (string & {});

/**
 * Why a block is unavailable — mirrors backend `UnavailableKind`. Lets the UI
 * show honest per-state copy instead of one generic "temporarily unavailable"
 * (see `deriveBlockLabel`). Present only when `available:false`.
 */
export type UnavailableKind = 'no_selection' | 'no_data' | 'data_gap' | 'no_evidence' | 'error';

export interface BlockMeta {
  source: BlockSource;
  /** ISO timestamp stamped when the block resolved (success or failure). */
  fetched_at: string;
  /** false ⇒ `data` is null and `error` says why (sanitized). */
  available: boolean;
  /** 'derived' ⇒ computed by joining sources, not read from an authoritative registry. */
  confidence?: 'derived';
  /** Present only when `available:false` — classifies the reason for the UI. */
  unavailable_kind?: UnavailableKind;
  /** Sanitized failure reason — never upstream bodies, URLs, or secrets. */
  error?: string;
  /**
   * Mirror of `unavailable_kind` under the name the verification route
   * contract uses (`meta.unavailable = "no_evidence"`): the upstream answered,
   * authoritatively, that it holds no evidence for this subject.
   */
  unavailable?: 'no_evidence';
  /** A caveat about an AVAILABLE block the UI must show (e.g. "policy unknown"). */
  note?: string;
}

export type Block<T> = { data: T | null; meta: BlockMeta };

/**
 * Narrowing guard: an available block is guaranteed to carry non-null `data`.
 * Lets `{#if isAvailable(block)}` templates use `block.data` without a `!`.
 */
export function isAvailable<T>(
  b: Block<T> | null | undefined,
): b is { data: T; meta: BlockMeta } {
  return !!b && b.meta.available && b.data !== null;
}

/**
 * Build an unavailable block CLIENT-side, for a fetch the frontend itself owns.
 *
 * The backend `Block` envelope only covers reads the backend performs. When the
 * browser's own fetch fails, the natural thing is to leave the block `null` —
 * and every panel in this app renders `null` as its PRE-SELECTION prompt
 * ("Select a project to load execution evidence."). So a failed drilldown told
 * the user they had not selected anything, after they had.
 *
 * Handing the panel an unavailable block instead routes it through the
 * `BlockUnavailable` path it already has, with no component change.
 */
export function clientErrorBlock<T>(source: string, reason: string): Block<T> {
  return {
    data: null,
    meta: {
      source,
      fetched_at: new Date().toISOString(),
      available: false,
      unavailable_kind: 'error',
      error: reason,
    },
  };
}
