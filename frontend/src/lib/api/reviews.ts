/**
 * Evidence Review 8810 client — `/api/assets/kag/reviews/*`.
 *
 * Deliberately NOT `assetFetch`. That helper expects fr's `{ data }` /
 * `{ error: { code, message } }` envelope, and the reviews route is a byte-level
 * passthrough that returns Evidence Review's own body. Running it through
 * `assetFetch` would read `body.error` on a failure, find nothing, and surface
 * `"400 Bad Request"` — throwing away the `code` the UI needs to distinguish
 * `forbidden_discriminator` from `precondition_failed`, which is exactly the
 * fidelity the passthrough exists to preserve.
 *
 * So this reads RFC 9457 problem details, keeps `code` and `status`, and
 * exposes the response headers a caller needs (`ETag` for `expected_revision`).
 */

import { authFetch } from './auth-fetch';
// The ONE flattener for a FastAPI 422 `detail` array. This module is a
// byte-level RFC 9457 passthrough and must NOT read fr's `{error:{…}}`
// envelope, so it takes only that pure helper — never `errorDetailFrom`.
import { flattenDetailArray } from './error-detail';

const BASE = '/api/assets/kag/reviews';

export class ReviewError extends Error {
  readonly status: number;
  /** The stable slug — `forbidden_discriminator`, `not_found`, … */
  readonly code: string | undefined;
  /** Extra members the problem body carried, e.g. `forbidden_paths`. */
  readonly detail: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code?: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReviewError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The human-readable message for a failed response.
 *
 * Exported so it can be tested against the real bodies each hop emits, rather
 * than only through a mocked `fetch`.
 *
 * RFC 9457 carries the explanation in `detail` and a short summary in `title`.
 * Evidence Review sends both, and a string `detail` was the only shape this
 * client used to read. Two other shapes reach it through the passthrough, and
 * BOTH collapsed to `"400 Bad Request"` — the exact string this module's
 * docstring above says it exists to avoid:
 *
 * 1. **FastAPI/Pydantic's framework-level 422**, whose `detail` is an ARRAY of
 *    `{ loc, msg, type }` entries, not a string. This is the shape a caller
 *    most needs rendered, because it is the only one that names the field that
 *    was wrong — and it is emitted by the validation layer sitting in front of
 *    every Evidence Review route, so a byte-level passthrough forwards it
 *    verbatim and the client discarded precisely the part worth showing.
 * 2. A problem body carrying only `title` and no `detail`, which RFC 9457
 *    explicitly permits.
 *
 * A string `detail` still wins, so nothing that worked before changes.
 */
export function problemMessage(
  problem: Record<string, unknown>,
  status: number,
  statusText: string,
): string {
  const detail = problem.detail;

  if (typeof detail === 'string' && detail.trim()) {
    return detail;
  }

  if (Array.isArray(detail)) {
    // The 422 flattener is SHARED with error-detail.ts — one rule, one reader.
    // `withLoc` is what this passthrough needs and the fr-envelope callers must
    // not have: it names the offending field.
    const rendered = flattenDetailArray(detail, { withLoc: true, withPlainStringEntries: true });
    if (rendered) return rendered;
  }

  const title = problem.title;
  if (typeof title === 'string' && title.trim()) {
    return title;
  }

  return `${status} ${statusText}`;
}

export interface ReviewResponse<T> {
  data: T;
  /** Present on lifecycle reads/writes; feeds `expected_revision`. */
  etag: string | null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<ReviewResponse<T>> {
  const res = await authFetch(`${BASE}${path}`, init);

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const problem = (body ?? {}) as Record<string, unknown>;
    const code = typeof problem.code === 'string' ? problem.code : undefined;
    throw new ReviewError(problemMessage(problem, res.status, res.statusText), res.status, code, problem);
  }

