// kagAsk.ts
// =========
// Pure, framework-free types + helpers for the KAG "Ask" surface, shared by the
// single-result Ask tab renderer (KagAskAnswerBody) and the side-by-side
// "Compare modes" panel (KagCompareModesPanel). Lifting the derivations here
// keeps the retrieval-diagnostics logic identical across both surfaces and lets
// them be unit-tested without mounting a component.
//
// The helpers mirror KagAskSearchTab.svelte's derivations VERBATIM so a column
// in the compare grid explains WHY an answer was (or wasn't) produced exactly as
// the standalone tab does.

export type AskMode = 'dense' | 'hybrid' | 'hybrid_rerank' | 'full';

export const COMPARE_MODES = ['dense', 'hybrid', 'hybrid_rerank', 'full'] as const satisfies readonly AskMode[];

/**
 * Always-present retrieval summary from kag /query/ask — lets us explain WHY an
 * answer was (or wasn't) produced instead of showing a bare abstention.
 */
export interface RetrievalDiagnostics {
  tenant_id?: string;
  subject_id?: string;
  dense_count?: number;
  lexical_count?: number;
  fused_count?: number;
  survivor_count?: number;
  graph_bridge_count?: number;
  graph_fact_count?: number;
  near_dup_collapsed?: number;
  top_score?: number | null;
  abstained?: boolean;
  abstain_reason?: 'no_matching_content' | 'insufficient_context' | 'partial_context' | null;
  abstain_retried?: boolean;
  rerank_degraded?: boolean;
  rerank_degraded_reason?: 'unreachable' | 'timeout' | 'malformed' | 'no_backend' | 'http_error' | null;
}

/**
 * RAG Q&A response is upstream-defined and only loosely typed — we tolerate
 * `answer` + zero-or-more of `chunks`/`citations`/`sources`.
 */
export interface AskResult {
  answer?: string;
  chunks?: Array<Record<string, unknown>>;
  citations?: Array<Record<string, unknown>>;
  sources?: Array<Record<string, unknown>>;
  diagnostics?: RetrievalDiagnostics;
  /** server-reported latency; informational (cost is NOT exposed to the client). */
  latency_ms?: number;
}

export type ColumnStatus = 'pending' | 'ok' | 'error';

export interface CompareColumn {
  mode: AskMode;
  status: ColumnStatus;
  result?: AskResult;
  error?: string;
  /** client wall-clock latency for this column's request. */
  latencyMs?: number;
}

// ---- pure helpers (mirror the tab's current derivations exactly) ----

/**
 * Best-match percentage from top_score, or null when no numeric score.
 *
 * @deprecated `top_score` is NOT always a probability: outside the reranking
 * modes it is an RRF fusion score, and a percentage of one is meaningless (see
 * `askScoreScale`). This helper also `Math.round`s, so 0.99964 renders as a
 * fabricated `100%`. Use `askScoreScale` / `askBestMatchLabel`, which need the
 * mode to decide whether a percentage may be shown at all. Kept exported only
 * so existing callers/tests keep compiling.
 */
export function askTopPctFrom(d?: RetrievalDiagnostics): number | null {
  return d && typeof d.top_score === 'number' ? Math.round(d.top_score * 100) : null;
}

/**
 * The retrieval modes whose `top_score` comes out of the cross-encoder — the
 * ONLY ones where the number is a calibrated 0..1 relevance and a percentage
 * means anything. kag runs the cross-encoder for `hybrid_rerank`, `full`,
 * `full_nobridge` and `dense_rerank` only; `full_nobridge`/`dense_rerank` are
 * not in `AskMode` (the UI never offers them) but are listed so this set stays
 * the single statement of the backend's behaviour.
 *
 * Deliberately an ALLOW-list rather than a deny-list of {dense, hybrid}: an
 * unrecognised mode then falls to the fusion scale and withholds the figure,
 * instead of silently inheriting a confidence it never earned. That is the
 * exact defect this module already carries once.
 */
const CROSS_ENCODER_MODES: ReadonlySet<string> = new Set([
  'hybrid_rerank',
  'full',
  'full_nobridge',
  'dense_rerank',
]);

/** Modes whose candidate list is the raw dense list, never RRF-fused. */
const DENSE_ONLY_MODES: ReadonlySet<string> = new Set(['dense', 'dense_rerank']);

