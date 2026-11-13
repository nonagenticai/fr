/**
 * KAG Media Discovery frontend client.
 *
 * Read + compute surface over the `/api/research/media/*` proxy (KAG gateway →
 * Media Discovery service). Everything goes through `assetFetch` (unwraps
 * `{ data }`, throws `AssetError` on failure). Shapes are kept loose — upstream
 * media payloads vary and are rendered defensively by the Media tab.
 *
 * Only reads/compute are exposed here; media writes (collection mutate, download
 * create, ingest push) intentionally have no client method (and no backend
 * route) — they stay in the n8n node / admin tooling.
 */

import { assetFetch } from './assets';

export interface MediaSearchRequest {
  query: string;
  sources?: string[];
  max_results_per_source?: number;
  media_type?: string;
  [key: string]: unknown;
}

export interface MediaItem {
  id?: string;
  item_id?: string;
  title?: string;
  url?: string;
  media_type?: string;
  source?: string;
  duration_seconds?: number;
  published_at?: string;
  thumbnail_url?: string;
  description?: string;
  [key: string]: unknown;
}

export interface MediaSearchResponse {
  query?: string;
  total_results?: number;
  results?: MediaItem[];
  sources_queried?: string[];
  sources_failed?: string[];
  [key: string]: unknown;
}

export interface MediaTranscript {
  item_id?: string;
  language?: string;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
  text?: string;
  [key: string]: unknown;
}

export const mediaApi = {
  /** Federated media search across the registered media sources. */
  async search(body: MediaSearchRequest): Promise<MediaSearchResponse> {
    return await assetFetch<MediaSearchResponse>('/api/research/media/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  /** Live registered media search sources (+ enabled state). */
  async sources(): Promise<unknown> {
    return await assetFetch<unknown>('/api/research/media/sources');
  },

  /** Full detail for one media item. */
  async item(itemId: string): Promise<MediaItem> {
    return await assetFetch<MediaItem>(
      `/api/research/media/items/${encodeURIComponent(itemId)}`,
    );
  },

  /** Media items related to a given item. */
  async related(itemId: string): Promise<MediaItem[]> {
    const raw = await assetFetch<unknown>(
      `/api/research/media/items/${encodeURIComponent(itemId)}/related`,
    );
    if (Array.isArray(raw)) return raw as MediaItem[];
    const obj = (raw ?? {}) as Record<string, unknown>;
    const arr = obj.results ?? obj.items ?? obj.related;
    return Array.isArray(arr) ? (arr as MediaItem[]) : [];
  },

  /** A media item's transcript — what was actually said (the trust surface). */
  async transcript(itemId: string): Promise<MediaTranscript> {
    return await assetFetch<MediaTranscript>(
      `/api/research/media/items/${encodeURIComponent(itemId)}/transcript`,
    );
  },

  /** A media item's relevance/quality score (compute; no mutation). */
  async itemScore(itemId: string): Promise<unknown> {
    return await assetFetch<unknown>(
      `/api/research/media/items/${encodeURIComponent(itemId)}/score`,
    );
  },

  /** Browse the tenant's media collections. */
  async collections(): Promise<unknown> {
    return await assetFetch<unknown>('/api/research/media/collections');
  },

  /** A single collection's detail (its items). */
  async collection(collectionId: string): Promise<unknown> {
    return await assetFetch<unknown>(
      `/api/research/media/collections/${encodeURIComponent(collectionId)}`,
    );
  },
};

/** Best-effort id for a media item across upstream field-name variants. */
export function mediaItemIdOf(m: MediaItem): string | undefined {
  return (
    (typeof m.id === 'string' && m.id) ||
    (typeof m.item_id === 'string' && m.item_id) ||
    undefined
  );
}