  return { data: (body ?? null) as T, etag: res.headers.get('etag') };
}

const json = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

// ---------------------------------------------------------------------------
// Types — only the fields the studio renders.
// ---------------------------------------------------------------------------

export interface Review {
  review_id: string;
  title: string;
  project_id: string;
  external_key: string;
  /** Derived from the append-only history; there is no stored column. */
  state: string | null;
  revision: number;
  active_protocol_version_id: string | null;
  reviewers_required: number | null;
  exclusion_reason_vocabulary: string[];
  /**
   * Who created this review — the subject that holds the CREATOR GRANT.
   *
   * Evidence Review's `require_review_lead` accepts `ActorRole.LEAD` **or**
   * `review.created_by_subject_id == caller`
   * (`evidence_review_service/src/application/services/reviews.py:524-549`), and
   * `review_summary` has been returning this field on every review read all
   * along (`reviews.py:583`). It was declared nowhere in this client and
   * referenced nowhere in the studio, so the one fact that says which of a
   * panel's write controls can possibly succeed was thrown away on arrival.
   *
   * Optional, and `null` is a real answer rather than a formality: an older
   * Evidence Review, or a fixture, may not carry it — and "I do not know who
   * created this" must never be collapsed into "somebody else did". See
   * `ScreeningPanel`'s `notReviewCreator`, which treats an unknown as "do not
   * disable anything".
   *
   * It is NOT an authorization signal. A realm `lead` passes the same gate
   * without appearing here, and fr forwards no `x-actor-role`
   * (`backend/src/routes/assets/kag-reviews.ts:93`), so the client cannot see
   * that arm at all. Anything built on this field is an affordance; the server
   * remains the only authority.
   */
  created_by_subject_id?: string | null;
}

export interface ProtocolVersion {
  protocol_version_id: string;
  version_number: number;
  content_hash: string;
  exclusion_reason_vocabulary: string[];
  reviewers_required: number;
  locked: boolean;
  locked_at: string | null;
  locked_by_subject_id: string | null;
}

export interface Stage {
  stage_id: string;
  stage_key: string;
  name: string;
  stage_order: number;
  reviewers_required: number;
}

export interface CorpusVersion {
  corpus_version_id: string;
  version_number: number;
  member_count: number;
  member_ordering_rule: string;
  member_manifest_hash: string;
}

export interface ImportBatch {
  import_batch_id: string;
  source_kind: string;
  raw_payload_digest: string;
  accepted_count: number;
  quarantined_count: number;
  rejected_count: number;
  source_ref: Record<string, unknown> | null;
  replayed: boolean;
}

export interface QueueItem {
  assignment_id: string;
  review_record_id: string;
  title: string | null;
  abstract: string | null;
  publication_year: number | null;
  authors: string[] | null;
  container_title: string | null;
  doi: string | null;
  record_type: string | null;
  /**
   * The CALLER'S OWN decision, or null. There is deliberately no field here
   * describing anybody else's progress — "1 of 2 done" is a decision leak.
   */
  my_decision: {
    decision_id: string;
    disposition: string;
    exclusion_reason_code: string | null;
  } | null;
}

/**
 * ONE PAGE of `GET /screening/queue`, exactly as the service sends it.
 *
 * `GET /{id}/screening/queue` is paginated — `limit` is `ge=1, le=200` with a
 * default of **50**, and `next_cursor` is non-null whenever the page was cut
 * (`evidence_review_service/src/application/services/screening.py:358`).
 *
 * Read a page as if it were the queue and you get the defect this type exists to
 * make impossible to restate: a reviewer holding 51 assignments was shown 50,
 * with nothing on screen saying so, and the remainder were invisible — not
 * "later", not "collapsed", simply absent. Callers want `CompleteQueue`; this
 * shape is the wire fragment `collectQueue` joins.
 */
export interface Queue {
  /**
   * WHICH SCREENING PASS this queue is, as the SERVICE reports it.
   *
   * A round is a screening pass over ONE sealed corpus version, and Evidence
   * Review binds it as hard as that sounds: every assignment row stores the
   * `corpus_version_id` it was minted from, `uq_assignment_once` deliberately
   * EXCLUDES that column, and the insert is `ON CONFLICT DO NOTHING` — so a
   * round that already holds v1 can never be re-pointed at v2
   * (`services/screening.py:265-323`). The queue then resolves every item's
   * title and abstract THROUGH the assignment's corpus
   * (`screening.py:501-518`), not through the review's tail.
   *
   * This client declared no round anywhere, so every call took the service's
   * default of 1 (`api/routers/screening.py:122,146,309`) and the studio could
   * not so much as SAY which pass it was showing. After a re-seal the panel's
   * header renders v2 while this queue serves v1's text — the same records at
   * the same positions, different content, nothing on screen distinguishing
   * them.
   *
   * Sent on the request AND read back off the response, because those are two
   * different facts: what we asked for, and what we got. They agree today; a
   * client that only ever assumes they do is the one that cannot notice.
   */
  round_number: number;
  items: QueueItem[];
  /** Items ON THIS PAGE. */
  count: number;
  /**
   * The caller's assignments for the whole stage/round — the SAME number as
   * `assigned_to_me`, under the name `/conflicts` already uses for a
   * review-wide denominator (`screening.py:573`).
   *
   * Equal by construction, and declared anyway. The service says so in the
   * route's own docstring table, and a client holding one page that has only
   * `count` is one rename away from rendering `len(items)` as a stage figure —
   * which is precisely the defect the pagination work was done to remove.
   */
  total: number;
  /**
   * The caller's assignments for the whole stage/round — a real count query
   * (`_own_assignment_count`), NOT a page-local number. So it is the same value
   * on every page, and it is the denominator the panel renders.
   */
  assigned_to_me: number;
  /**
   * Decided by the caller ON THIS PAGE. Page-local: the service computes it as
   * `len([i for i in items if i["my_decision"] is not None])` over the page it
   * just built (`screening.py:356`), not over the stage.
   *
   * That asymmetry with `assigned_to_me` is why the panel's "N of M assigned to
   * you" was not merely truncated but INCOHERENT — a page-local numerator over a
   * stage-wide denominator, capped at the page size whatever the reviewer had
   * actually done. Joining every page is what makes the pair comparable.
   */
  decided_by_me: number;
  next_cursor: string | null;
  /**
   * The subject Evidence Review resolved the CALLER to, when it says so.
   *
   * Optional because the service does not return it yet. It is declared now
   * because it is the only trustworthy answer to "who am I acting as": the
   * browser can state the identity it holds, but under `AUTH_BYPASS` — and
   * behind an edge that stamps `X-Subject-Id` — the identity the service
   * actually bound the session to can differ, and the browser cannot see that.
   *
   * Consumed by `ScreeningPanel` as `queue?.acting_subject_id ?? subject`, so
   * the panel prefers the service's answer the day it starts sending one and
   * falls back to the browser's own until then. Nothing depends on it being
   * present, and no spec asserts on it — adding a hard dependency would make
   * this a coordinated change across two services rather than a forward
   * compatibility hook.
   */
  acting_subject_id?: string | null;
}

/** Why a queue traversal stopped before the service ran out of pages. */
export type QueueIncompleteReason =
  /** `QUEUE_MAX_PAGES` requests were made and `next_cursor` was still set. */
  | 'page_cap'
  /** The service handed back a cursor it had already handed back. */
  | 'cursor_not_advancing';

/**
 * Every page of one reviewer's queue, joined — what `getQueue` returns.
 *
 * The only field that is NOT the service's is `incomplete`, and it is the point
 * of the type: a client that pages has to be able to say "this is not all of
 * it", because a silently partial list is precisely the defect that paging was
 * added to fix. `null` means the traversal ran to a null `next_cursor` and this
 * IS the whole queue.
 */
export interface CompleteQueue extends Queue {
  /**
   * CLIENT-SYNTHESIZED, never on the wire. Non-null means the list above is a
   * prefix of the reviewer's queue and the UI must say so.
   */
  incomplete: { reason: QueueIncompleteReason; pages: number } | null;
}

export interface Conflict {
  conflict_id: string;
  review_record_id: string;
  title: string | null;
  unblinded: boolean;
  resolved: boolean;
  /** `"redacted"` until an unblinding is recorded, then the decision list. */
  dispositions: 'redacted' | ConflictDisposition[];
  /**
   * The lead's ruling — a TRI-STATE, and each arm is a different fact.
   *
   *  - an `Adjudication`: a lead ruled, and this is what they ruled and why;
   *  - `"redacted"`: a lead ruled and you may not be told the outcome, because
   *    your own verdict at that position is still outstanding. The service
   *    applies the same predicate it applies to `dispositions`
   *    (`screening.py:1091-1095`) — the field was previously served in full
   *    beside a redacted `dispositions`, which is a blinded door with the
   *    window beside it open;
   *  - `null`: NO lead has ruled. A conflict can also close because the
   *    reviewers came to agree, and calling that "adjudicated" names a lead who
   *    never decided.
   *
   * Collapsing `"redacted"` into `null` is the failure worth naming: it tells a
   * reviewer the disagreement is unsettled when it is settled against them.
   */
  adjudication: Adjudication | 'redacted' | null;
}

export interface FlowCounts {
  identified_total: number;
  quarantined: number;
  rejected: number;
  records_total: number;
  duplicates_removed: number;
  records_screened: number;
  not_yet_screened: number;
  included: number;
  excluded: number;
  uncertain: number;
  exclusion_reasons: Record<string, number>;
  adjudicated: number;
}

/**
 * One stage's own tally — PRISMA's two screening boxes, kept apart.
 *
 * PRISMA 2020 does not report "excluded" as one number. Records dropped at
 * TITLE/ABSTRACT are one box; reports dropped at FULL-TEXT eligibility are a
 * different box, and that one has to be broken down by reason. Merging them is
 * a recognised reporting failure, so `FlowCounts.exclusion_reasons` — which is
 * the merge — cannot answer the question a diagram asks.
 *
 * ## The member names are the contract, and two of them are traps
 *
 * They are named after the MECHANISM ("this record settled at this stage with
 * this disposition"), not after a PRISMA caption, because only two of the five
 * ARE captions:
 *
 *  - `settled_exclude` IS PRISMA's "Reports excluded, with reasons" box, and
 *    `exclusion_reasons` is that breakdown for THIS stage alone;
 *  - `settled_include` is NOT a box at any stage but the last. It means "the
 *    newest ruling on this record is an include recorded here", which at a
 *    non-terminal stage is "passed this stage, the next one has not ruled" — a
 *    review in flight, not a finding. The review's inclusion set is
 *    `counts.included` and only ever that;
 *  - `settled_uncertain` is not a PRISMA arm at all; PRISMA has no "unsure";
 *  - `reached` is "has at least one reviewer decision at this stage", NOT "was
 *    assessed for eligibility": a record with one of two required reviewers is
 *    already in it. It is honest for a FINISHED stage and a ceiling for one
 *    still running.
 *
 * And the arrow between two stages does NOT hold arithmetically:
 * `title-abstract.reached − title-abstract.settled_exclude` need not equal
 * `full-text.reached`, because a record can settle at the abstract as an
 * include and simply never be worked at full text. Anything rendering these
 * has to say so rather than invite the subtraction.
 */
export interface FlowStageCounts {
  stage_key: string;
  stage_order: number;
  name: string;
  reached: number;
  settled_include: number;
  settled_exclude: number;
  settled_uncertain: number;
  exclusion_reasons: Record<string, number>;
}

export interface Flow {
  counts: FlowCounts;
  /**
   * OPTIONAL, and it has to stay optional.
   *
   * Evidence Review serves this beside `counts` (`services/flow.py:569`) —
   * outside the sealed block, so it costs no contract version and moves no
   * `canonical_counts_hash`. But a deployment that predates that change answers
   * without the key at all, and fr is deployed independently of it. A required
   * field here would make every consumer read `undefined` through a type that
   * promised an array, and the studio must degrade to the flat ledger it has
   * always rendered rather than to an empty box.
   */
  counts_by_stage?: FlowStageCounts[];
  canonical_counts_hash: string;
  flow_revision_number: number;
  projection_stale: boolean;
}

export interface InclusionExport {
  export_id: string;
  manifest_hash: string;
  payload_digest: string;
  included_count: number;
  omissions_count: number;
  created_at: string;
  /**
   * True when this seal ALREADY EXISTED and the request added nothing.
   *
   * `POST /exports` used to mint a byte-identical row per click — every member
   * of the manifest is a function of immutable state, and `inclusion_exports`
   * is append-only, so a consumer citing "the inclusion set" of a review was
   * handed several indistinguishable seals and had to guess. Evidence Review
   * now keys on `manifest_hash` and replays instead
   * (`application/services/flow.py:1002-1013`), the same shape
   * `sealCorpus`, `importCorpus` and `runDeduplication` already have.
   *
   * Optional because a read never replays anything and an older service does
   * not send it at all. Absent is NOT `false` in the sense that matters: the
   * panel renders a replay notice only on an explicit `true`, so a service that
   * stops emitting the key degrades to saying nothing rather than to claiming a
   * fresh seal.
   */
  replayed?: boolean;
}

/**
 * ONE RECORD INSIDE A SEALED INCLUSION SET (`services/flow.py:844-856`).
 *
 * These eight fields are the export. Everything else on this surface — the
 * counts, the manifest hash, the verify outcome — is a statement ABOUT them,
 * and until `getExport` existed they were the only part a reader could not see.
 */
export interface ExportIncludedRecord {
  review_record_id: string;
  /** The exact version sealed — not the review's tail. */
  review_record_version_id: string;
  content_hash: string;
  record_type: string | null;
  title: string | null;
  publication_year: number | null;
  doi: string | null;
  pmid: string | null;
}

/**
 * A record, or an import row, that the seal LEFT OUT — and the two do not share
 * a key.
 *
 * `ER-009.3` requires every omission to be explicit, and Evidence Review builds
 * the list from two different populations (`flow.py:861-887`):
 *
 *  - a screened record that did not reach `included`, keyed by
 *    `review_record_id` and carrying its bucket, its exclusion reason and
 *    whether a lead adjudicated it;
 *  - a QUARANTINED IMPORT ROW, which never became a review record at all, keyed
 *    by `import_row_id` and carrying `quarantine_reason` instead.
 *
 * A union rather than one widened object, because a renderer that assumes the
 * first shape silently drops every row of the second — and the quarantined ones
 * are precisely the omissions a reader has no other way to learn about.
 */
export type ExportOmission =
  | {
      review_record_id: string;
      bucket: string;
      exclusion_reason_code: string | null;
      adjudicated: boolean;
    }
  | {
      import_row_id: string;
      bucket: 'quarantined';
      quarantine_reason: string | null;
    };

/** True for the record arm of `ExportOmission`, false for a quarantined row. */
export const isRecordOmission = (
  o: ExportOmission,
): o is Extract<ExportOmission, { review_record_id: string }> => 'review_record_id' in o;

/**
 * ONE export, with the sealed envelope attached — what `GET /exports/{id}`
 * returns.
 *
 * `payload` is OPTIONAL and that is not defensive decoration: the route takes
 * `with_payload` (default `True`, `api/routers/exports.py:89`) and an older
 * service does not carry the member at all. Reading `payload.included` off a
 * response that has none is a TypeError that blanks the whole stage — the same
 * failure `flow.counts` already had to be guarded for.
 *
 * The envelope is NESTED, and that is the thing to get right: `included` and
 * `manifest` live under `payload` (`flow.py:963-967`), not at the top level.
 * `omissions` is served in BOTH places; the nested copy is the sealed one and
 * is the one to read, because it is inside the bytes `payload_digest` covers.
 */
export interface InclusionExportDetail extends InclusionExport {
  payload?: {
    /**
     * The envelope: which review, which locked protocol, which sealed corpus,
     * the counts, and — since `:2` — `items_hash` over the arrays below.
     * Left as an open record because this client renders a handful of members
     * and must not claim to know the schema's shape.
     */
    manifest: Record<string, unknown>;
    included: ExportIncludedRecord[];
    omissions: ExportOmission[];
  };
  /** The same list, unsealed, beside the payload. Prefer `payload.omissions`. */
  omissions?: ExportOmission[];
  corpus_version_id?: string;
  schema_ref?: string;
  sealed_with?: string;
  created_by_subject_id?: string | null;
}

/**
 * One reviewer's decision on a conflicted record, as `blinded_reads.to_public()`
 * sends it (`application/services/blinded_reads.py:143-158`).
 *
 * Declared because the elements were RENDERED NOWHERE. `dispositions` was typed
 * `Array<Record<string, unknown>>` and the panel read only `.length` from it, so
 * an unblinding — the deliberate, recorded act of lifting two reviewers'
 * blinding — told the lead that two decisions existed and never what either one
 * said. The service had been returning both in full the whole time.
 */
export interface ConflictDisposition {
  decision_id: string;
  disposition: string;
  exclusion_reason_code: string | null;
  rationale: string | null;
  decided_at: string | null;
  /**
   * Absent unless the caller is a lead reading a conflict they do not owe a
   * decision on (`blinded_reads.py:156-157`). Optional rather than nullable
   * because "the service did not attribute this" and "the service attributed it
   * to nobody" are different facts, and only the first one happens here.
   */
  reviewer_subject_id?: string | null;
}

/**
 * A lead's ruling on a conflict, as `_adjudication_summary` sends it
 * (`application/services/screening.py:1295`).
 *
 * Declared because it is now RENDERED. `Conflict.adjudication` was typed
 * `Record<string, unknown> | null` and read in zero places, so the grounds a
 * lead states — permanently, attributably, for settling a disagreement between
 * two reviewers — were never shown again anywhere in the product.
 */
export interface Adjudication {
  adjudication_id: string;
  conflict_id: string;
  disposition: string;
  exclusion_reason_code: string | null;
  rationale: string | null;
  adjudicator_subject_id: string | null;
  /**
   * The adjudicator's name, when the service could derive one from the token
   * that recorded the ruling.
   *
   * Null on every row written before the column existed, and those rows can
   * never be backfilled — `screening_adjudications` is append-only
   * (`alembic 0005:258` refuses every UPDATE). So the renderer falls back to
   * `adjudicator_subject_id`, which stays the evidentiary attribution; this is
   * only a label on top of it.
   */
  adjudicator_display_name?: string | null;
  supersedes_adjudication_id?: string | null;
  decided_at?: string | null;
}

export interface DuplicateCluster {
  cluster_id: string;
  member_count: number;
  members: Array<{
    review_record_id: string;
    title: string | null;
    doi: string | null;
    normalized_doi: string | null;
    publication_year: number | null;
  }>;
  current_resolution: { resolution_type: string; rationale: string } | null;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const listReviews = () => request<{ items: Review[]; count: number }>('');

export const createReview = (body: { project_id: string; external_key: string; title: string }) =>
  request<Review>('', json(body));

export const createProtocol = (
  id: string,
  body: {
    inclusion_criteria: Record<string, unknown>;
    exclusion_criteria: Record<string, unknown>;
    stage_definitions: Array<Record<string, unknown>>;
    exclusion_reason_vocabulary: string[];
    reviewers_required: number;
  },
) => request<ProtocolVersion>(`/${id}/protocol-versions`, json(body));

export const lockProtocol = (id: string, pv: string) =>
  request<ProtocolVersion>(`/${id}/protocol-versions/${pv}:lock`, {
    method: 'POST',
  });

export const activateReview = (
  id: string,
  body: {
    protocol_version_id: string;
    rationale: string;
    expected_revision?: number;
  },
) => request<Review>(`/${id}:activate`, json(body));

export const importCorpus = (id: string, sourceKind: string, payload: string) =>
  request<ImportBatch>(`/${id}/imports?source_kind=${encodeURIComponent(sourceKind)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: payload,
  });

/**
 * Ask Evidence Review to fetch a frozen discovery batch and import it.
 *
 * The records do not travel through this browser, and that is the point.
 * `importCorpus` posts a document this tab BUILT — `JSON.stringify` over
 * objects reshaped from a session snapshot — so the digest that anchors the
 * corpus manifest and the PRISMA counts described a construction that happened
 * outside the trust boundary.
 *
 * Forwarding the engine's bytes verbatim instead is not possible from here:
 * `HttpClient` exposes only `json<T>()`, so every hop is parse-then-reserialise
 * — an equal object, never equal bytes. And this browser cannot check the
 * digest itself: there is no RFC 8785 canonicaliser in the frontend and
 * `research_contracts`' TypeScript package is not published to the private registry.
 *
 * So we send the receipt, not the payload. `expected_digest` is what the engine
 * said the batch hashes to; Evidence Review fetches the batch, hashes what it
 * receives, and refuses `422 upstream_digest_mismatch` unless the two agree.
 */
export const importDiscoveryBatch = (
  id: string,
  body: { session_id: string; batch_id: string; expected_digest: string },
) => request<ImportBatch>(`/${id}/imports/from-discovery`, json(body));

export const sealCorpus = (id: string) =>
  request<CorpusVersion>(`/${id}/corpus-versions`, { method: 'POST' });

/**
 * The corpus versions already sealed for this review.
 *
 * The read half of `sealCorpus`, and it was missing. The studio learned its
 * corpus only from the POST it had just issued, so anyone arriving at a review
 * they did not seal themselves — a second reviewer, or the same lead after the
 * stepper unmounted the stage — had no corpus and no way to obtain one except
 * to seal again. That is a write standing in for a read, and it does not merely
 * cost a request: it mints a NEW version out of whatever Discover happens to be
 * holding, silently changing what the review is screened against.
 */
export const listCorpusVersions = (id: string) =>
  request<{ items: CorpusVersion[]; count: number }>(`/${id}/corpus-versions`);

export const listStages = (id: string) => request<{ items: Stage[] }>(`/${id}/stages`);

export const runDeduplication = (id: string) =>
  request<{
    dedup_run_id: string;
    cluster_count: number;
    pair_count: number;
    input_digest: string;
  }>(`/${id}/deduplication-runs`, json({}));

/**
 * Whether deduplication has ever run for this review, and with what result.
 *
 * `listClusters` is deliberately NOT the way to ask. It answers "this review
 * has no deduplication run" with a 404, so probing with it puts a failed
 * request on the reviews surface for every review that has not been deduped —
 * which the browser lanes' acceptance gate reads, correctly, as a defect. This
 * one is a plain 200 with a count.
 */
export const listDeduplicationRuns = (id: string) =>
  request<{
    items: Array<{
      dedup_run_id: string;
      corpus_version_id: string;
      input_digest: string;
      cluster_count: number;
      pair_count: number;
    }>;
    count: number;
  }>(`/${id}/deduplication-runs`);

/**
 * The duplicate clusters a deduplication run proposed.
 *
 * `dedupRunId` is not optional decoration — it is the difference between an
 * answer about THIS corpus and an answer about a superseded one. Asked without
 * it, the service resolves the MOST RECENT run for the review whatever corpus it
 * was computed over (`evidence_review_service/src/api/routers/screening.py:121-130`:
 * `order_by(created_at.desc()).limit(1)`), and 404s when there is no run at all.
 *
 * So a review whose corpus was re-sealed answers with the old corpus's clusters,
 * and the studio renders that as a fact about the new one. Callers that hold a
 * corpus version must name the run computed against it; `listDeduplicationRuns`
 * returns each run's `corpus_version_id` for exactly that purpose.
 *
 * The response echoes `dedup_run_id`, so the caller can confirm which run it got.
 */
export const listClusters = (id: string, dedupRunId?: string) =>
  request<{ dedup_run_id: string; items: DuplicateCluster[]; count: number }>(
    `/${id}/duplicate-clusters${dedupRunId ? `?dedup_run_id=${encodeURIComponent(dedupRunId)}` : ''}`,
  );

export const resolveCluster = (
  id: string,
  clusterId: string,
  body: {
    resolution_type: string;
    rationale: string;
    survivor_record_id?: string;
  },
) => request<Record<string, unknown>>(`/${id}/duplicate-clusters/${clusterId}:resolve`, json(body));

/**
 * Assign reviewers to a stage — FOR A ROUND, and the round is the whole story.
 *
 * `round_number` was not sent and not declared, so every assignment this studio
 * ever made landed in round 1. That is harmless exactly once. A review whose
 * corpus is re-sealed — which the studio has its own armed control for — then
 * meets `409 state_conflict`: round 1 already holds v1's assignments, they are
 * append-only, and the round cannot be re-pointed
 * (`services/screening.py:310-323`). The remedy the service names is a NEW
 * round, and the client could neither ask for one nor read the number back.
 *
 * The response is typed in full for the same reason. It carries three facts the
 * old two-field type threw away:
 *
 *  - `round_number` and `corpus_version_id` — WHAT THE ROUND HOLDS, read back
 *    out of `screening_assignments` rather than echoed from the request
 *    (`screening.py:406`). This is the only place the studio can learn which
 *    corpus its queue is actually serving: the queue body names no corpus.
 *  - `assignments_existing` — what the round held BEFORE the call. Without it
 *    `assignments_created: 0` cannot distinguish "every row was already there"
 *    from "the insert never ran", and the second is what a re-point looked like
 *    before the service started refusing it.
 */
export const createAssignments = (
  id: string,
  body: { stage_id: string; round_number?: number; reviewer_subject_ids: string[] },
) =>
  request<{
    review_id: string;
    stage_id: string;
    round_number: number;
    corpus_version_id: string;
    reviewers: string[];
    records: number;
    assignments_existing: number;
    assignments_created: number;
  }>(`/${id}/assignments`, json(body));

/**
 * Assignments asked for per request.
 *
 * The service's own maximum (`limit: ge=1, le=200`,
 * `evidence_review_service/src/api/routers/screening.py:229`). Nothing here
 * sent a limit at all before, so every caller silently took the default of 50 —
 * and since nothing read `next_cursor` either, 50 was also the ceiling on what
 * a reviewer could ever see. Asking for the maximum is what keeps a real queue
 * to one or two round trips rather than to `assigned_to_me / 50` of them, and
 * the service builds a page with two batched reads regardless of its size
 * (`screening.py:296`), so the larger page is not a larger cost per record.
 */
export const QUEUE_PAGE_LIMIT = 200;

/**
 * How many pages `collectQueue` will fetch before it stops and SAYS it stopped.
 *
 * A `while (cursor)` over a value the server chooses is a hang waiting for a
 * server bug, so the traversal is bounded. The bound has to be chosen against
 * two things at once:
 *
 *  - **What it must never cut.** 25 x 200 = 5,000 assignments for ONE reviewer
 *    in ONE stage/round. A title/abstract stage of a large systematic review
 *    runs to a few thousand records total, split across reviewers; the dogfood
 *    corpus that exposed this defect is 46. 5,000 is an order of magnitude
 *    above the realistic worst case, so hitting the cap means something is
 *    wrong, not that somebody was thorough.
 *  - **What it costs to hit.** The pages are sequential — each cursor comes out
 *    of the previous response — so this is also the ceiling on how long the
 *    panel sits mid-load: 25 round trips, a few seconds against the deployed
 *    service, well inside fr's 30s header budget per request.
 *
 * Hitting it is NOT swallowed. `incomplete` is set, and `ScreeningPanel`
 * renders it — a partial list presented as complete is the exact defect this
 * pagination exists to remove, and reintroducing it at page 26 would be no
 * better than reintroducing it at page 2.
 */
export const QUEUE_MAX_PAGES = 25;

/**
 * Join every page a queue reader hands back, bounded and honest about stopping.
 *
 * Takes the page fetcher rather than building requests itself so the two
 * failure modes below can be driven without a network: they are the reason the
 * loop is not three lines.
 *
 *  - **The cursor stops advancing.** A server that returns the same
 *    `next_cursor` twice — a projection bug, a proxy replaying a cached page —
 *    makes a naive loop spin forever, hammering the service from inside a
 *    reviewer's browser. Every cursor issued is remembered, so a repeat is
 *    caught whatever the cycle length, and the traversal ends as INCOMPLETE
 *    rather than as an infinite one or a silently-fine one.
 *  - **Duplicate assignments across pages.** The same non-advancing class of
 *    bug can serve overlapping pages. `ScreeningPanel` keys its `{#each}` on
 *    `assignment_id`, and Svelte throws on a duplicate key — an upstream
 *    paging glitch would take the whole stage down. Deduping is one `Set`.
 *
 * `decided_by_me` is recomputed over the JOINED list rather than summed,
 * because the summands describe pages that may overlap. The formula is the
 * service's own (`screening.py:356`) applied to the list it would have applied
 * it to had it sent one page; `assigned_to_me` is taken from the first response
 * because it is already a stage-wide count and is identical on every page.
 *
 * `next_cursor` on the result is the cursor left UNCONSUMED: null exactly when
 * the queue is complete, and otherwise the point a resumption would start from.
 * The `etag` is the first page's, and describes that page alone — the queue is
 * not a lifecycle read and nothing sends it back as `expected_revision`.
 */
export async function collectQueue(
  fetchPage: (cursor: string | null) => Promise<ReviewResponse<Queue>>,
): Promise<ReviewResponse<CompleteQueue>> {
  const items: QueueItem[] = [];
  const seenAssignments = new Set<string>();
  const seenCursors = new Set<string>();

  let cursor: string | null = null;
  let pages = 0;
  let first: Queue | null = null;
  let etag: string | null = null;
  let incomplete: CompleteQueue['incomplete'] = null;

  while (pages < QUEUE_MAX_PAGES) {
    const page: ReviewResponse<Queue> = await fetchPage(cursor);
    pages += 1;
    if (!first) {
      first = page.data;
      etag = page.etag;
    }

    for (const item of page.data?.items ?? []) {
      if (seenAssignments.has(item.assignment_id)) continue;
      seenAssignments.add(item.assignment_id);
      items.push(item);
    }

    const next = page.data?.next_cursor ?? null;
    if (!next) {
      cursor = null;
      break;
    }
    if (seenCursors.has(next)) {
      // The service is not making progress. Stopping here is the whole point:
      // spinning would be a browser-side retry storm, and pretending the list
      // is complete would be the original defect with extra steps.
      cursor = next;
      incomplete = { reason: 'cursor_not_advancing', pages };
      break;
    }
    seenCursors.add(next);
    cursor = next;
  }

  // The loop can also fall out of the `while` with a live cursor in hand — that
  // is the cap, and it is a different statement from "the cursor was stuck".
  if (cursor && !incomplete) incomplete = { reason: 'page_cap', pages };

  return {
    data: {
      // Carries forward whatever else the first page said — `acting_subject_id`
      // today, anything the service adds tomorrow. Every field this client
      // actually derives is restated below it.
      ...(first ?? {}),
      items,
      count: items.length,
      // From the FIRST page and restated rather than left to the spread: both
      // are stage-scoped, identical on every page, and required members of the
      // type — a spread of a possibly-null response cannot satisfy that on its
      // own, and a silent `undefined` here would render as a blank round.
      round_number: first?.round_number ?? 1,
      total: first?.total ?? items.length,
      assigned_to_me: first?.assigned_to_me ?? 0,
      decided_by_me: items.filter((i) => i.my_decision !== null).length,
      next_cursor: cursor,
      incomplete,
    },
    etag,
  };
}

/**
 * The caller's whole screening queue for a stage — every page of it.
 *
 * This used to be a single un-limited request whose `next_cursor` nobody read,
 * so it returned the service's default page of 50 and stopped. Both call sites
 * in `ScreeningPanel` rendered that as "your queue".
 */
export const getQueue = (id: string, stageId: string, roundNumber = 1) =>
  collectQueue((cursor) =>
    request<Queue>(
      `/${id}/screening/queue?stage_id=${encodeURIComponent(stageId)}` +
        // STATED, never inherited. The service defaults this to 1
        // (`api/routers/screening.py:309`), which is exactly why it was missing
        // for as long as it was: every call worked, and the studio had no round
        // it could name, change or render. The same argument as `limit` above —
        // a value the server picks for you is a value you cannot reason about.
        `&round_number=${roundNumber}` +
        `&limit=${QUEUE_PAGE_LIMIT}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
    ),
  );

export const recordDecision = (
  id: string,
  body: {
    stage_id: string;
    /**
     * The round this judgement belongs to — see `Queue.round_number`.
     *
     * Not decoration: the service resolves the reviewer's assignment by
     * `(stage, round, record, reviewer)` and reads the record's text through
     * THAT assignment's corpus. A decision filed against round 1 while the
     * queue served round 2 is a judgement recorded at a position the reviewer
     * was never assigned, on content they were never shown.
     */
    round_number?: number;
    review_record_id: string;
    disposition: string;
    exclusion_reason_code?: string;
    rationale?: string;
    /**
     * The caller's CURRENT decision on this record, when this one corrects it.
     *
     * Declared here all along and sent by nobody. Evidence Review refuses a
     * second decision at the same position with `409` carrying
     * `current_decision_id`, and refuses a supersede that names anything other
     * than the caller's current decision (`services/screening.py:690-698`) —
     * so this is the only route back from a mis-click, and the studio rendered
     * no control that could reach it.
     */
    supersedes_decision_id?: string;
  },
) => request<Record<string, unknown>>(`/${id}/decisions`, json(body));

/**
 * The lead's conflict list.
 *
 * `count` and `open` describe THE PAGE. `total` / `total_open` describe the
 * review, and `has_more` says the page was cut — all three were added
 * server-side (`ER` #21) precisely because a full page is indistinguishable
 * from a complete list, and reading `open` as "nothing left to adjudicate"
 * while `POST /exports` refuses with unresolved conflicts is the failure that
 * produced them. Dropping them here would leave the panel saying exactly what
 * it said before.
 */
export const listConflicts = (id: string, limit?: number) =>
  request<{
    items: Conflict[];
    count: number;
    open: number;
    has_more?: boolean;
    total?: number;
    total_open?: number;
  }>(`/${id}/conflicts${limit ? `?limit=${limit}` : ''}`);

/**
 * Record an unblinding, naming WHO the disclosure is for.
 *
 * `discloseTo` is not metadata about the decision — the server's RLS policy
 * reads it, so it IS the decision. Omitting it discloses to the acting lead
 * alone, which is the fail-closed default: before `ER-M008` one unblinding
 * opened both dispositions to every reviewer in the tenant, including a third
 * reviewer still pending on the same record.
 *
 * The lead is always in the audience server-side; sending them is harmless and
 * this call does not bother.
 */
export const unblindConflict = (id: string, conflictId: string, reason: string, discloseTo: string[] = []) =>
  request<Record<string, unknown>>(
    `/${id}/conflicts/${conflictId}:unblind`,
    json(discloseTo.length ? { reason, disclose_to: discloseTo } : { reason }),
  );

export const adjudicate = (
  id: string,
  conflictId: string,
  body: {
    disposition: string;
    rationale: string;
    exclusion_reason_code?: string;
  },
) => request<Record<string, unknown>>(`/${id}/conflicts/${conflictId}:resolve`, json(body));

export const getFlow = (id: string) => request<Flow>(`/${id}/flow`);

export const rebuildFlow = (id: string) =>
  request<Flow & { matches_previous_projection: boolean }>(`/${id}/flow:rebuild`, {
    method: 'POST',
  });

export const createExport = (id: string) =>
  request<InclusionExport>(`/${id}/exports`, { method: 'POST' });

/**
 * The inclusion exports this review has already sealed.
 *
 * The read half of `createExport`, and it was missing entirely — this client
 * had a WRITE and a verifier and no way whatsoever to ask whether a seal
 * existed. `ScreeningPanel` therefore held the seal in a component-local
 * `$state`, and `ResearchStepper` renders only the active step, so stepping
 * away from Screening destroyed the panel and with it the one artefact the
 * stage exists to produce. `refresh()` restored the stages, the conflicts, the
 * corpus versions, the deduplication runs and the queue; the export it could
 * not restore, because there was nothing to call.
 *
 * What was left on screen was `POST /exports` — a write standing in for a read,
 * in an append-only table. Before the service learned to replay
 * (`flow.py:1002-1013`) that click minted a second byte-identical seal; it no
 * longer does, but "click the button that seals evidence to find out whether
 * evidence was sealed" is the wrong shape however benign the server is.
 *
 * Ordered by `created_at` server-side (`api/routers/exports.py:53-65`). The
 * caller still picks the newest by VALUE rather than by position — an ordering
 * this client cannot enforce must not be the thing that decides which seal a
 * lead is shown.
 *
 * Lead-only, like every export route including the reads, and that is
 * deliberate rather than an oversight to route around: the EXISTENCE of an
 * export is progress information, so a reviewer who watches one appear learns
 * the other reviewer has finished. A `403` here is the service working and the
 * caller must branch on it rather than report a fault.
 *
 * `getExport` now sits beside this. The argument that used to stand here — "no
 * read, because nothing on this surface renders a payload" — was circular, and
 * the circle was the defect: no read because no render, no render because no
 * read. What the studio showed of the artefact this entire stage exists to
 * produce was two integers and a 23-character hash prefix.
 */
export const listExports = (id: string) =>
  request<{ items: InclusionExport[]; count: number }>(`/${id}/exports`);

/**
 * ONE export, INCLUDING what it sealed — the read that closes the loop.
 *
 * `listExports` answers "has this review been sealed, and with what hash".
 * This answers "and what is IN it", which is the question a reviewer, an
 * auditor or anyone asked to defend the inclusion set actually has. Evidence
 * Review has served it all along and returns the payload BY DEFAULT
 * (`api/routers/exports.py:85-98`); no `with_payload` parameter is sent here,
 * because the route's default is already the answer we want and pinning a
 * spelling this client does not own buys nothing.
 *
 * Lead-only like every export route, the reads included, and a `403` is the
 * service working rather than a fault — see `listExports` for the whole
 * argument. Callers branch on it; they do not report it.
 */
export const getExport = (id: string, exportId: string) =>
  request<InclusionExportDetail>(`/${id}/exports/${exportId}`);

/**
 * `:verify` answers THREE things, and this type used to claim two.
 *
 * The service is careful about the difference — "this deployment cannot check
 * the seal" is not "this seal did not reproduce" — and says so in `outcome`.
 * `verified` is a TRI-STATE for the same reason: `null` means unverifiable.
 * Typing it `boolean` made `verified ? … : …` look total when it is not, and
 * the studio rendered an unverifiable export with the same words as a tampered
 * one. In a regulated review those two have different remedies: an
 * investigation, versus installing the right contract wheel.
 *
 * `items_match` arrived with `urn:ahtapol:inclusion-set-export:2` and is `null`
 * on an export sealed under `:1`, whose contract has no such member — again a
 * fact about the contract, not evidence of tampering.
 *
 * Branch on `outcome`. The booleans are the evidence it was derived from, kept
 * so a reader can check the work.
 */
export type ExportVerification = {
  outcome: 'verified' | 'tampered' | 'unverifiable';
  verified: boolean | null;
  manifest_matches: boolean | null;
  payload_matches: boolean;
  counts_match: boolean;
  items_match: boolean | null;
  seal_unavailable_reason: string | null;
};

export const verifyExport = (id: string, exportId: string) =>
  request<ExportVerification>(`/${id}/exports/${exportId}:verify`);

/**
 * The rows an import DROPPED, with their original bytes and the reason.
 *
 * The service's own docstring states why the route exists
 * (`api/routers/imports.py:566-567`): "`ER-009.3` — an omission must be
 * explicit. A quarantine count with no way to see what was quarantined presents
 * a filtered corpus as a complete one." This client shipped the call and the
 * studio never made it — the count rendered in two places and the rows in none,
 * which is the exact state that docstring describes.
 *
 * `raw_representation` is declared because it is the only thing that IDENTIFIES
 * a quarantined row. It never became a review record, so it has no title, no
 * DOI and no version — the original bytes are all there is, and a list of
 * opaque uuids beside a reason is a count with extra steps.
 *
 * Not lead-gated: the route calls `load_review` and nothing else
 * (`imports.py:571`). A quarantined row is a fact about the CORPUS, not about
 * anybody's screening progress, so a reviewer may see what was left out of the
 * set they are screening.
 */
export const listQuarantine = (id: string) =>
  request<{
    items: Array<{
      import_row_id: string;
      import_batch_id?: string;
      /** Position in the submitted document — how a reader finds it again. */
      row_index?: number;
      quarantine_reason: string | null;
      /** The row as it arrived. Shape is the source's, so it stays opaque. */
      raw_representation?: unknown;
    }>;
    count: number;
  }>(`/${id}/quarantine`);