/**
 * Which scale `top_score` is on for this ask, and therefore whether a
 * percentage may be rendered from it at all.
 *
 * There are THREE scales, not two. Measured over the 588 recorded rows of the
 * 2026-07-09 hotpotqa benchmark run (`eval/_runs/n150/hotpotqa/results.jsonl`):
 *
 *   mode            top_score min .. max      rendered by Math.round(x*100)
 *   dense              0.3922 .. 0.8763            39% .. 88%
 *   hybrid             0.0049 .. 0.0213             0% ..  2%
 *   full_nobridge      0.1108 .. 1.0000            11% .. 100%
 *   full               0.1139 .. 1.0000            11% .. 100%
 *
 * - `'none'` — there is no numeric score to render.
 * - `'fusion'` — an RRF score, `sum(weight / (60 + rank))`. `hybrid` measures
 *   0.0049-0.0213, i.e. it prints "0%" to "2%" and reads as "nothing matched" —
 *   a fabrication in the opposite direction to "100%".
 * - `'similarity'` — the raw vector-similarity score of the dense list. `dense`
 *   does NOT fuse (`ask_pipeline.py`: `if req.mode in (DENSE, DENSE_RERANK):
 *   fused = dense_lists[0]`), so its score is a real 0-1 similarity. It is
 *   withheld anyway, because it is not the reranker's relevance and the compare
 *   grid puts it under the SAME label, one column away — 88% similarity beside
 *   96% cross-encoder is still two units under one name.
 * - `'crossencoder'` — the reranker's calibrated relevance, the only case where
 *   a percentage is an honest rendering. Note the measured max is exactly
 *   1.0000 with a median of 0.9987, so `Math.round` printed "100%" for the
 *   MEDIAN full-mode answer. That is why the label floors and caps at 99%.
 *
 * Two doors lead away from `'crossencoder'` and both must be shut: the mode
 * never reranks (`dense`, `hybrid` — the common case, since `COMPARE_MODES`
 * fans every question across all four), and the cross-encoder ran and FAILED
 * (`rerank_degraded`). The original code shut only the second.
 */
export function askScoreScale(
  mode: AskMode,
  d?: RetrievalDiagnostics,
): 'crossencoder' | 'fusion' | 'similarity' | 'none' {
  if (!d || typeof d.top_score !== 'number') return 'none';
  // A failed rerank serves whatever the pre-rerank order was, which is the
  // dense list for the dense-only modes and an RRF fusion everywhere else.
  if (d.rerank_degraded) return DENSE_ONLY_MODES.has(mode) ? 'similarity' : 'fusion';
  if (CROSS_ENCODER_MODES.has(mode)) return 'crossencoder';
  return DENSE_ONLY_MODES.has(mode) ? 'similarity' : 'fusion';
}

export type AskScoreScale = ReturnType<typeof askScoreScale>;

/**
 * The score scale a surface can declare from the RESPONSE, not from an ask mode.
 *
 * Passage search has no ask mode — `askScoreScale` therefore cannot serve it, and
 * KagChunkCard's `mode === undefined → 'none'` default makes every card read a
 * bare "unavailable", which reads as a broken score rather than a withheld one.
 * But the scale is not unknown there: `/query/chunks` returns `score_kind`
 * REQUIRED with no default, precisely so the unit travels with the number.
 *
 * ⛔ This does NOT unlock a percentage. `'crossencoder'` is deliberately
 * unreachable from here: no `score_kind` kag emits is a cross-encoder scale, and
 * a percentage of an RRF score is meaningless whatever the rounding. The only
 * thing that changes is that the withheld label can NAME its scale.
 *
 * An unrecognised kind returns `'none'`, keeping the card's rule intact: an
 * unknown scale is not an excuse to guess one.
 */
export function scoreKindScale(kind: string | undefined): AskScoreScale {
  if (kind === 'rrf') return 'fusion';
  if (kind === 'cosine') return 'similarity';
  return 'none';
}

/**
 * The integer percentage for a cross-encoder score — THE single site of that
 * arithmetic, so no second surface can render the same score differently.
 *
 * It FLOORS rather than rounds, and caps at 99: rounding turned
 * `top_score: 0.99964` into a manufactured `100%`, and no retrieval hop ever
 * reports certainty. Flooring also guarantees the figure never overstates the
 * score it came from.
 *
 * Callers MUST have established `askScoreScale(...) === 'crossencoder'` first —
 * this function does not know which scale it was handed, and a percentage of an
 * RRF score is meaningless whatever the rounding.
 */
export function askScorePct(score: number): number {
  return Math.min(99, Math.floor(score * 100));
}

/**
 * How a withheld score is named, for every surface that withholds one (the
 * "Best match" line, the diagnostics strip, the per-passage badge on
 * KagChunkCard). Shared so the wording — and therefore the reader's ability to
 * tell the two withholding reasons apart — cannot drift between them.
 *
 * `'similarity'` is named separately from `'fusion'` on purpose: `dense` IS
 * scored, just not on the reranker's scale. Calling it "fusion order, not
 * scored" would be a second wrong explanation layered over the first wrong
 * number. `'none'` gets a bare "unavailable": there is no scale to name.
 */
export function askScaleLabel(scale: AskScoreScale): string {
  if (scale === 'fusion') return 'unavailable (fusion order, not scored)';
  if (scale === 'similarity') return 'unavailable (vector similarity, not a match score)';
  return 'unavailable';
}

/**
 * The rendered "Best match" value for this ask.
 *
 * A percentage ONLY on the cross-encoder scale; otherwise the value is withheld
 * and the reason named instead — the raw `top_score` still travels in the API
 * response, it is simply not a confidence figure.
 */
export function askBestMatchLabel(mode: AskMode, d?: RetrievalDiagnostics): string {
  const scale = askScoreScale(mode, d);
  // The `typeof` re-check is what `scale === 'crossencoder'` already implies; it
  // is here so the narrowing is the compiler's, not a cast asserting what we
  // believe.
  if (scale !== 'crossencoder' || typeof d?.top_score !== 'number') return askScaleLabel(scale);
  return `${askScorePct(d.top_score)}%`;
}

/** How many passages were searched: fused, else dense, else 0 — null with no diagnostics. */
export function askSearchedFrom(d?: RetrievalDiagnostics): number | null {
  return d ? (d.fused_count ?? d.dense_count ?? 0) : null;
}

/**
 * Full retrieval-pipeline breakdown: dense/lexical arms → fused → survived rerank
 * → best match. Each stat is included only when the upstream diagnostics carry it,
 * so precise-passage mode (no diagnostics) yields an empty list.
 *
 * The "Best match" row is a percentage ONLY when `top_score` came from the
 * cross-encoder. There are TWO doors onto the RRF fusion scale, and for a long
 * time only the first was shut:
 *
 *   1. `rerank_degraded` — the cross-encoder hop ran and failed, so the pipeline
 *      served the fusion order.
 *   2. the mode never reranks — `dense` and `hybrid` have no cross-encoder hop
 *      at all, and `rerank_degraded` stays `false` because nothing degraded.
 *      This is the door that stayed open, and it is the LIVE one: `COMPARE_MODES`
 *      fans every question across all four modes, so the dense and hybrid
 *      columns rendered a fusion score as a percentage right beside full's
 *      cross-encoder percentage — different units, no disclosure.
 *
 * An RRF score is `sum(weight / (60 + rank))`, topping out near 0.021 (hybrid) /
 * 0.071 (full), so a percentage there renders "2%" and reads as "nothing
 * matched" — a fabrication in the opposite direction to the "100%" that
 * `Math.round` used to manufacture from 0.99964. A percentage is not a
 * meaningful rendering of an RRF score, so on either door we name the cause
 * instead; the raw `top_score` still travels in the API response. Which door was
 * taken is not collapsed: the `Reranker` row is pushed whenever the hop
 * degraded, so a failed reranker stays distinguishable from a mode that never
 * had one. With no numeric score there is nothing to withhold and no row is
 * pushed at all (`askBestMatchLabel` still answers `unavailable` for callers
 * that render the absence explicitly).
 */
export function askStatsFrom(
  mode: AskMode,
  d?: RetrievalDiagnostics,
): Array<{ label: string; value: string }> {
  if (!d) return [];
  const out: Array<{ label: string; value: string }> = [];
  if (typeof d.dense_count === 'number') out.push({ label: 'Dense', value: String(d.dense_count) });
  if (typeof d.lexical_count === 'number') out.push({ label: 'Lexical', value: String(d.lexical_count) });
  if (typeof d.fused_count === 'number') out.push({ label: 'Fused', value: String(d.fused_count) });
  if (typeof d.survivor_count === 'number') out.push({ label: 'Survivors', value: String(d.survivor_count) });
  // A degraded hop with no score still gets the row: the reader must see that a
  // value was withheld, not just that a reranker misbehaved.
  if (askScoreScale(mode, d) !== 'none' || d.rerank_degraded) {
    out.push({ label: 'Best match', value: askBestMatchLabel(mode, d) });
  }
  // Separate information from the withheld value: WHY the cross-encoder hop is
  // missing. Only a degraded hop gets this row — a mode that never reranks has
  // no failure to report, and an unconditional caveat is the same lie inverted.
  if (d.rerank_degraded) {
    out.push({ label: 'Reranker', value: d.rerank_degraded_reason ?? 'degraded' });
  }
  return out;
}

/** Null-safe millisecond formatter. */
export function fmtMs(v?: number | null): string {
  return v == null ? '—' : `${Math.round(v)} ms`;
}

/**
 * The retrieved passage texts of an Ask result, for use as RAGAS `contexts`
 * (faithfulness is measured against exactly what the answer was grounded in).
 * Mirrors KagChunkCard's text probe (`text`/`content`/`chunk`/`passage`); drops
 * empties. Used by the "Verify this answer" surface (P3-D3).
 */
export function askContextsFrom(result: AskResult | null | undefined): string[] {
  const out: string[] = [];
  for (const c of result?.chunks ?? []) {
    if (!c || typeof c !== 'object') continue;
    const bag = c as Record<string, unknown>;
    const v = bag.text ?? bag.content ?? bag.chunk ?? bag.passage;
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return out;
}

// ---- citation labels ----

/**
 * A citation's provenance metadata is NESTED under `.source` in kag's real
 * `Citation` contract (models/ask.py: `{marker, chunk_id, kind, source:
 * {doc_id, title, url, page, chunk_id, graph_bridge}}`) — `page` is a SCALAR and
 * there is no top-level `title`/`doc_id`/`pages`. Probe `.source` first, then
 * fall through to the flat legacy shape some semantic-search routes still emit,
 * exactly as KagChunkCard does, so one label renders both without knowing which
 * it got.
 */
function citationPick(
  c: Record<string, unknown>,
  src: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const bag of [src, c]) {
    for (const k of keys) {
      const v = bag[k];
      if (typeof v === 'string' && v.length > 0) return v;
      if (typeof v === 'number') return String(v);
    }
  }
  return undefined;
}

/**
 * A human-readable name for a document that has no title: the last path segment
 * (a filename) when there is one, else the host. Never a raw id.
 */
function nameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const path = url.trim().split(/[?#]/)[0];
  // Drop the scheme token (`https:`) and empty segments left by `//`.
  const segments = path.split('/').filter((s) => s.length > 0 && !s.endsWith(':'));
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** A UUID (with or without dashes) is an opaque id, never a name. */
const OPAQUE_DOC_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/**
 * A `doc_id` worth showing to a human, or `undefined`.
 *
 * Deliberately conservative: anything that parses as a UUID is suppressed so we
 * never regress to printing an id at the user. Everything else — the slug shapes
 * ingestion actually writes — is better than "Untitled document".
 */
function readableDocId(docId: string | undefined): string | undefined {
  if (!docId) return undefined;
  return OPAQUE_DOC_ID.test(docId) ? undefined : docId;
}

/**
 * The one-line label for a citation row, shared by KagAskAnswerBody and the
 * Ask & search tab.
 *
 * Was duplicated in both components and read TOP-LEVEL `title`/`doc_id`/`pages`
 * — fields the backend has never emitted — so every citation rendered literally
 * `(unnamed)`. Name resolution is title → readable host/filename from the url →
 * `Untitled document`; a raw UUID `doc_id` is NEVER shown as the name.
 */
export function citationLabel(c: Record<string, unknown>): string {
  const bag = c && typeof c === 'object' ? c : {};
  const src =
    bag.source && typeof bag.source === 'object' && !Array.isArray(bag.source)
      ? (bag.source as Record<string, unknown>)
      : {};

  // A graph citation has no document behind it: the triple text IS the chunk_id
  // (ask_pipeline.py joins subject/predicate/object, falling back to the
  // `graph-fact` placeholder when the triple is empty).
  const kind = citationPick(bag, src, 'kind');
  const docId = citationPick(bag, src, 'doc_id', 'document_id', 'source_id');
  if (kind === 'graph' || docId === 'graph') {
    const triple = citationPick(bag, src, 'chunk_id', 'id');
    return !triple || triple === 'graph-fact'
      ? 'Knowledge graph fact'
      : `Knowledge graph: ${triple}`;
  }

  const title = citationPick(bag, src, 'title', 'document_title', 'name');
  const url = citationPick(bag, src, 'url', 'source_url');
  // Last resort before the placeholder: a doc_id that is NOT an opaque id is
  // still a name a reader can act on (ingestion writes slugs like
  // `expansion-Feature_Intake_Reference`). A UUID tells the reader nothing, so
  // it is suppressed — that distinction is the whole point of this rung.
  const name = title ?? nameFromUrl(url) ?? readableDocId(docId) ?? 'Untitled document';

  // Page is a scalar upstream, but tolerate the legacy array (`pages`).
  const page = src.page ?? src.pages ?? bag.page ?? bag.pages ?? bag.page_number;
  let pageStr = '';
  if (Array.isArray(page)) {
    const parts = page.filter((p) => typeof p === 'number' || (typeof p === 'string' && p.length > 0));
    if (parts.length > 0) pageStr = `p. ${parts.join(', ')}`;
  } else if (typeof page === 'number' || (typeof page === 'string' && page.length > 0)) {
    pageStr = `p. ${page}`;
  }

  return [name, pageStr].filter(Boolean).join(' • ');
}
