<script lang="ts">
  /**
   * Screening — the decision layer, between Discover and Appraise.
   *
   * Everything Discover produces is a *candidate*. This stage is where a locked
   * protocol, two blinded reviewers, an attributable adjudication and a sealed
   * export turn candidates into an inclusion set somebody can defend.
   *
   * Three things the UI must not do, all of them blinding requirements
   * (`ER-004.2`):
   *
   *  - never show one reviewer another reviewer's disposition, or their
   *    progress — "1 of 2 screened" is a decision leak, so the queue renders
   *    only `assigned_to_me` / `decided_by_me`;
   *  - never present a conflict's dispositions before an unblinding is
   *    recorded — the API returns the literal string `"redacted"` and this
   *    renders it as such, rather than as an empty list, so "you may not see
   *    this" stays distinguishable from "there is nothing here";
   *  - never show the PRISMA counts to a reviewer. The API refuses them with a
   *    403, and this renders that refusal as an explanation rather than an
   *    error.
   */
  import {
    activateReview,
    adjudicate,
    createAssignments,
    createExport,
    createProtocol,
    createReview,
    getExport,
    getFlow,
    getQueue,
    importCorpus,
    importDiscoveryBatch,
    listClusters,
    listConflicts,
    listCorpusVersions,
    listDeduplicationRuns,
    listExports,
    listQuarantine,
    listReviews,
    listStages,
    lockProtocol,
    rebuildFlow,
    recordDecision,
    resolveCluster,
    runDeduplication,
    sealCorpus,
    verifyExport,
    ReviewError,
    isRecordOmission,
    type CompleteQueue,
    type Conflict,
    type CorpusVersion,
    type DuplicateCluster,
    type Adjudication,
    type ExportVerification,
    type Flow,
    type FlowStageCounts,
    type ImportBatch,
    type InclusionExport,
    type InclusionExportDetail,
    type ProtocolVersion,
    type Review,
    type Stage,
  } from '$lib/api/reviews';
  import { researchApi, type ReviewExportBatch } from '$lib/api/research';
  import type {
    CandidateProvenance,
    ScreeningRecord,
  } from '$lib/research/screening-records';
  import { fmtDate } from '$lib/manifests/_fmt';
  import { auth } from '$lib/stores/auth.svelte';
  import QueueRecord from './QueueRecord.svelte';
  import PrismaFlowDiagram from './PrismaFlowDiagram.svelte';

  interface Props {
    /**
     * The records this panel will import as canonical JSON.
     *
     * `ScreeningRecord`, not `Record<string, unknown>`: Evidence Review refuses
     * a body carrying a guarded regulatory discriminator at any depth, so the
     * closed type has to survive all the way to `JSON.stringify` — a widened
     * prop here would let an upstream adapter field through and fail the import
     * with an error nobody could trace back to Discover.
     */
    papers?: ScreeningRecord[];
    /**
     * Where `papers` came from. Optional: when it is absent the panel makes no
     * provenance claim at all, which is how the mocked lanes and unit tests
     * drive this component with a bare `papers` array and no session.
     */
    provenance?: CandidateProvenance;
    /**
     * The Discover session these candidates came from.
     *
     * Present in production. When it is set, the import goes through the
     * frozen-batch seam — the engine freezes, Evidence Review fetches — and no
     * record travels through this browser. When it is absent (the mocked lanes,
     * the unit tests, a studio state where Discover never made a session) the
     * panel falls back to posting the records it holds, and SAYS so on the card.
     */
    sessionId?: string | null;
    /** Reviewer subject to act as. In production this is the signed-in user. */
    subject?: string;
  }

  const {
    papers = [],
    provenance = undefined,
    sessionId = null,
    subject = '',
  }: Props = $props();

  let reviews = $state<Review[]>([]);
  let review = $state<Review | null>(null);
  let protocol = $state<ProtocolVersion | null>(null);
  let stages = $state<Stage[]>([]);
  let corpus = $state<CorpusVersion | null>(null);
  /**
   * Every sealed version, not just the newest.
   *
   * Kept so the Duplicates card can NAME the version a stale comparison was
   * made against instead of inferring it. `corpus` is still the one the review
   * is currently screened against and everything else keys off that.
   */
  let corpusVersions = $state<CorpusVersion[]>([]);
  /**
   * Whether the panel actually KNOWS what `corpus` is.
   *
   * Three states, because "this review has no corpus" and "I could not find out
   * whether this review has a corpus" are different facts that a bare
   * `CorpusVersion | null` cannot tell apart — and conflating them is a live
   * hazard, not a tidiness point. The re-seal guard is keyed on `corpus`, so a
   * 500 or a 403 on the READ used to leave `corpus` null, which silently
   * removed the guard: the arm checkbox was not rendered, the import button
   * fell back to its enabled first-run form, and one stray click sealed a new
   * version over a corpus that was already there. A failed read must never
   * present itself as a first run.
   *
   * `unread` is the pre-refresh state and is treated exactly like `unreadable`
   * by the guard: not knowing is not knowing, whatever the reason.
   */
  let corpusKnowledge = $state<'unread' | 'read' | 'unreadable'>('unread');
  let batch = $state<ImportBatch | null>(null);
  /**
   * The engine's receipt for the frozen batch this import cited, when there was one.
   *
   * Null after a fallback import, and that distinction is rendered rather than
   * kept internal: "the corpus is a batch the engine froze and Evidence Review
   * fetched" and "the corpus is what this browser was holding" are different
   * claims about the same sealed artefact, and only one of them is reproducible.
   */
  let frozenBatch = $state<ReviewExportBatch | null>(null);
  let clusters = $state<DuplicateCluster[]>([]);
  /**
   * Every deduplication run this review has, WITH the corpus each compared.
   *
   * Read back from the server, not set by `dedupe()`. A flag this component
   * owned would return to "no" every time the stepper unmounted the stage,
   * which is precisely the class of amnesia the corpus restore exists to end —
   * and here it would make the panel state an answer nobody had computed.
   *
   * This used to be a bare `dedupRan` boolean, and collapsing the list threw
   * away the one field that makes the answer attributable: `corpus_version_id`.
   * With it gone, the Duplicates card could only ask "has anything ever been
   * compared?", so a review with corpus [v1 (deduped), v2 (never deduped)]
   * reported "No duplicate clusters proposed." beside v2's member count — an
   * answer about v1 presented as an answer about v2. See `runForCorpus`.
   */
  let dedupRuns = $state<
    Array<{
      dedup_run_id: string;
      corpus_version_id: string;
      input_digest: string;
      cluster_count: number;
      pair_count: number;
    }>
  >([]);
  /**
   * WHICH SCREENING PASS this panel is driving — the concept the studio did not
   * have.
   *
   * `grep -rn round_number frontend/src` returned nothing, so every assignment,
   * every queue read and every decision took Evidence Review's default of 1
   * (`api/routers/screening.py:122,146,309`). That is harmless exactly once. A
   * round is a screening pass over ONE sealed corpus version — the binding is
   * stored on every assignment row, `uq_assignment_once` excludes it, and the
   * insert is `ON CONFLICT DO NOTHING`, so a round can never be re-pointed
   * (`services/screening.py:265-323`) — and this panel has its own armed
   * control for sealing a v2.
   *
   * After that re-seal the header shows v2 while the queue keeps serving v1's
   * text, `createAssignments` answers `409`, and `POST /exports` refuses
   * forever with `not_yet_screened > 0` (`flow.py:736`). The review is stranded
   * and nothing on screen could even name the reason.
   *
   * Starts at 1 because that is what every existing review was screened as, and
   * it only ever moves on the SERVER's instruction — see `boundRound`. There is
   * no route that lists a stage's rounds, so this panel must not guess one:
   * proposing round 2 unprompted would strand a review just as thoroughly in
   * the other direction, by assigning nobody to the round that holds the work.
   */
  let roundNumber = $state(1);
  /**
   * The refusal that says which round is FREE, kept so it can be acted on.
   *
   * `create_assignments` answers `409` with `next_round_number` and
   * `bound_corpus_version_ids` (`screening.py:310-323`) — the only place a
   * browser can learn either fact. Rendered as a next action rather than as a
   * red sentence, because the remedy is one click and the alternative is a lead
   * reading a UUID out of an error message.
   */
  let boundRound = $state<{
    round: number;
    next: number;
    corpora: string[];
    detail: string;
  } | null>(null);
  let queue = $state<CompleteQueue | null>(null);
  let conflicts = $state<Conflict[]>([]);
  //: What the server says about the WHOLE review, as opposed to this page.
  //
  //: `conflicts.length` is a page length. Rendering it as if it were the review
  //: is how a lead reads "nothing left to adjudicate" off a truncated list while
  //: `POST /exports` refuses with unresolved conflicts and nothing on screen
  //: explains the contradiction.
  let conflictTotals = $state<{ has_more: boolean; total: number; total_open: number } | null>(null);
  /**
   * Whether this caller is ALLOWED to see conflicts, and whether the read worked.
   *
   * Four states for the same reason `corpusKnowledge` has three: "there are no
   * conflicts", "I may not see them", and "the read broke" are different facts,
   * and folding any two together states something untrue.
   *
   * `forbidden` is a DESIGNED ANSWER, not a failure. `GET /conflicts` is
   * `require_review_lead` in Evidence Review, so a reviewer is refused `403` —
   * correctly. Folded into the generic failure path (as it was) every reviewer
   * saw "Could not read conflicts (…)" on every refresh, an error message about
   * something they were never entitled to read. A live dual drive fired one per
   * reviewer per refresh, all guaranteed to be refused.
   *
   * ## Why the request is made at all, knowing it may be refused
   *
   * The client cannot tell whether it is the lead. Lead authority comes from
   * the creator grant inside Evidence Review; neither this proxy nor the kag
   * gateway forwards `X-Actor-Role`, so every session binds `role='reviewer'`
   * and there is nothing here to branch on. Asking and handling the refusal is
   * therefore the only correct shape — what had to change is that the refusal
   * is an ANSWER, not an error.
   *
   * `unreadable` still means the read broke, and still surfaces. A 500 on this
   * route is a fault and must never be quietly reclassified as "not allowed".
   */
  let conflictsKnowledge = $state<'unread' | 'read' | 'forbidden' | 'unreadable'>('unread');
  let flow = $state<Flow | null>(null);
  /**
   * The newest inclusion export this review has, as the SERVER reports it.
   *
   * This used to be written in exactly one place — inside `seal()` — so it
   * existed only for the person who had just clicked the button, in the tab
   * where they clicked it. `ResearchStepper` renders only the active step
   * (`{#if activeStep}`), so leaving Screening unmounts this panel and destroys
   * every `$state` in it; `refresh()` restored the stages, the conflicts, the
   * corpus versions, the deduplication runs and the queue, and could not
   * restore this one because `reviews.ts` had no read for exports at all.
   *
   * The result was the same class of defect the corpus restore fixed, on the
   * artefact the entire stage exists to produce: a lead who stepped away came
   * back to a review whose seal had vanished, and the only control still on
   * screen was `POST /exports` — a write standing in for a read, against an
   * append-only table.
   */
  let sealedExport = $state<InclusionExport | null>(null);
  /**
   * Whether this panel actually KNOWS whether the review has been sealed.
   *
   * Four states, for the reasons `corpusKnowledge` has three and
   * `conflictsKnowledge` has four. "Nothing has been sealed", "I may not ask"
   * and "the read broke" are three different facts about the most consequential
   * object on this page, and a bare `InclusionExport | null` can hold one of
   * them.
   *
   * `forbidden` is a DESIGNED ANSWER. Every export route is
   * `require_review_lead`, the reads included
   * (`api/routers/exports.py:20-45`), and deliberately so: the EXISTENCE of an
   * export is progress information, because an export can only be taken once
   * every record is screened and every conflict resolved — so a reviewer who
   * watches one appear learns that the other reviewer has finished, which is
   * exactly the inference `ER-004.2` forbids, arriving as a row count instead
   * of a number. Folded into the aggregate failure it would put an error about
   * a resource they were never entitled to read in front of every reviewer on
   * every refresh, and a failed request on the surface the browser lanes'
   * acceptance gate reads.
   */
  let exportsKnowledge = $state<'unread' | 'read' | 'forbidden' | 'unreadable'>('unread');
  /**
   * Whether the LAST seal this panel requested added anything.
   *
   * `POST /exports` on an unchanged review no longer mints a second row: the
   * manifest is a function of immutable state, so Evidence Review keys on
   * `manifest_hash`, finds the existing seal and returns it with
   * `replayed: true` (`application/services/flow.py:1002-1013`). The studio
   * rendered that response exactly as it rendered a fresh one, which is a false
   * claim about an evidence artefact: "you have just sealed this review" when
   * nothing was written.
   *
   * Only ever set from an explicit `=== true`, so a service that stops sending
   * the key degrades to saying nothing rather than to claiming a fresh seal.
   */
  let exportReplayed = $state(false);
  /**
   * The WHOLE verification body, not just `verified`.
   *
   * This held `boolean | null` and rendered `verified ? 'round-trips' :
   * 'unverified'`. The service answers three outcomes and goes to real lengths
   * to keep them apart — `verified` is a tri-state precisely so `null` is
   * neither yes nor no — and that distinction died at the last hop: an export
   * this deployment simply CANNOT check was shown with the same word as one
   * whose seal did not reproduce. "Unverified" reads as an accusation about the
   * evidence; the honest reading of `null` is an accusation about the installed
   * contract wheel, and the two have different remedies.
   *
   * Keeping the body also means `items_match` is available. Under
   * `inclusion-set-export:1` a record could be REWRITTEN IN PLACE and every
   * check still passed; `:2` seals the items, so a failed items check is the
   * one that says "a record was substituted".
   */
  let verification = $state<ExportVerification | null>(null);
  /**
   * Why the verification REQUEST did not complete, when it did not.
   *
   * A third state, kept apart from `verification` for the same reason
   * `corpusKnowledge` is kept apart from `corpus`: "the service says this
   * export cannot be checked" and "I could not ask" are different facts, and
   * folding the second into the first states something untrue about the
   * contract. See `seal`.
   */
  let verificationFailure = $state<string | null>(null);
  /**
   * The sealed inclusion set ITSELF — the records, and every omission.
   *
   * The card rendered two integers and a 23-character hash prefix, and the
   * client had no read at all: `reviews.ts` argued there should be none because
   * nothing rendered a payload, which is the circle this closes. Evidence
   * Review has served `GET /exports/{id}` all along, with the envelope attached
   * BY DEFAULT (`api/routers/exports.py:85-98`).
   *
   * Loaded on demand rather than in `refresh()`. It is the largest response on
   * this surface — every included record, every omission — and a lead arriving
   * at a sealed review usually wants the seal's identity, not its contents.
   */
  let sealedPayload = $state<InclusionExportDetail | null>(null);
  /**
   * Whether the panel KNOWS what the seal contains, in the idiom the rest of
   * this component uses (`corpusKnowledge`, `exportsKnowledge`).
   *
   * `forbidden` is a designed answer — every export route is lead-only — and
   * `unreadable` is a fault. Neither may be rendered as "this seal contains
   * nothing", which is the one statement that would be worse than saying
   * nothing at all.
   */
  let payloadKnowledge = $state<'unread' | 'read' | 'forbidden' | 'unreadable'>('unread');
  /** Whether the reviewer has asked to see the contents. */
  let sealedSetOpen = $state(false);
  /**
   * The import rows this review QUARANTINED, with the bytes they arrived as.
   *
   * `listQuarantine` shipped in this client with zero callers anywhere in the
   * frontend, while the count rendered in two places. Evidence Review built the
   * route for exactly this and says so in its own docstring
   * (`api/routers/imports.py:566-567`): "`ER-009.3` — an omission must be
   * explicit. A quarantine count with no way to see what was quarantined
   * presents a filtered corpus as a complete one."
   *
   * Read in `refresh()` rather than on demand: the route is not lead-gated (it
   * calls `load_review` and nothing else), it is a fact about the CORPUS rather
   * than about anybody's progress, and the count it returns is the only one a
   * re-joining reviewer can get — `batch` exists only for whoever ran the
   * import, and `flow.counts.quarantined` is lead-only.
   */
  let quarantine = $state<
    Array<{
      import_row_id: string;
      import_batch_id?: string;
      row_index?: number;
      quarantine_reason: string | null;
      raw_representation?: unknown;
    }>
  >([]);
  let quarantineKnowledge = $state<'unread' | 'read' | 'unreadable'>('unread');
  /** Whether the reviewer has asked to see the quarantined rows. */
  let quarantineOpen = $state(false);
  /**
   * THIS BROWSER'S copy of the flow ledger is older than the review.
   *
   * Deliberately NOT `Flow.projection_stale`, and the distinction is the whole
   * point of the flag. `projection_stale` is the SERVER's answer to "was my
   * cache behind when I derived this?" — and the ledger is always freshly
   * derived, so a `false` there is true and reassuring and says nothing
   * whatever about whether the numbers on this screen predate the decision the
   * user just recorded. Nothing re-read the ledger after `decide`,
   * `unblindAndAdjudicate` or `seal`, so the one indicator on the card gave
   * exactly the wrong reassurance at exactly the moment it was read.
   *
   * A marker rather than an automatic re-read: `read_flow` is
   * `require_review_lead`, so firing it after every decision would put a 403 in
   * front of every reviewer on every click. Saying the counts are old costs
   * nothing and is true for both callers.
   */
  let flowStale = $state(false);
  /**
   * The review-wide reason histogram, sorted, and ONLY when there is one.
   *
   * `counts.exclusion_reasons` has been on every `GET /flow` response since the
   * ledger existed, is typed in `lib/api/reviews.ts`, and is named in three
   * comments in this file — and it was never rendered anywhere. So a lead
   * reading "Excluded 3" had no route, anywhere in this product, to the reason
   * any of those three records was excluded, while the panel below was
   * simultaneously making reviewers pick a reason from a locked vocabulary on
   * every single exclusion. The field was fetched, discarded, and the work that
   * produced it was invisible.
   *
   * Sorted by descending count and then by code so the order is a fact about
   * the review rather than about JSON key order, and EMPTY means empty: a
   * review that has excluded nothing renders no heading and no list, not a
   * caption over a blank.
   */
  const flowReasons = $derived(
    Object.entries(flow?.counts?.exclusion_reasons ?? {}).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    ),
  );
  /**
   * The per-stage split, in `stage_order` — PRISMA's two screening boxes.
   *
   * ## Why this cannot be derived from what was already here
   *
   * PRISMA 2020 requires records excluded at TITLE/ABSTRACT to be reported
   * separately from reports excluded at FULL-TEXT eligibility, and the
   * full-text box broken down by reason. `counts` merges them into one
   * `excluded` and one `exclusion_reasons`, and nothing else on the response
   * carried the stage — so for a two-stage review the split was not
   * recoverable by any consumer, which is why Evidence Review now serves
   * `counts_by_stage` beside `counts` rather than inside it.
   *
   * ## Sorted here, not trusted from the wire
   *
   * The service sorts on `(stage_order, stage_key)` and this repeats it. Not
   * defensive tidiness: the whole point of the block is that a reader
   * transcribes it into a diagram top to bottom, and a stage list rendered in
   * array order would silently print the full-text screen above the abstract
   * screen and reverse the review. `stage_key` breaks a tie in `stage_order`,
   * which the schema permits.
   *
   * ## Absent is not empty
   *
   * `?? []` and not `?? [{…}]`: fr deploys independently of Evidence Review, so
   * a response without the key is the NORMAL case until that service ships.
   * An empty array renders nothing at all — the flat ledger, exactly as this
   * panel has always drawn it.
   */
  const flowStages = $derived(
    [...(flow?.counts_by_stage ?? [])].sort(
      (a, b) => a.stage_order - b.stage_order || a.stage_key.localeCompare(b.stage_key),
    ),
  );
  /**
   * One stage's own reasons, sorted the same way the review-wide list is.
   *
   * `?? {}` because this is the field the whole change exists to publish, and a
   * stage that has excluded nothing legitimately omits it.
   */
  function stageReasons(stage: FlowStageCounts): Array<[string, number]> {
    return Object.entries(stage.exclusion_reasons ?? {}).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }
  /**
   * What assigning actually did, kept so it can be shown.
   *
   * The API already counts this and the panel used to discard it, which left
   * the single most consequential write in the stage — who is answerable for
   * which records — indistinguishable on screen from having done nothing.
   */
  let assignment = $state<{
    assignments_created: number;
    records: number;
    /** The round this call landed in — the panel's own `roundNumber`, echoed. */
    round_number: number;
    /**
     * THE CORPUS THE ROUND HOLDS, read back out of `screening_assignments`
     * rather than echoed from the request (`screening.py:406`).
     *
     * This is the only place the studio can learn it: the queue body names no
     * corpus at all. Without it "the queue is serving a superseded corpus" is
     * a state the panel can be in and cannot describe.
     */
    corpus_version_id: string;
    /**
     * What the round held BEFORE this call. `assignments_created: 0` on its own
     * cannot tell "every row was already there" from "the insert never ran".
     */
    assignments_existing: number;
  } | null>(null);
  /**
   * Deliberate consent to supersede a corpus that is already sealed.
   *
   * Not a confirmation dialog and not a framework — one checkbox, rendered only
   * once there is something to overwrite. See the Corpus card for the accident
   * it prevents.
   */
  let resealArmed = $state(false);

  /**
   * The exclusion reason chosen per queue record, keyed by `review_record_id`.
   *
   * A map rather than one shared value: a reviewer works down a list and each
   * record gets its own grounds. One shared select would make the last choice
   * apply to whatever they clicked next, which is a quieter version of the bug
   * this replaces.
   *
   * Unset means "the reviewer has not touched the select", and the first
   * vocabulary entry is what the select renders as its initial value — so the
   * fallback below agrees with what is on screen rather than overriding it.
   */
  let exclusionReason = $state<Record<string, string>>({});
  /**
   * The records whose decision the reviewer has opened for CORRECTION.
   *
   * A mis-click used to be final. The decided arm of the queue rendered a badge
   * and removed the three buttons, so there was no control that could even
   * provoke the `409` which hands back `current_decision_id` — and Evidence
   * Review supports the correction in full, refusing only a supersede that
   * names something other than the caller's current decision
   * (`services/screening.py:690-698`).
   *
   * That is not a convenience. A wrong decision both reviewers happen to share
   * opens no conflict, and one they disagree on leaves the record
   * `not_yet_screened` — which refuses the export permanently
   * (`flow.py:736`). It is the ONLY recovery.
   *
   * Per record and opt-in, so the ordinary read-down-the-list case is unchanged
   * and a decided record still reads as decided until somebody says otherwise.
   */
  let correcting = $state<Record<string, boolean>>({});
  /** The same, per conflict, for the lead's adjudication. */
  let adjudicationReason = $state<Record<string, string>>({});
  /**
   * The GROUNDS the lead states for each adjudication, as typed.
   *
   * Distinct from `adjudicationReason` above, which is the closed-vocabulary
   * exclusion CODE. The code says which protocol criterion the record fell to;
   * this says why the lead decided the disagreement that way, and it is the
   * part a reader of the sealed corpus actually reads. Per conflict, because a
   * lead works down a list and each disagreement has its own reasoning — one
   * shared box would attach the last thing typed to whatever was clicked next.
   */
  let adjudicationRationale = $state<Record<string, string>>({});
  //: WHO a lead is disclosing this conflict to, per conflict, as typed.
  //
  //: The server's RLS policy reads the audience recorded on the unblinding
  //: event, so an empty box is not "no preference" — it discloses to the acting
  //: lead alone. That is the fail-closed default and it is deliberately the
  //: default: before `ER-M008` one unblinding opened both dispositions to every
  //: reviewer in the tenant, including a third reviewer still pending on the
  //: same record, and widening blinding has to be something somebody chose.
  let discloseTo = $state<Record<string, string>>({});

  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let errorCode = $state<string | null>(null);
  let notice = $state<string | null>(null);

  /**
   * The review's title — blank, and REQUIRED.
   *
   * This was `'Shadow smoke review'`: the internal name of this studio's own
   * rehearsal, prefilled into a field most users would never retype, written
   * permanently onto the review record and carried into the provenance of every
   * sealed export taken against it. `title` is `min_length=1` server-side
   * (`api/routers/reviews.py:34`), so blank cannot merely be sent — it is
   * guarded here and on the button, exactly like `projectId`.
   *
   * The same test that decided `projectId`: is there a value that is honest
   * when nobody has said anything? For the name of somebody's systematic
   * review there is not.
   */
  let title = $state('');
  /**
   * The project this review is filed under.
   *
   * This was the literal string `'dogfood'`, compiled in. Every review the
   * studio has ever created — and the first real one any customer created —
   * would have been filed under the internal name of a test programme, in an
   * append-only store, with no control on any screen to change it and no screen
   * showing it.
   *
   * Empty by default and REQUIRED, unlike every other default in this card. The
   * others are true statements the user may improve on; a project identifier
   * cannot be invented on somebody's behalf at all, because there is no value
   * that is honest when nobody has said which project this is.
   */
  let projectId = $state('');
  /**
   * Why this protocol is being locked and activated, as the activation event
   * will record it.
   *
   * Was `'shadow smoke run from the research studio'`, which is not merely
   * canned but FALSE about a real review: it describes this studio's own
   * testing, written into the attributable grounds for locking a protocol.
   *
   * Pre-filled rather than required-and-empty, and that is a deliberate split
   * from `projectId` above. The first protocol version of a brand-new review
   * genuinely has one mechanical reason to be activated, and the default states
   * exactly that and nothing more. An empty box forced in front of every user
   * buys no attributability — it buys a keystroke typed to get past it — whereas
   * a true sentence they can see and overwrite is honest in both cases. The
   * adjudication rationale below is required precisely because the opposite is
   * true there: no accurate default exists for grounds that settle a dispute.
   */
  let activationRationale = $state(
    'Initial protocol version for this review, locked and activated.',
  );
  let reviewerA = $state('');
  let reviewerB = $state('');

  // Fill reviewer A from the signed-in user ONCE, when auth resolves.
  //
  // The screening queue is keyed on the CALLER's subject, so a lead who names
  // anyone else gets an empty queue and no explanation. Making them type their
  // own identifier to see their own work is a dead end for anyone opening this
  // stage for the first time.
  //
  // An `$effect` rather than `$state(auth.user?.id)`: a state initialiser
  // captures its value at component-construction time, and `auth.initialize()`
  // has usually not resolved by then — so that form looks right and silently
  // leaves the field empty.
  //
  // The guard is a PLAIN boolean, not `!reviewerA`. Reading `reviewerA` inside
  // an effect that also writes it makes the effect its own dependency: it
  // re-runs on the write it just performed and spins, which hung the page hard
  // enough that a browser drive sat at this stage until the runner was killed.
  // A non-reactive flag breaks the cycle and says plainly that this runs once.
  //
  // ## Why the prefill STAYS, and what was added instead
  //
  // This prefill proposes the one arrangement that can deadlock the stage.
  // Assignment is lead-only (`screening.py:155`), so whoever drives this form
  // IS the lead; nothing in Evidence Review excludes a lead from being assigned
  // as a reviewer; and if the lead screens and then disagrees with reviewer B,
  // the conflict that opens can never be adjudicated. The trigger
  // `screening_adjudications_separation_of_duty`
  // (`0005_er_m005_screening.py:280-308`) raises `restrict_violation` for ANY
  // adjudicator who recorded a decision in that conflict, and `review-lead` has
  // one holder, so there is no second lead to hand it to. Consensus resolution
  // (`flow.py:1049-1105`) then lets the run limp to a sealed export, so nothing
  // ever blocks — adjudication, the centrepiece of the stage, is simply gone.
  //
  // Three fixes were available. Removing the prefill loses #787: a lead who
  // leaves the stage and returns gets a fresh component, and making them
  // retype their own UUID to see their own queue is the dead end that fix
  // exists to close — an existing browser proof asserts the prefill survives a
  // remount. Refusing the acting subject outright breaks a SUPPORTED
  // configuration: a conflict needs two decisions that differ, so at
  // `reviewers_required: 1` the deadlock is unreachable and a lead screening a
  // small corpus alone is exactly what that setting is for. It would also
  // encode a deployment fact — that this tenant has one lead — as though it
  // were a contract rule, when a tenant with two leads can adjudicate this
  // perfectly well.
  //
  // So the prefill stays and the CONSEQUENCE is named, next to the control,
  // whenever the arrangement is actually reachable (`requiredReviewers > 1`) —
  // the same shape as `corpus-unknown`, `reviewers-missing` and
  // `conflicts-not-visible`. See `actingIsNamedReviewer`.
  let prefilled = false;
  $effect(() => {
    const me = auth.user?.id;
    if (me && !prefilled) {
      prefilled = true;
      reviewerA = me;
    }
  });
  /**
   * WHAT THIS PROTOCOL INCLUDES — blank, and required.
   *
   * This defaulted to `'hospitalised adults; randomised controlled trials'`,
   * which is not a placeholder: it is a false clinical claim about the
   * eligibility of a review, prefilled, for any review that is not an inpatient
   * RCT review. It goes into `inclusion_criteria`, into the protocol's
   * `content_hash`, into a protocol locked the same second, and out through
   * `protocol_content_hash` into every inclusion export
   * (`services/flow.py:928`).
   *
   * Evidence Review will not stop it: `inclusion_criteria` is
   * `dict[str, Any]` (`api/routers/reviews.py:38`), so `{}`,
   * `{"statement": ""}` and `{"statement": "   "}` all return 201 with four
   * DISTINCT permanent hashes. The only place this can be refused is here.
   *
   * ## Why blank-and-required rather than pre-filled
   *
   * The same split this file already makes between `projectId` and
   * `activationRationale`. `exclusionCriteria` below has an honest default
   * available — a protocol that states only inclusion criteria excludes
   * whatever falls outside them — and it is STILL blanked, because #828 moved
   * that literal from a compiled-in constant into a prefilled `$state` and
   * guarded only emptiness: for anybody who does not retype the box, the
   * sentence nobody wrote is still the sentence that gets hashed. Moving a
   * fabricated default from invisible to visible does not stop it being
   * fabricated. For the INCLUSION half no honest default exists at all.
   */
  let criteria = $state('');
  /**
   * What this protocol EXCLUDES — the field that had no control at all.
   *
   * This was the compiled-in literal
   * `exclusion_criteria: { statement: 'anything outside the inclusion statement' }`,
   * written straight into `activateFor` with no `$state`, no binding and no
   * input anywhere on the surface. The "Start a review" form asked for Title,
   * Project, Inclusion criteria, the exclusion REASON vocabulary (a different
   * thing — the closed list of codes a decision may cite) and the counts, and
   * the one remaining half of the protocol's eligibility statement was a
   * constant nobody had ever seen.
   *
   * That is not cosmetic. `exclusion_criteria` is `nullable=False` JSONB, it
   * goes into the protocol's `content_hash`, the protocol is locked forever on
   * activation, and that hash is sealed into every inclusion export as
   * `protocol_content_hash`. So every review this studio has created carries
   * one sentence nobody wrote, permanently, inside a hash-sealed evidence
   * artefact that a reader is meant to be able to defend.
   *
   * ## RETRACTED: it used to be pre-filled, and that was not enough
   *
   * The version above this one shipped the same literal as a prefilled
   * `$state` with an emptiness guard, arguing that the default was true — a
   * protocol stating only inclusion criteria does exclude whatever falls
   * outside them — and that what had been missing was only its visibility.
   *
   * That argument survives contact with exactly the users who read the form.
   * For everyone else the prefill is the compiled-in constant with an extra
   * step: the box is never retyped, the sentence nobody wrote is hashed into a
   * protocol that is locked the same second, and `protocol_content_hash` seals
   * it into every inclusion export. A default that is true of some reviews and
   * asserted of all of them is a fabrication whether or not it is on screen.
   *
   * So it is blank and refused, like `projectId`, `title` and `criteria`. The
   * placeholder still says what a reader would otherwise type; the difference
   * is that a placeholder is not a value and is never hashed.
   */
  let exclusionCriteria = $state('');
  let reasons = $state('wrong_design, wrong_population, not_retrievable');
  /**
   * How many reviewers must decide a record before it counts as screened.
   *
   * Exposed rather than hardcoded to 2. Dual screening is the point of the
   * product, but the protocol permits 1..10 and a single-reviewer review is a
   * legitimate configuration — a scoping review, or one person working through
   * a small corpus. Fixing it at 2 meant such a review could never reach a
   * complete flow: every record stayed `not_yet_screened` forever and the
   * export was refused with no way to proceed.
   */
  let reviewersRequired = $state(2);

  /**
   * How many screening stages the protocol will define.
   *
   * ## Why a second stage matters
   *
   * Title/abstract first, then full text, is the standard PRISMA shape — it is
   * what the flow diagram's two screening boxes ARE. Reviewers read titles and
   * abstracts to throw out what is obviously off-topic cheaply, and only then
   * obtain and read the full papers, where a trial that looked randomised in
   * its abstract turns out not to be. The two stages exist because they cost
   * different amounts and answer different questions, and a review that reports
   * only one of them has not reported a systematic review.
   *
   * This studio could not express that at all. `stage_definitions` was a
   * one-element literal here and every read below was pinned to `stages[0]`, so
   * whatever a lead intended, the product materialised exactly one stage and
   * offered no way to reach a second — the full-text screen, the place most
   * exclusions with a stated reason actually happen, was simply absent from the
   * ledger. Two is the ceiling on purpose: the protocol permits more, but two
   * is what PRISMA describes and what the panel can drive without becoming a
   * stage manager.
   */
  let stageCount = $state(1);

  /**
   * Which stage this panel is currently screening.
   *
   * `stages[0]` was hardcoded in three places — here, the queue read in
   * `refresh()`, and by extension `assign()` and `decide()`, which route
   * through this derived value. A review with two stages therefore had a second
   * stage that existed in the database and was unreachable from the browser.
   */
  let stageIndex = $state(0);

  const stage = $derived(stages[stageIndex] ?? null);
  const canScreen = $derived(!!review && !!stage && (queue?.items.length ?? 0) > 0);

  /**
   * The deduplication run computed against the corpus currently on screen, if
   * one exists.
   *
   * `findLast` rather than `find`: a corpus can be compared more than once (a
   * re-run after a merge is resolved), and the newest run against it is the one
   * whose clusters are current.
   *
   * `null` here has a precise meaning that the old boolean could not express —
   * "this corpus has not been compared" — which is different from "nothing has
   * ever been compared" and different again from "compared, nothing found".
   */
  /**
   * The batch id the SEALED RECORD cites, which is not always the one just taken.
   *
   * `source_ref.review_export_batch_id` is what Evidence Review wrote against
   * this import; `frozenBatch.batch_id` is the receipt this browser was handed a
   * moment ago. They diverge on a replay: re-taking an unchanged session
   * produces byte-identical bytes (discovery-engine #58 removed `taken_at` for
   * exactly this), so `POST review-export` mints a NEW batch id while Evidence
   * Review — keyed on the digest — answers `replayed: true` and returns the
   * FIRST batch's record.
   *
   * The server's record wins, because it is what a reader of the corpus will
   * find. Falling back to the receipt keeps the line renderable if a future
   * service stops emitting the key rather than showing an empty span.
   */
  const citedBatchId = $derived(
    (typeof batch?.source_ref?.review_export_batch_id === 'string'
      ? batch.source_ref.review_export_batch_id
      : null) ?? frozenBatch?.batch_id,
  );

  /** The receipt just taken is not the one the record cites — i.e. a replay. */
  const replayedAnEarlierTaking = $derived(
    !!frozenBatch && !!citedBatchId && citedBatchId !== frozenBatch.batch_id,
  );

  const runForCorpus = $derived(
    corpus
      ? (dedupRuns.findLast((r) => r.corpus_version_id === corpus!.corpus_version_id) ?? null)
      : null,
  );

  /**
   * True when the engine HAS compared something, but not this corpus.
   *
   * The re-seal case, and the only one that needs its own sentence on screen:
   * there are clusters in the database, they are about a corpus that has been
   * superseded, and neither "no duplicates" nor a cluster list is a true thing
   * to render over the current membership.
   */
  const dedupIsStale = $derived(!!corpus && dedupRuns.length > 0 && runForCorpus === null);

  /**
   * The version number of the corpus the newest run DID compare, or `null`.
   *
   * Looked up in the version list rather than inferred as "current minus one":
   * a review can be re-sealed twice between comparisons, and a number this
   * panel arrived at by arithmetic would be a guess presented in the same
   * typeface as a fact. `null` when the run's corpus is not in the list — say
   * "an earlier version" then, rather than name the wrong one.
   */
  const lastComparedVersion = $derived.by(() => {
    const run = dedupRuns.at(-1);
    if (!run) return null;
    return (
      corpusVersions.find((v) => v.corpus_version_id === run.corpus_version_id)?.version_number ??
      null
    );
  });

  /**
   * The closed vocabulary a decision may cite, from the LOCKED protocol.
   *
   * Read off the review rather than off the `reasons` input, because the input
   * is what a lead typed before locking and the review is what was locked.
   * Evidence Review judges every exclusion against the locked protocol's list
   * (`evidence_review_service/src/application/services/screening.py:340-348`),
   * so this is the only list whose members are actually acceptable.
   */
  const vocabulary = $derived(review?.exclusion_reason_vocabulary ?? []);

  /** Who this queue is being worked as — see the badge for why in this order. */
  const actingSubject = $derived(queue?.acting_subject_id ?? subject);

  /**
   * The subject Evidence Review recorded as having created this review.
   *
   * Returned on every review read (`review_summary`, `reviews.py:583`) and,
   * until now, referenced nowhere in `frontend/src` — a grep for the field name
   * across the whole studio came back empty. It is the only field on the wire
   * that says which of this panel's write controls can possibly succeed.
   */
  const reviewCreator = $derived(review?.created_by_subject_id ?? null);

  /**
   * Whether this browser can even ASK the creator question.
   *
   * Two ways not to know, and they are folded together on purpose because the
   * consequence is identical: an older Evidence Review (or a fixture) that does
   * not carry `created_by_subject_id`, and a session whose acting subject the
   * panel cannot name. Either way the comparison below would be a guess.
   */
  const creatorKnown = $derived(!!reviewCreator && !!actingSubject);

  /**
   * True only when this panel KNOWS the caller did not create this review.
   *
   * ## What this is, and what it deliberately is not
   *
   * It is an AFFORDANCE, not an authorization decision. Evidence Review's
   * `require_review_lead` passes on `ActorRole.LEAD` **or** the creator grant
   * (`services/reviews.py:524-549`), and fr forwards no `x-actor-role` — the
   * proxy's `FORWARDED_REQUEST_HEADERS` omits it
   * (`backend/src/routes/assets/kag-reviews.ts:93`), and neither does the kag
   * gateway. So under `AUTH_BYPASS` every session binds `role='reviewer'` and
   * the creator grant is the ONLY route to lead authority; but in production a
   * real realm lead holds `LEAD` and would pass every gate below while failing
   * this comparison. The client cannot see that arm and must not pretend to.
   *
   * Hence the shape:
   *
   *  - it fails OPEN. Not knowing (`!creatorKnown`) disables nothing, because a
   *    disabled control the caller was entitled to use is a worse defect than
   *    an enabled one that comes back 403 — the first has no cure on screen,
   *    the second is already rendered as a typed error with its problem+json
   *    `code` intact (see `fail`), and that path stays exactly as it was;
   *  - it only ever gates controls whose upstream is `require_review_lead*`,
   *    never a read this caller is entitled to make and never the queue;
   *  - the reason is always STATED next to the control it disables, the way
   *    `corpus-unknown`, `reviewers-missing` and `conflicts-not-visible` are.
   *    A realm lead who is wrongly stopped can read why and knows to ignore it.
   *
   * ## The regression it answers
   *
   * `evidence_review_service` PR #13 moved `create_deduplication_run` and
   * `resolve_cluster` from `require_human` to `require_review_lead_for`
   * (`services/deduplication.py:82,221`). Measured against the merged service:
   * `POST /reviews/{id}/deduplication-runs` as the creator reaches the corpus
   * check, and as a different subject returns
   * `403 "starting a deduplication run requires the review lead role, or having
   * created this review"` — where the previous version returned `201`.
   * `GET /api/reviews` lists other people's reviews and the panel makes them
   * selectable, so a joined non-creator was shown two enabled buttons that
   * could only produce a generic red error with no next step.
   */
  const notReviewCreator = $derived(creatorKnown && reviewCreator !== actingSubject);

  /**
   * Reviewer subject ids named in the two fields, trimmed and de-blanked.
   *
   * Derived rather than recomputed inside `assign()` so the button's disabled
   * state and the request use one definition of "named" — they disagreed
   * before, which is how the count check below could be true on screen and
   * false on the wire.
   */
  const namedReviewers = $derived(
    [reviewerA, reviewerB].map((r) => r.trim()).filter(Boolean),
  );

  /**
   * How many reviewers this stage will accept nothing less than.
   *
   * From the STAGE, which is what the server enforces against — not from the
   * `reviewersRequired` select, which describes a review this browser may not
   * have created. A second reviewer joining somebody else's dual review has the
   * select sitting at its own default and the stage requiring 2.
   */
  const requiredReviewers = $derived(stage?.reviewers_required ?? 1);

  /**
   * Whether assigning can succeed at all, judged before the request is made.
   *
   * The pre-check used to catch only the ZERO case, and the comment above it
   * already stated the principle it stopped one case short of: an under-filled
   * reviewer list "reached the API as a request that could only be refused,
   * with a message about counts rather than about the blank field in front of
   * the user." That is exactly what happened to anyone who took the default —
   * the panel prefills reviewer A from the signed-in user and nothing else, so
   * a dual review (`reviewers_required: 2`, the default and the product's whole
   * point) always went out with one name and always came back
   * `422 unprocessable_state: "this stage requires 2 reviewers; 1 were named"`.
   * A tester following the happy path could not get past Assign.
   */
  const enoughReviewers = $derived(namedReviewers.length >= requiredReviewers);

  /**
   * Every subject id that IS this caller, for the self-assignment check.
   *
   * Two of them, because they can differ and either one is the hazard. The
   * prefill writes `auth.user.id` (the Keycloak `sub`), while `actingSubject`
   * is what the queue says this session is acting as and is the identity the
   * decision rows will carry. Checking only one leaves the other reachable.
   */
  const leadIdentities = $derived([actingSubject, auth.user?.id ?? ''].filter(Boolean));

  /**
   * Whether this caller has named THEMSELVES as a reviewer of a stage that can
   * produce a conflict.
   *
   * Gated on `requiredReviewers > 1` on purpose: a conflict requires two
   * decisions that differ, so a single-reviewer stage cannot reach the
   * separation-of-duty deadlock at all and must not be warned about it. See the
   * prefill above for the whole argument.
   */
  const actingIsNamedReviewer = $derived(
    requiredReviewers > 1 && namedReviewers.some((r) => leadIdentities.includes(r)),
  );

  /**
   * A Keycloak `sub`, which is what both reviewer boxes actually take.
   *
   * Shape only. `create_assignments` does not check that a named subject exists
   * or is in the tenant, so a typo is accepted silently: an assignment row is
   * written against a subject nobody holds, the stage waits forever on a
   * reviewer who never appears, and no screen anywhere says so.
   */
  const SUBJECT_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * The named reviewer fields whose value cannot be a Keycloak subject id.
   *
   * Labelled by FIELD rather than by value, for the same reason
   * `reviewers-missing` points at the blank box: the field is what the user can
   * act on.
   *
   * This WARNS and does not block, deliberately. A shape check is the only
   * check available here — there is no subject lookup on this surface — and a
   * client that refused every non-UUID subject would be inventing a rule the
   * service does not have, in a deployment whose subjects it cannot enumerate.
   * Making the mistake visible is the part that was missing; refusing it would
   * be a guess.
   */
  const malformedReviewers = $derived(
    (
      [
        ['Reviewer A', reviewerA],
        ['Reviewer B', reviewerB],
      ] as const
    )
      .filter(([, v]) => v.trim() && !SUBJECT_SHAPE.test(v.trim()))
      .map(([label]) => label),
  );

  /**
   * A message with its problem+json `code` folded in, for the places that
   * rethrow rather than surface directly.
   *
   * Hoisted out of `refresh()`, which is where it was written and where it is
   * still used. `startReview` and `seal` both need to name an underlying
   * failure inside a larger sentence, and dropping the machine-branchable slug
   * to do so would cost exactly what `refresh()` went to the trouble of keeping.
   */
  const because = (e: unknown): string => {
    if (e instanceof ReviewError) return e.code ? `${e.message} — ${e.code}` : e.message;
    return e instanceof Error ? e.message : String(e);
  };

  /**
   * Bumped every time an error is PUT on screen, including when the same text
   * is set twice running.
   *
   * The effect below moves the user to the message, and an effect keyed on
   * `error` alone would not re-run when a second identical refusal arrives —
   * the string is unchanged, so nothing is dirty, so a user who has scrolled
   * away from an error they already dismissed with their eyes gets no signal
   * that they just produced it again.
   */
  let errorSeq = $state(0);
  let errorEl = $state<HTMLElement | null>(null);

  /** Put a refusal on screen. The single door, so `errorSeq` cannot be missed. */
  function setError(message: string, code: string | null = null): void {
    error = message;
    errorCode = code;
    errorSeq += 1;
  }

  function fail(e: unknown): void {
    if (e instanceof ReviewError) {
      setError(e.message, e.code ?? null);
    } else {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Bring the refusal to the user, wherever in the panel they are standing.
   *
   * The error element is the FIRST thing in a five-card panel, and every
   * refusal a first run actually hits is fired from a button near the bottom of
   * it — the export refused with records unscreened, the assignment refused,
   * the decision refused. Measured: clicking `create-export` scrolls that
   * button into view, which puts the error paragraph at viewport ratio 0. It
   * carries `role="alert"`, so a screen reader announces it and a sighted user
   * sees the button return to its label and nothing else happen.
   *
   * That is the multiplier on every other defect in this component: it is the
   * difference between "an error the reviewer can act on" and "the button did
   * nothing". So the message is scrolled to AND focused — focus rather than
   * scroll alone because it also moves the keyboard caret out of the card the
   * user was working in, and because `tabindex="-1"` makes the announcement
   * land for anyone driving this by keyboard.
   *
   * `behavior` is left at its instant default. A smooth scroll here races the
   * assertion that the message is in view, and an animation is not what somebody
   * who has just been refused needs.
   */
  $effect(() => {
    errorSeq;
    if (error && errorEl) {
      errorEl.scrollIntoView({ block: 'center' });
      errorEl.focus();
    }
  });

  async function run(label: string, fn: () => Promise<void>): Promise<void> {
    busy = label;
    error = null;
    errorCode = null;
    notice = null;
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      busy = null;
    }
  }

  /**
   * The page of conflicts AND what the server says about the whole review, from
   * one response.
   *
   * Extracted because it had two callers and only one of them did it. `refresh`
   * wrote both; `unblindAndAdjudicate` re-read the list afterwards and assigned
   * `.data.items` alone, from a response already carrying `total` and
   * `total_open`. So adjudicating flipped the row to "adjudicated" while the
   * banner directly above it kept the numbers it was built with — "5 still need
   * adjudication — the export is refused until every one is resolved" — at the
   * exact moment the lead was working the list and had just reduced it. The
   * banner is at its most wrong when it is most read.
   *
   * `?? null` rather than a default: an older Evidence Review does not send
   * these, and inventing `has_more: false` there would assert completeness this
   * client cannot know. The banner renders only when the server said so.
   */
  function applyConflicts(body: {
    items: Conflict[];
    has_more?: boolean;
    total?: number;
    total_open?: number;
  }): void {
    conflicts = body.items;
    conflictTotals =
      typeof body.total === 'number' && typeof body.total_open === 'number'
        ? { has_more: body.has_more === true, total: body.total, total_open: body.total_open }
        : null;
  }

  /**
   * Everything about this review that the server, not this session, is the
   * authority on.
   *
   * `corpus` used to be written in exactly one place — inside
   * `importFromDiscover` — so it existed only for the person who had just
   * sealed it, in the browser tab where they sealed it. The stepper unmounts
   * this panel the moment it leaves the Screening step, and re-joining through
   * "Load existing reviews" called only this function, which never restored it.
   * The result was a review whose "Find duplicates" and "Assign both reviewers"
   * buttons were disabled forever, whose only cure was to seal the corpus AGAIN
   * — a write standing in for a read — and which after a page reload could not
   * be cured at all, because Discover's results are not persisted either and an
   * empty candidate list disables the import too.
   *
   * ## Independently degradable, on purpose
   *
   * `Promise.all` rejects on the FIRST rejection and discards the other three
   * settled results, so adding the corpus and deduplication reads to it made a
   * 500 on either of them take down the stages, the conflicts and the queue —
   * three reads that had worked fine before, and on which every remaining
   * control on this page depends. `allSettled` keeps each answer independent:
   * every read that succeeded is applied, every read that failed leaves its
   * slice untouched and is NAMED.
   *
   * Named, not swallowed. The aggregate throw at the end is what puts the
   * failure on screen through `run()`; a refresh that quietly returned with
   * three quarters of the panel stale would be the worse bug, because nothing
   * on the page would say so.
   */
  async function refresh(): Promise<void> {
    if (!review) return;
    const id = review.review_id;
    const [s, c, cv, dr, ex, q] = await Promise.allSettled([
      listStages(id),
      listConflicts(id),
      listCorpusVersions(id),
      listDeduplicationRuns(id),
      listExports(id),
      // The rows the import DROPPED. Read on every refresh rather than on
      // demand: it is not lead-gated, it is a fact about the corpus rather than
      // about anybody's progress, and it is the only quarantine count a
      // re-joining reviewer can obtain at all — `batch` belongs to whoever ran
      // the import and `flow.counts.quarantined` is lead-only.
      listQuarantine(id),
    ]);

    const unreadable: string[] = [];
    // The problem+json `code` is carried through, not dropped — see `because`,
    // which is now shared with the two writers that have to name a failure
    // inside a larger sentence. Folding four reads into one message must not
    // cost the caller the machine-branchable slug that told them WHICH refusal
    // this was.
    const why = (r: PromiseRejectedResult): string => because(r.reason);

    if (s.status === 'fulfilled') {
      stages = s.value.data.items;
    } else {
      unreadable.push(`stages (${why(s)})`);
    }

    if (c.status === 'fulfilled') {
      applyConflicts(c.value.data);
      conflictsKnowledge = 'read';
    } else if (c.reason instanceof ReviewError && c.reason.status === 403) {
      // Not a fault. This caller is not the review lead, and `GET /conflicts`
      // is `require_review_lead` — so the refusal is the service working. It is
      // kept OUT of `unreadable` deliberately: pushed there it became an error
      // on screen for every reviewer on every refresh, about a resource they
      // are not entitled to read, and a failed request the browser lanes'
      // acceptance gate reads as a defect. Which is how it was found.
      //
      // Not folded into success either — `conflicts = []` alone would say "this
      // review has no disagreements", which is a different and possibly false
      // statement.
      conflicts = [];
      conflictTotals = null;
      conflictsKnowledge = 'forbidden';
    } else {
      conflictsKnowledge = 'unreadable';
      conflictTotals = null;
      unreadable.push(`conflicts (${why(c)})`);
    }

    if (cv.status === 'fulfilled') {
      // Highest version_number, chosen by NUMBER rather than by position in the
      // list. The panel must name the corpus the review is currently screened
      // against; trusting the API's ordering would silently re-point every count
      // and hash on this page at v1 if that ordering ever changed.
      corpusVersions = cv.value.data.items;
      corpus = cv.value.data.items.reduce<CorpusVersion | null>(
        (best, v) => (best === null || v.version_number > best.version_number ? v : best),
        null,
      );
      corpusKnowledge = 'read';
    } else {
      // `corpus` is deliberately LEFT ALONE. Clearing it would turn a failed
      // read into the on-screen claim that this review has no corpus, which is
      // the false statement the guard is protecting against; whatever was last
      // known stays, and `corpusKnowledge` records that it is no longer
      // confirmed. The guard reads the knowledge, not the value.
      corpusKnowledge = 'unreadable';
      unreadable.push(`the sealed corpus (${why(cv)})`);
    }

    if (dr.status === 'fulfilled') {
      // The whole list, with each run's `corpus_version_id` intact. This used
      // to be collapsed to `dedupRan = count > 0`, which is the one shape that
      // cannot answer the question the card asks — see `runForCorpus`.
      dedupRuns = dr.value.data.items;
    } else {
      unreadable.push(`deduplication runs (${why(dr)})`);
    }

    if (ex.status === 'fulfilled') {
      // Newest by `created_at`, chosen by VALUE and not by position, for the
      // same reason the corpus is chosen by `version_number`: the service does
      // order this list, and an ordering this client cannot enforce must not be
      // the thing that decides which seal a lead is shown.
      //
      // `?? ''` on a missing timestamp sorts it to the bottom rather than
      // letting `undefined` win a comparison — an export whose `created_at` the
      // service could not state is the last thing to present as the current
      // seal.
      const newest = ex.value.data.items.reduce<InclusionExport | null>(
        (best, e) => (best === null || (e.created_at ?? '') > (best.created_at ?? '') ? e : best),
        null,
      );
      // The verification describes ONE export. When the read turns up a
      // different one — somebody else sealed after a reopen, or this is a first
      // arrival — carrying the badge over would put a "round-trips" verdict
      // above a seal nothing verified, which is the worst statement available
      // on this surface. Same argument as `seal()`'s clear-before-await, from
      // the read side.
      if (newest?.export_id !== sealedExport?.export_id) {
        verification = null;
        verificationFailure = null;
        exportReplayed = false;
      }
      sealedExport = newest;
      exportsKnowledge = 'read';
    } else if (ex.reason instanceof ReviewError && ex.reason.status === 403) {
      // Not a fault, exactly like `GET /conflicts` above: this caller is not the
      // review lead and every export route is `require_review_lead`, the reads
      // included. Kept OUT of `unreadable` for the reason that refusal was:
      // pushed there it is an on-screen error, on every refresh, for every
      // reviewer, about something they are not entitled to read.
      //
      // `sealedExport` is deliberately NOT cleared to `null` here. A reviewer
      // has none to begin with, but "you may not ask" must never write the
      // claim "there is none" over a seal this panel has already seen.
      exportsKnowledge = 'forbidden';
    } else {
      // Left alone for the same reason `corpus` is: clearing it would turn a
      // failed read into the on-screen claim that this review has never been
      // sealed, which is the false statement the indicator exists to prevent.
      exportsKnowledge = 'unreadable';
      unreadable.push(`the sealed inclusion set (${why(ex)})`);
    }

    if (q.status === 'fulfilled') {
      // `?? []` because a fixture — or a service that answers the path without
      // a body — would otherwise leave this `undefined` and take the list
      // render down with it.
      quarantine = q.value.data.items ?? [];
      quarantineKnowledge = 'read';
    } else {
      // LEFT ALONE, like `corpus` and `sealedExport`: clearing it would turn a
      // failed read into the on-screen claim that nothing was quarantined,
      // which is the exact statement `ER-009.3` exists to prevent.
      quarantineKnowledge = 'unreadable';
      unreadable.push(`the quarantined rows (${why(q)})`);
    }

    // Only asked once there is a run FOR THIS CORPUS, and asked BY that run's
    // id. Two separate reasons, both load-bearing:
    //
    //  - unqualified, `listClusters` resolves the most recent run for the
    //    review whatever corpus it compared, so after a re-seal it answers with
    //    the superseded corpus's clusters and the card renders them as current;
    //  - it answers "this review has no deduplication run" with a 404, and a
    //    404 on every not-yet-deduped review would put a failed request on the
    //    reviews surface that the browser lanes' acceptance gate reads — quite
    //    correctly — as a defect.
    //
    // `runForCorpus` is `$derived`, and the assignments above are what it
    // derives from; reading it here would read the PREVIOUS value, so the run
    // is resolved locally from the values just written.
    if (dr.status === 'fulfilled') {
      const run = corpus
        ? (dedupRuns.findLast((r) => r.corpus_version_id === corpus!.corpus_version_id) ?? null)
        : null;
      try {
        clusters = run ? (await listClusters(id, run.dedup_run_id)).data.items : [];
      } catch (e) {
        unreadable.push(`duplicate clusters (${because(e)})`);
      }
    }

    // The queue of the stage on screen, not of the first stage that exists.
    // Pinned to `stages[0]`, a two-stage review showed its title/abstract queue
    // for ever and the full-text stage could never be screened.
    if (stages[stageIndex]) {
      try {
        // THE ROUND, stated. A queue read without one takes the service's
        // default of 1 and serves the corpus round 1 was minted from, whatever
        // corpus the card above is displaying.
        queue = (await getQueue(id, stages[stageIndex].stage_id, roundNumber)).data;
      } catch (e) {
        unreadable.push(`your queue (${because(e)})`);
      }
    }

    if (unreadable.length) {
      throw new Error(`Could not read ${unreadable.join('; ')}. Refresh to try again.`);
    }
  }

  export async function loadReviews(): Promise<void> {
    await run('reviews', async () => {
      reviews = (await listReviews()).data.items;
    });
  }

  async function selectReview(r: Review): Promise<void> {
    await run('select', async () => {
      review = r;
      // FIRST, because these two are the ones that produce a FALSE claim rather
      // than a stale one. `flow` holds the previous review's PRISMA counts and
      // its `canonical_counts_hash`; `protocol` holds the previous review's
      // version number and lock state. Both render unconditionally under the
      // new review's title, unmarked and indistinguishable from this review's
      // own — and `projection_stale` says nothing about it, because that is the
      // server's cache flag for the review it was read from.
      //
      // Nineteen other fields were already cleared here for exactly this
      // reason; these two were simply missed, and they are the two a reader
      // would quote.
      flow = null;
      flowStale = false;
      protocol = null;
      corpusVersions = [];
      // Everything below describes the review we are LEAVING. Carrying it over
      // would show one review's sealed corpus, clusters and assignment counts
      // under another review's title — and worse, if the new review's corpus
      // read fails, the guard would be armed against the wrong corpus.
      corpus = null;
      corpusKnowledge = 'unread';
      batch = null;
      // Same reason as `batch` on the line above: it describes the review being
      // LEFT. Today the notice is rendered inside `{#if batch}` so a stale value
      // could not surface on its own — but "the corpus came from a frozen batch"
      // is a provenance claim, and one carried across a review switch would be a
      // claim about the wrong review the moment that guard is refactored.
      frozenBatch = null;
      clusters = [];
      dedupRuns = [];
      // The stage index describes the review being LEFT, and stages are
      // per-review: carried across a switch it would select stage 2 of a review
      // that has one, or resolve to `null` and silently disable screening.
      stageIndex = 0;
      // A round belongs to a (review, stage) pair. Carried across a switch it
      // would ask the new review's stage for a pass that may not exist, and
      // answer with an empty queue and no explanation.
      roundNumber = 1;
      boundRound = null;
      exclusionReason = {};
      correcting = {};
      adjudicationReason = {};
      adjudicationRationale = {};
      discloseTo = {};
      queue = null;
      conflicts = [];
      conflictTotals = null;
      conflictsKnowledge = 'unread';
      assignment = null;
      resealArmed = false;
      // The sealed export and its verification describe the review being LEFT.
      // Carried across a switch they would put one review's seal, counts and
      // "round-trips" badge under another review's title — the same class of
      // false claim as the stale badge `seal()` now clears.
      sealedExport = null;
      exportsKnowledge = 'unread';
      exportReplayed = false;
      verification = null;
      verificationFailure = null;
      // The seal's CONTENTS, for the same reason as the seal itself: one
      // review's included records listed under another review's title is the
      // most concrete false claim this panel could make.
      sealedPayload = null;
      payloadKnowledge = 'unread';
      sealedSetOpen = false;
      quarantine = [];
      quarantineKnowledge = 'unread';
      quarantineOpen = false;
      await refresh();
    });
  }

  /**
   * Create a review, lock its protocol and activate it — four sequential writes
   * through a proxy, behind the FIRST button in this stage.
   *
   * ## Why `review` is not assigned until the end
   *
   * It used to be set from the create response, before `createProtocol`,
   * `lockProtocol` and `activateReview` had run, and it is never set back to
   * null anywhere in this component. Measured: with `lockProtocol` rejecting,
   * `screening-error` appears and `create-review` AND `load-reviews` both
   * DISAPPEAR — they live inside `{#if !review}` — while `activateReview` never
   * fires. What is left is a panel holding a review it never activated, whose
   * only remaining control is Refresh, and whose only escape is navigating away
   * to force a remount. The first button in the stage could strand it.
   *
   * Committing at the end keeps the failure recoverable IN PLACE: the start
   * card stays, so the half-made review can be reopened through "Load existing
   * reviews" — which is not a workaround but the ordinary join path, and it is
   * NAMED in the message, because a user who cannot see the review they just
   * created will otherwise click Create again and make a second one.
   */
  async function startReview(): Promise<void> {
    await run('create', async () => {
      // Guarded rather than merely disabled. The button carries the same
      // condition, so this is unreachable through the UI — but the alternative
      // to stating it is sending `project_id: ''`, which the service would
      // either refuse with a message about a field the user never saw or, worse,
      // accept.
      if (!projectId.trim()) {
        setError('name the project this review belongs to before creating it');
        return;
      }
      // `title` is `min_length=1` server-side (`api/routers/reviews.py:34`), so
      // a blank one cannot even be sent. It is guarded here rather than left to
      // the 422 because the field used to arrive prefilled with this studio's
      // own rehearsal name — see `title`.
      if (!title.trim()) {
        setError('name this review before creating it');
        return;
      }
      // Guarded for the same reason as the exclusion half below, and it is the
      // half the service will NOT refuse: `inclusion_criteria` is
      // `dict[str, Any]`, so `{"statement": "   "}` returns 201 and hashes
      // three spaces into a protocol that is locked the same second.
      if (!criteria.trim()) {
        setError('state what this protocol includes before locking it');
        return;
      }
      // Guarded here as well as on the button, for the reason above it: the
      // alternative to stating it is sending `{ statement: '' }` into a
      // `nullable=False` column, through a `content_hash`, into a protocol that
      // is locked the same second and can never be edited again.
      if (!exclusionCriteria.trim()) {
        setError('state what this protocol excludes before locking it');
        return;
      }
      const created = await createReview({
        project_id: projectId.trim(),
        external_key: `studio-${Date.now()}`,
        // Trimmed, like every other field on this form. A title of `'  '`
        // passes `min_length=1` and is written to the review permanently.
        title: title.trim(),
      });
      let activated: Review;
      try {
        activated = await activateFor(created.data);
      } catch (e) {
        // The review EXISTS server side. Saying only "the protocol store is
        // unavailable" would leave the user believing nothing happened.
        throw new Error(
          `“${created.data.title}” was created, but its protocol could not be locked and ` +
            `activated, so the review is not ready to screen. Reopen it with “Load existing ` +
            `reviews” rather than creating a second one. (${because(e)})`,
        );
      }
      review = activated;
      await refresh();
      notice = 'Protocol locked and review activated. It can no longer be edited.';
    });
  }

  /**
   * The three writes that turn a created review into a screenable one.
   *
   * Split out so `startReview` can tell "the review was never created" from
   * "the review exists but is not activated" — two different situations with
   * two different next actions, which one flat `try` could not distinguish.
   */
  async function activateFor(created: Review): Promise<Review> {
    const pv = await createProtocol(created.review_id, {
      // TRIMMED, like the exclusion statement one line below it — which was
      // trimmed while this one was not. Both go into the same `content_hash`,
      // both are locked the same second, and both are sealed into every export;
      // there is no reading on which one of them deserves the whitespace.
      inclusion_criteria: { statement: criteria.trim() },
      // The user's words, not the component's. This literal is what the field
      // used to be — see `exclusionCriteria` for what it cost, which is a
      // sentence nobody typed inside the `content_hash` of every locked
      // protocol fr has ever created.
      exclusion_criteria: { statement: exclusionCriteria.trim() },
      // One or both of the two PRISMA screens, in order — see `stageCount`.
      // This was the one-element literal that made a second stage unexpressible.
      stage_definitions: [
        {
          key: 'title-abstract',
          name: 'Title/abstract',
          reviewers_required: reviewersRequired,
        },
        {
          key: 'full-text',
          name: 'Full text',
          reviewers_required: reviewersRequired,
        },
      ].slice(0, stageCount),
      exclusion_reason_vocabulary: reasons
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
      reviewers_required: reviewersRequired,
    });

    const locked = (await lockProtocol(created.review_id, pv.data.protocol_version_id)).data;
    const activated = (
      await activateReview(created.review_id, {
        protocol_version_id: locked.protocol_version_id,
        // The user's words, not the component's. See `activationRationale`.
        rationale: activationRationale.trim(),
      })
    ).data;
    // Written only once every write has landed, for the same reason `review` is:
    // a locked protocol on screen above a review that was never activated is a
    // claim about a state that does not exist.
    protocol = locked;
    return activated;
  }

  async function importFromDiscover(): Promise<void> {
    if (!review) return;
    await run('import', async () => {
      // Consent is spent HERE — before the writes, not after them.
      //
      // This used to sit after `sealCorpus`, which meant it was skipped on
      // every failure path: a seal that threw left the box ticked and the
      // button live again the instant `busy` cleared. That is not a harmless
      // no-op, because the import lands FIRST. A 422 from the seal is a state
      // in which this browser's papers are already in somebody else's review
      // and the one control still armed is the one that seals them. The user
      // consented to one supersede; if it fails, the next one is a new
      // decision and costs a new tick.
      resealArmed = false;
      if (sessionId) {
        // THE BROWSER IS NOT IN THE DATA PATH.
        //
        // Two calls, and neither carries a record. The engine freezes the
        // session and returns a receipt; Evidence Review is handed that receipt
        // and fetches the document itself, hashes what it received, and refuses
        // unless it reproduces `digest`.
        //
        // The old single call posted `JSON.stringify({records: papers})` —
        // server data re-shaped in this tab — so `raw_payload_digest`, which
        // anchors the corpus manifest and the PRISMA counts, described a
        // document built here. It could not be fixed by forwarding the engine's
        // bytes instead: `HttpClient` exposes only `json<T>()`, so every hop is
        // parse-then-reserialise and the bytes are gone by the time they arrive.
        const receipt = await researchApi.takeReviewExport(sessionId);
        const imported = (
          await importDiscoveryBatch(review!.review_id, {
            session_id: sessionId,
            batch_id: receipt.batch_id,
            expected_digest: receipt.digest,
          })
        ).data;
        // THE PAIR MOVES TOGETHER, and the order is the point.
        //
        // `frozenBatch = receipt` used to run on the line after the freeze,
        // before the import that justifies it. `batch` only ever changes on a
        // SUCCESSFUL import, so a refused import left the two describing
        // different documents: the card renders inside `{#if batch}`, reads
        // `frozenBatch` for the provenance line, and would name the batch that
        // was just REFUSED while the sealed corpus was still the previous one —
        // in the worst case a browser-built fallback corpus presented as "no
        // record passed through this browser".
        //
        // Assigned after the await, from a local, so the claim and the thing it
        // is a claim about cannot come apart.
        frozenBatch = receipt;
        batch = imported;
      } else {
        // No session — the mocked lanes, the unit tests, and any state where
        // Discover never produced one. NAMED rather than silent: this path
        // seals bytes this browser built, and a fallback nobody can see is how
        // the defect above survived. `frozenBatch` stays null and the card says
        // so.
        frozenBatch = null;
        const payload = JSON.stringify({ records: papers });
        batch = (await importCorpus(review!.review_id, 'canonical_json', payload)).data;
      }
      corpus = (await sealCorpus(review!.review_id)).data;
      corpusKnowledge = 'read';
      await refresh();
    });
  }

  async function dedupe(): Promise<void> {
    if (!review) return;
    await run('dedupe', async () => {
      const created = (await runDeduplication(review!.review_id)).data;
      // The run list is re-read rather than a local flag being set, so the
      // run -> corpus binding comes from the server. Setting a boolean here is
      // what made the card unable to tell a stale answer from a current one.
      dedupRuns = (await listDeduplicationRuns(review!.review_id)).data.items;
      clusters = (await listClusters(review!.review_id, created.dedup_run_id)).data.items;
    });
  }

  async function merge(cluster: DuplicateCluster): Promise<void> {
    if (!review) return;
    await run(`merge-${cluster.cluster_id}`, async () => {
      await resolveCluster(review!.review_id, cluster.cluster_id, {
        resolution_type: 'merge',
        // KEPT canned, and this is the one rationale on this surface where that
        // is defensible. The button says "Merge" on a cluster the deduplication
        // run proposed on an identical identifier, so the grounds are entirely
        // mechanical and this sentence states them exactly: there is no human
        // judgement being recorded here for a free-text box to capture, and a
        // prompt would collect noise in place of a fact that is already true.
        //
        // It is NOT the same situation as the adjudication rationale below,
        // which settles a disagreement between two people and where no accurate
        // default can exist.
        rationale: 'same identifier — one work',
        survivor_record_id: cluster.members[0]?.review_record_id,
      });
      // Re-read for the SAME run, not for whatever run is newest — a resolution
      // does not create a run, and asking unqualified here would re-open the
      // very staleness this card now distinguishes.
      clusters = runForCorpus
        ? (await listClusters(review!.review_id, runForCorpus.dedup_run_id)).data.items
        : [];
    });
  }

  async function assign(): Promise<void> {
    if (!review || !stage) return;
    // An under-filled reviewer list reached the API as a request that could only
    // be refused, with a message about counts rather than about the blank field
    // in front of the user.
    //
    // This guard used to stop at `length === 0`, which left the DEFAULT
    // configuration broken: `reviewersRequired` starts at 2 — dual blinded
    // screening, the product's whole point — so the stage is materialised
    // requiring two, while the panel prefills only reviewer A from the signed-in
    // user. Every first-time drive therefore sent one name and got back
    // `422 unprocessable_state: "this stage requires 2 reviewers; 1 were named"`.
    // Nothing was wrong with the review; the page simply had not said that the
    // second field was not optional.
    //
    // Judged against `stage.reviewers_required`, which is what the server
    // enforces, rather than against the local select — a second reviewer joining
    // somebody else's dual review has that select at its own default.
    if (!enoughReviewers) {
      const missing = requiredReviewers - namedReviewers.length;
      error =
        requiredReviewers <= 1
          ? 'name at least one reviewer before assigning'
          : `this stage screens every record ${requiredReviewers} times, so it needs ` +
            `${requiredReviewers} reviewers — ${missing === 1 ? 'one more is' : `${missing} more are`} ` +
            'still to be named.';
      errorCode = null;
      return;
    }
    await assignForRound(roundNumber);
  }

  /**
   * Assign this stage's reviewers FOR ONE ROUND, and treat the bound-round
   * refusal as a next action rather than as an error.
   *
   * `create_assignments` answers `409` when the round already holds a different
   * corpus version (`services/screening.py:310-323`). Assignments are
   * append-only and `uq_assignment_once` excludes the corpus, so there is
   * nothing to repair — the service says so and names the round that IS free.
   * That number reaches the browser only inside the problem detail, and this
   * client is the only thing that can put it in front of a lead.
   *
   * Without this branch the studio's own armed re-seal control leads straight
   * to a review that can never be exported: v2 is sealed, round 1 still holds
   * v1's assignments, the queue keeps serving v1's text, and `POST /exports`
   * refuses forever with `not_yet_screened > 0`.
   */
  async function assignForRound(round: number): Promise<void> {
    await run('assign', async () => {
      boundRound = null;
      try {
        const created = (
          await createAssignments(review!.review_id, {
            stage_id: stage!.stage_id,
            round_number: round,
            reviewer_subject_ids: namedReviewers,
          })
        ).data;
        assignment = created;
        // The panel's round follows the SERVER's answer, not the request. They
        // agree today; a client that only ever assumes they do is the one that
        // cannot notice when they stop.
        roundNumber = created.round_number ?? round;
      } catch (e) {
        // Narrowed hard, and only on what the problem body ACTUALLY carries.
        // A 409 without a `next_round_number` is a refusal this client cannot
        // offer a remedy for, so it goes through `run()`'s normal failure path
        // with its problem+json code intact rather than being rendered as a
        // one-click fix that would repeat the same request.
        if (!(e instanceof ReviewError) || e.status !== 409) throw e;
        const next = e.detail.next_round_number;
        if (typeof next !== 'number') throw e;
        const bound = e.detail.bound_corpus_version_ids;
        boundRound = {
          round,
          next,
          // Named only when the service named them. An empty list renders "a
          // different corpus version" rather than an empty code span — the
          // sentence has to stay true when the detail is thinner than expected.
          corpora: Array.isArray(bound) ? bound.filter((c): c is string => typeof c === 'string') : [],
          detail: e.message,
        };
        return;
      }
      await refresh();
    });
  }

  /**
   * Take the round the service named, and assign into it.
   *
   * One click, because the alternative is a lead reading a round number out of
   * an error message and there is no other control on this page that could set
   * it. The reviewer list is unchanged — this is the same assignment, at the
   * position it can actually be made.
   */
  async function screenAsNextRound(): Promise<void> {
    const target = boundRound?.next;
    if (!review || !stage || typeof target !== 'number') return;
    roundNumber = target;
    await assignForRound(target);
  }

  /**
   * Record a decision, or CORRECT one.
   *
   * `supersedes` is the whole recovery path. Evidence Review refuses a second
   * decision at the same position with `409` carrying `current_decision_id`,
   * and refuses a supersede naming anything other than the caller's current
   * decision (`services/screening.py:690-698`) — so a correction must name
   * exactly `my_decision.decision_id`, which is what the queue already carries
   * and nothing in this studio ever read.
   */
  async function decide(
    recordId: string,
    disposition: string,
    supersedes: string | null = null,
  ): Promise<void> {
    if (!review || !stage) return;
    // The reason THIS reviewer selected for THIS record. It used to be
    // `vocabulary[0]`, passed in by the caller, so every exclusion in the
    // product cited the protocol's first reason whatever the reviewer thought —
    // the closed vocabulary the lead configures ("a decision may cite nothing
    // else") had exactly one reachable member, and the flow ledger's
    // `exclusion_reasons` histogram could only ever have one key.
    const reason = exclusionReason[recordId] ?? vocabulary[0];
    if (disposition === 'exclude' && !reason) {
      // Unreachable through the UI — the Exclude button is disabled when the
      // vocabulary is empty — but stated rather than sent as `undefined`.
      // Evidence Review refuses an exclusion whose code is not IN the locked
      // vocabulary, and `undefined` is not in an empty list
      // (`services/screening.py:340-348`), so the alternative is a request that
      // can only ever come back 422.
      error = 'this review’s locked protocol names no exclusion reasons, so an exclusion cannot cite one';
      errorCode = null;
      return;
    }
    await run(`decide-${recordId}`, async () => {
      await recordDecision(review!.review_id, {
        stage_id: stage!.stage_id,
        // The round this judgement belongs to. The service resolves the
        // reviewer's assignment by `(stage, round, record, reviewer)` and reads
        // the record's text through THAT assignment's corpus, so a decision
        // filed against the wrong round is a judgement recorded at a position
        // the reviewer was never assigned.
        round_number: roundNumber,
        review_record_id: recordId,
        disposition,
        ...(disposition === 'exclude' ? { exclusion_reason_code: reason } : {}),
        ...(supersedes ? { supersedes_decision_id: supersedes } : {}),
      });
      // Closed only on success. A correction whose write was refused must stay
      // open, with the buttons the reviewer was using still on screen.
      delete correcting[recordId];
      queue = (await getQueue(review!.review_id, stage!.stage_id, roundNumber)).data;
      // The ledger on screen now predates this decision. See `flowStale` for
      // why this is a marker and not a re-read.
      flowStale = true;
    });
  }

  async function unblindAndAdjudicate(conflict: Conflict, disposition: string): Promise<void> {
    if (!review) return;
    const rationale = (adjudicationRationale[conflict.conflict_id] ?? '').trim();
    if (!rationale) {
      // Unreachable through the UI — both adjudicate buttons carry the same
      // condition — but stated rather than sent. An adjudication is the write
      // that settles a record for good; an empty grounds field is the one thing
      // this component must not fill in on the lead's behalf.
      setError('state the grounds for this adjudication before recording it');
      return;
    }
    await run(`adjudicate-${conflict.conflict_id}`, async () => {
      if (!conflict.unblinded) {
        const { unblindConflict } = await import('$lib/api/reviews');
        // The audience the lead named, or nobody — which discloses to the lead
        // alone. Split on commas and whitespace so a lead can paste a list.
        // COMMAS ONLY. Splitting on whitespace too shredded any subject id
        // containing a space — `"reviewer a, reviewer b"` became four fragments,
        // the server accepted every one (it does not check that a named subject
        // exists), and the lead believed they had disclosed while the reviewer
        // saw nothing. Widening blinding has to be deliberate and attributable;
        // failing silently in the other direction is the worst of both.
        const audience = (discloseTo[conflict.conflict_id] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        await unblindConflict(
          review!.review_id,
          conflict.conflict_id,
          // KEPT canned, on the same grounds as the merge rationale above and
          // not on the grounds of the adjudication rationale below. This code
          // path unblinds for exactly one purpose — it is the step immediately
          // before `adjudicate`, reached only by pressing an "Unblind &…"
          // button — so the sentence is a true statement of mechanism rather
          // than a stand-in for somebody's judgement. WHO the disclosure widens
          // to is the discretionary part of this write, and that is `audience`
          // above, which the lead types.
          'adjudicating a disagreement',
          audience,
        );
      }
      await adjudicate(review!.review_id, conflict.conflict_id, {
        disposition,
        // THE GROUNDS THAT SETTLE THE RECORD, in the lead's own words.
        //
        // This was `'lead adjudication from the research studio'` — a constant,
        // written into an append-only row as the attributable reason a
        // disagreement between two reviewers was decided. Every adjudication in
        // the product carried the same sentence, so the field could not
        // distinguish any two decisions and was worth precisely nothing to a
        // reader of the corpus, which is the one audience it exists for.
        //
        // Unlike the merge and unblinding rationales above, no accurate default
        // is available here: the grounds depend on what the two reviewers
        // disagreed about. So it is required, and the buttons are held until it
        // is written.
        rationale,
        // The reason the LEAD chose for this conflict, not `vocabulary[0]`.
        // Adjudication is the decision that settles a disagreement and is the
        // one recorded against the record for good; citing whichever reason
        // happened to be first in the protocol made the adjudicator's stated
        // grounds a fiction, and collapsed the flow ledger's
        // `exclusion_reasons` histogram to a single key.
        ...(disposition === 'exclude'
          ? { exclusion_reason_code: adjudicationReason[conflict.conflict_id] ?? vocabulary[0] }
          : {}),
      });
      // Both halves of the response, not just the page — see `applyConflicts`.
      applyConflicts((await listConflicts(review!.review_id)).data);
      // An adjudication moves `adjudicated`, and moves the record between
      // `included`/`excluded`. The counts on screen describe the review as it
      // was before this ruling.
      flowStale = true;
    });
  }

  async function loadFlow(): Promise<void> {
    if (!review) return;
    await run('flow', async () => {
      flow = (await getFlow(review!.review_id)).data;
      // The counts on screen are the server's again, as of now.
      flowStale = false;
    });
  }

  async function rebuild(): Promise<void> {
    if (!review) return;
    await run('rebuild', async () => {
      const result = (await rebuildFlow(review!.review_id)).data;
      flow = result;
      flowStale = false;
      notice = result.matches_previous_projection
        ? `Rebuilt from zero — identical hash ${result.canonical_counts_hash.slice(0, 19)}…`
        : 'Rebuild produced a DIFFERENT hash: the cached projection had drifted and has been corrected.';
    });
  }

  /**
   * Seal an inclusion export and check that it round-trips.
   *
   * ## Why both fields are cleared FIRST
   *
   * Neither was, and `verification` is written only on success — so two
   * separate false statements were reachable, both of them about the artefact
   * this entire stage exists to produce.
   *
   *  - `POST /exports` succeeds and `:verify` THROWS: `verification` stays
   *    null, and the `{:else}` branch renders "cannot be checked here" — a
   *    phrase `reviews.ts:683-700` reserves for the service REPORTING
   *    `outcome: 'unverifiable'`. A broken request was presented as a statement
   *    about the installed contract wheel. Different fact, different remedy:
   *    one is "retry, the verifier is down", the other is "this deployment
   *    cannot check this schema at all".
   *  - Export #1 verifies; export #2's verify throws: the NEW export's counts
   *    and hashes render underneath the PREVIOUS export's "round-trips" badge.
   *    A seal that nothing verified, labelled verified. That is the worst
   *    failure available on this surface, because the badge is the only reason
   *    to trust the row above it.
   *
   * The existing browser proofs cover all three verification RESPONSE shapes
   * and never a verify that throws, which is how both survived.
   */
  async function seal(): Promise<void> {
    if (!review) return;
    await run('export', async () => {
      // Cleared before the awaits, not after them: everything below describes
      // the PREVIOUS export, and the moment a new one is created it is a claim
      // about the wrong artefact.
      sealedExport = null;
      verification = null;
      verificationFailure = null;
      exportReplayed = false;
      // The CONTENTS on screen describe the previous seal. Cleared with
      // everything else, and before the await, for the same reason the
      // verification badge is: a new export's counts under the old export's
      // record list is a claim about the wrong artefact.
      sealedPayload = null;
      payloadKnowledge = 'unread';
      const created = (await createExport(review!.review_id)).data;
      sealedExport = created;
      // `=== true`, not truthiness and not a default. An older service sends no
      // such key, and treating its silence as "fresh" is the claim this flag
      // exists to stop making; treating it as "replayed" would be the same
      // error pointing the other way.
      exportReplayed = created.replayed === true;
      // The panel now KNOWS this review has a seal — it is holding it. Leaving
      // the knowledge at `unread` would keep the "never sealed" copy on screen
      // beside the seal itself.
      exportsKnowledge = 'read';
      try {
        verification = (await verifyExport(review!.review_id, created.export_id)).data;
      } catch (e) {
        // Recorded AND rethrown. The badge needs to say the check did not run;
        // `run()` needs to put the underlying refusal on screen with its code.
        // Swallowing it here would leave the panel with a quiet warning badge
        // and no explanation of what failed.
        verificationFailure = because(e);
        throw e;
      }
      // DELIBERATELY NOT `flowStale = true`, unlike `decide` and
      // `unblindAndAdjudicate`.
      //
      // A seal writes an `inclusion_exports` row and, through
      // `_compute_flow(persist=True)`, possibly a flow revision. It writes no
      // decision, no adjudication and no record — so every input the counts are
      // derived from is unchanged, and the numbers on the card are exactly as
      // true after the seal as before it. `flow_revision_number` may advance,
      // and this card does not render it.
      //
      // Marking them stale here would be the same class of error the flag
      // exists to remove, pointing the other way: an indicator that cries stale
      // when nothing moved teaches the reader to ignore it, and then it is
      // worth nothing on the two calls where it IS true.
    });
  }

  /**
   * READ what the seal contains — the records, and every omission.
   *
   * The card showed `included_count`, `omissions_count` and a 23-character hash
   * prefix, which identify nothing: a reader cannot tell whether the right
   * paper is in the set, and a reviewer cannot check their own work. Evidence
   * Review returns the whole envelope on a plain GET
   * (`api/routers/exports.py:85-98`).
   *
   * `403` is branched rather than reported. Every export route is lead-only,
   * the reads included, and a reviewer meeting it is the service working.
   */
  async function readSealedSet(): Promise<void> {
    if (!review || !sealedExport) return;
    sealedSetOpen = true;
    if (sealedPayload?.export_id === sealedExport.export_id) return;
    const target = sealedExport.export_id;
    await run('sealed-set', async () => {
      sealedPayload = null;
      payloadKnowledge = 'unread';
      try {
        sealedPayload = (await getExport(review!.review_id, target)).data;
        payloadKnowledge = 'read';
      } catch (e) {
        // Kept apart, for the reason every other `*Knowledge` in this file is:
        // "you may not read this" and "the read broke" are different facts, and
        // NEITHER of them is "this seal contains nothing".
        payloadKnowledge =
          e instanceof ReviewError && e.status === 403 ? 'forbidden' : 'unreadable';
        throw e;
      }
    });
  }

  /**
   * The included records, or `null` when the response carried no envelope.
   *
   * `with_payload` is a parameter and an older service does not send the member
   * at all, so `payload.included` can legitimately be absent. `null` is the
   * distinction the card renders: "this seal contains no records" is a very
   * different statement from "this response did not carry them", and only one
   * of them is ever true here.
   */
  const includedRecords = $derived(sealedPayload?.payload?.included ?? null);
  const sealedOmissions = $derived(sealedPayload?.payload?.omissions ?? sealedPayload?.omissions ?? null);

  /**
   * Hand the reviewer the inclusion set as a file.
   *
   * The studio already downloads the UNSCREENED Discover candidates as
   * `.bib`/`.ris`/`.json` (`+page.svelte:283-313`); the screened RESULT — the
   * artefact the whole stage exists to produce — could not be taken out of the
   * product at all. RIS because that is what a reference manager reads, and it
   * is the inclusion set's actual destination; JSON because it is the sealed
   * envelope verbatim, which is what an auditor re-hashes.
   *
   * The RIS is DERIVED and says so on the card: it is a convenience rendering
   * of `payload.included`, not the sealed bytes, and nothing about it
   * round-trips to `payload_digest`. The JSON is the response as it arrived.
   */
  function toRis(records: NonNullable<typeof includedRecords>): string {
    return records
      .map((r) =>
        [
          `TY  - ${r.record_type === 'report' ? 'RPRT' : 'JOUR'}`,
          r.title ? `TI  - ${r.title}` : null,
          r.publication_year !== null ? `PY  - ${r.publication_year}` : null,
          r.doi ? `DO  - ${r.doi}` : null,
          r.pmid ? `AN  - ${r.pmid}` : null,
          // The version actually sealed, so a row can be traced back into the
          // export it came from rather than merely recognised.
          `ID  - ${r.review_record_version_id}`,
          'ER  - ',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');
  }

  function downloadExport(format: 'json' | 'ris'): void {
    if (!sealedPayload || !sealedExport) return;
    const records = includedRecords;
    if (format === 'ris' && (records === null || records.length === 0)) {
      // Never hand somebody a 0-byte valid-looking file — the same guard
      // `exportSession` carries on the Discover side, and it matters more here
      // because an empty inclusion set is a claim about evidence.
      setError('this seal carries no records to write, so there is nothing to download');
      return;
    }
    const body =
      format === 'json' ? JSON.stringify(sealedPayload, null, 2) : toRis(records ?? []);
    // Guarded because jsdom has no object URLs — the same shape `+page.svelte`
    // uses for the session export.
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const blob = new Blob([body], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inclusion-set-${sealedExport.export_id}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Check the seal that is ALREADY there — a read, with no write in front of it.
   *
   * The question a lead returning to a sealed review actually has is "does my
   * inclusion set still reproduce?", and until the export read existed the only
   * control that could answer it was `POST /exports`: the studio had to seal in
   * order to obtain an `export_id` it could then verify. Against the current
   * service that POST replays and costs nothing but a row that is not written;
   * against the one that shipped before it, every such question appended a
   * byte-identical duplicate to an append-only table and left a consumer citing
   * "the inclusion set" with several indistinguishable seals to choose between.
   *
   * So this is the control the card leads with once a seal exists, and `seal()`
   * steps back to being what it is: the act of producing a NEW one, which is
   * only meaningful after the review has moved.
   */
  async function recheckSeal(): Promise<void> {
    if (!review || !sealedExport) return;
    const target = sealedExport.export_id;
    await run('verify', async () => {
      // Cleared before the await for the same reason `seal()` clears them: what
      // is on screen describes the previous check, and the moment a new one is
      // in flight it is a claim about a result nobody has.
      verification = null;
      verificationFailure = null;
      try {
        verification = (await verifyExport(review!.review_id, target)).data;
      } catch (e) {
        verificationFailure = because(e);
        throw e;
      }
    });
  }
</script>

<!--
  WHY a lead-only control is held, said once and rendered beside each one.

  Every operation this snippet guards is `require_review_lead*` upstream, so for
  a caller who is not the creator the button was a live-looking control that
  could only ever produce a generic red `screening-error` — the same defect
  class as the dead `assign-reviewers`, and the reason `corpus-unknown`,
  `reviewers-missing` and `conflicts-not-visible` exist. It is a snippet rather
  than five hand-written paragraphs because the ARGUMENT is identical in all
  five places; only the operation differs, and that is the parameter.

  Rendered NEXT TO the control rather than once at the top of the panel: this
  page is five cards long, and a banner explaining why the export button at the
  bottom is grey scrolls out of view long before the button does.

  It names both subjects. `created_by_subject_id` is already in the payload this
  browser received, and "who organises this review" is a fact about the
  PROTOCOL — the same category as `conflicts-not-visible` — not a disposition,
  a decision or a progress count. It is also the only thing that makes the
  message actionable: knowing that somebody else must do it is useless without
  knowing who.
-->
{#snippet leadOnly(what: string, testid: string)}
  <p class="hint warn" data-testid={testid}>
    {what} requires the review lead. Evidence Review grants that to whoever created a review, and
    this one was created by <code class="code">{reviewCreator}</code> — you are acting as
    <code class="code">{actingSubject}</code>. Ask them, or work your own queue below. (A realm lead
    passes the same check, but this page is never told the caller's role, so it holds the control
    rather than guessing.)
  </p>
{/snippet}

<!--
  THE THREE BUTTONS, ONCE, so a first decision and a correction are the same
  control.

  This markup used to exist only in the `{:else}` arm of `{#if
  item.my_decision}` — i.e. only for a record nobody had decided — which is what
  made a mis-click final. Written as a snippet rather than copied because the
  two arms must not be able to drift: a correction that could not cite a reason,
  or that offered a disposition the first decision did not, would be a second
  and quieter version of the same defect.

  `supersedes` is the only difference between them, and it is what the service
  requires: a second decision at the same position is refused `409` unless it
  names the caller's CURRENT decision (`services/screening.py:690-698`).
-->
{#snippet decideControls(recordId: string, supersedes: string | null)}
  <!--
    The reviewer picks the grounds. `Exclude` used to pass
    `exclusion_reason_vocabulary[0]`, so the closed vocabulary a lead configures
    — labelled, one card up, "a decision may cite nothing else" — had exactly
    one reachable member. Every exclusion in the product cited the same reason
    whatever the reviewer thought, and the flow ledger's `exclusion_reasons`
    histogram could only ever have one key, which made it look like a unanimity
    nobody had expressed.

    Per record, not one shared control: a reviewer works down a list and each
    record has its own grounds.

    The testids exist because the browser lanes drove these by accessible name,
    so renaming a label silently turned the decide loop into a no-op that still
    passed.
  -->
  <div class="decide">
    <button
      onclick={() => decide(recordId, 'include', supersedes)}
      disabled={busy !== null}
      data-testid="decide-include"
    >
      Include
    </button>
    {#if vocabulary.length}
      <label class="reason">
        <span class="sr-only">Exclusion reason</span>
        <select
          bind:value={
            () => exclusionReason[recordId] ?? vocabulary[0],
            (v) => (exclusionReason[recordId] = v)
          }
          disabled={busy !== null}
          data-testid="exclusion-reason"
          data-record-id={recordId}
        >
          {#each vocabulary as code (code)}
            <option value={code}>{code}</option>
          {/each}
        </select>
      </label>
    {/if}
    <button
      onclick={() => decide(recordId, 'exclude', supersedes)}
      disabled={busy !== null || vocabulary.length === 0}
      data-testid="decide-exclude"
    >
      Exclude
    </button>
    <button
      onclick={() => decide(recordId, 'uncertain', supersedes)}
      disabled={busy !== null}
      data-testid="decide-uncertain"
    >
      Uncertain
    </button>
  </div>
  {#if vocabulary.length === 0}
    <!--
      Not a disabled button with no explanation. Evidence Review refuses an
      exclusion whose code is not in the locked protocol's vocabulary, and
      nothing is in an empty list (`services/screening.py:340-348`) — so an
      exclusion here is a request that can only ever come back 422. Saying why
      beats sending it.
    -->
    <p class="hint warn" data-testid="no-exclusion-vocabulary">
      This review's locked protocol names no exclusion reasons, so an exclusion cannot cite one
      and cannot be recorded. Include or Uncertain still can.
    </p>
  {/if}
{/snippet}

<section class="screening" data-testid="screening-panel">
  <header>
    <h3>Screening</h3>
    <p class="lede">
      A locked protocol, two blinded reviewers, an attributable adjudication and a hash-sealed
      inclusion set. Everything before this stage produced candidates; this is where they become
      evidence.
    </p>
  </header>

  <!--
    `tabindex="-1"` so the refusal can take FOCUS, not just be announced.

    `role="alert"` was already here and is not enough on its own: it announces
    to a screen reader while a sighted user driving the seal button five cards
    down sees nothing at all. The effect that pairs with this moves the viewport
    and the caret here; the attribute is what makes the element a legal focus
    target. `-1` rather than `0` keeps it OUT of the tab order — it is a
    destination to be sent to, not a stop on the way through the form.
  -->
  {#if error}
    <p
      class="error"
      role="alert"
      tabindex="-1"
      bind:this={errorEl}
      data-testid="screening-error"
    >
      {error}{#if errorCode}<code class="code">{errorCode}</code>{/if}
    </p>
  {/if}
  {#if notice}
    <p class="notice" data-testid="screening-notice">{notice}</p>
  {/if}

  {#if !review}
    <div class="card">
      <h4>Start a review</h4>
      <label>
        Title<span class="req" aria-hidden="true">*</span>
        <input
          bind:value={title}
          placeholder="what this systematic review is about"
          data-testid="review-title"
        />
      </label>
      <!--
        The project, which used to be the compiled-in string `dogfood`.

        Asked for rather than defaulted: see `projectId`. It is the first field
        after the title because it is the one fact about a review that cannot be
        changed afterwards and cannot be guessed.
      -->
      <label>
        Project<span class="req" aria-hidden="true">*</span>
        <input
          bind:value={projectId}
          placeholder="the project this review belongs to"
          data-testid="review-project"
        />
      </label>
      <!--
        The half of the eligibility statement that was PRE-FILLED WITH A CLAIM.

        `'hospitalised adults; randomised controlled trials'` is not a
        placeholder — it is a clinical eligibility assertion, and it was false
        for any review that is not an inpatient RCT review. It went into
        `inclusion_criteria`, into the protocol's `content_hash`, into a
        protocol locked the same second, and out through
        `protocol_content_hash` into every export sealed against it. Evidence
        Review types the field `dict[str, Any]` and refuses nothing, so this
        form is the only place it could ever have been stopped.
      -->
      <label>
        Inclusion criteria<span class="req" aria-hidden="true">*</span>
        <input
          bind:value={criteria}
          placeholder="what this protocol includes"
          data-testid="review-criteria"
        />
      </label>
      <!--
        The other half of the eligibility statement, which had no control at all
        — see `exclusionCriteria`. It sat next to this one in the payload as a
        compiled-in sentence, went into the protocol's `content_hash`, was
        locked forever a second later, and was then sealed into every inclusion
        export as `protocol_content_hash`.

        Beside Inclusion criteria rather than anywhere else, because the two
        together ARE the protocol's eligibility statement and a reader has to be
        able to see them as a pair.
      -->
      <label>
        Exclusion criteria<span class="req" aria-hidden="true">*</span>
        <input
          bind:value={exclusionCriteria}
          placeholder="what this protocol excludes"
          data-testid="review-exclusion-criteria"
        />
      </label>
      <p class="hint" data-testid="exclusion-criteria-permanent">
        Both criteria are hashed into the protocol, which is locked the moment this review is
        activated, and that hash is sealed into every inclusion export. Neither can be changed
        afterwards.
      </p>
      <label>
        Exclusion reasons (closed vocabulary — a decision may cite nothing else)
        <input bind:value={reasons} data-testid="review-reasons" />
      </label>
      <label>
        Reviewers required per record
        <select bind:value={reviewersRequired} data-testid="reviewers-required">
          <option value={1}>1 — single reviewer</option>
          <option value={2}>2 — dual blinded screening</option>
        </select>
      </label>
      <!--
        The stages this protocol will define. See `stageCount` for why the
        second one is the point: title/abstract then full text is the standard
        PRISMA shape, and the product could not express it — every review this
        studio created had exactly one stage, whatever the lead meant.

        Set at creation and not afterwards, because the protocol is locked on
        activation and the stages are materialised from it.
      -->
      <label>
        Screening stages
        <select bind:value={stageCount} data-testid="screening-stages">
          <option value={1}>1 — title/abstract only</option>
          <option value={2}>2 — title/abstract, then full text</option>
        </select>
      </label>
      <!--
        Activating locks the protocol for good, and the rationale is the
        attributable reason recorded for doing so. Editable, with a default that
        is true rather than one that describes this studio's own testing — see
        `activationRationale`.
      -->
      <label>
        Why this protocol is being locked and activated
        <input bind:value={activationRationale} data-testid="review-activation-rationale" />
      </label>
      {#if !title.trim()}
        <!--
          Same idiom as `project-required`: the button is disabled, so the
          reason is stated next to it. This field arrived pre-filled with
          `'Shadow smoke review'` — the internal name of this studio's own
          rehearsal — which is written onto the review permanently and travels
          into the provenance of every export taken against it.
        -->
        <p class="hint warn" data-testid="title-required">
          Name this review. It is recorded on the review record and travels with every export
          sealed against it.
        </p>
      {/if}
      {#if !criteria.trim()}
        <!--
          Refused for the same reason the exclusion half is, and it is the half
          the SERVICE will not refuse: `inclusion_criteria` is
          `dict[str, Any]`, so `{}`, `{"statement": ""}` and
          `{"statement": "   "}` all return 201 with four distinct permanent
          hashes. Whitespace is caught here too — `.trim()`, on both the guard
          and the value sent — because the sibling field below was trimmed and
          this one was not.
        -->
        <p class="hint warn" data-testid="inclusion-criteria-required">
          State what this protocol includes. It is hashed into the locked protocol and cannot be
          changed afterwards — and Evidence Review will accept a blank one without complaint.
        </p>
      {/if}
      {#if !projectId.trim()}
        <!--
          The same idiom as `corpus-unknown` and `reviewers-missing`: the button
          is disabled, so the reason is stated next to it. A grey rectangle with
          no explanation is the defect class this panel keeps being audited for.
        -->
        <p class="hint warn" data-testid="project-required">
          Name the project this review belongs to. It is recorded on the review permanently and
          cannot be changed afterwards.
        </p>
      {/if}
      {#if !exclusionCriteria.trim()}
        <!--
          Blank is refused here and NOT on the activation rationale, and the
          difference is the column: this one is `nullable=False` JSONB inside a
          `content_hash` that is locked on activation. A cleared box would put
          an empty eligibility statement into a protocol that can never be
          edited, and into every export sealed against it.
        -->
        <p class="hint warn" data-testid="exclusion-criteria-required">
          State what this protocol excludes. It is hashed into the locked protocol and cannot be
          changed afterwards — a review cannot record that it excluded nothing.
        </p>
      {/if}
      <div class="actions">
        <button
          onclick={startReview}
          disabled={busy !== null ||
            !projectId.trim() ||
            !title.trim() ||
            !criteria.trim() ||
            !exclusionCriteria.trim()}
          data-testid="create-review"
        >
          {busy === 'create' ? 'Locking protocol…' : 'Create, lock protocol and activate'}
        </button>
        <button class="ghost" onclick={loadReviews} disabled={busy !== null} data-testid="load-reviews">
          Load existing reviews
        </button>
      </div>
      {#if reviews.length}
        <!--
          The join point for a SECOND reviewer. One person creates and configures
          a review; everybody else assigned to it arrives here, finds it by
          title and opens it. Until these carried testids that path could not be
          driven, so every browser proof of this stage was a single reviewer
          talking to themselves — which skips conflict detection, governed
          unblinding and adjudication, i.e. most of what the stage is for.
        -->
        <ul class="reviews" data-testid="review-list">
          {#each reviews as r (r.review_id)}
            <li>
              <button
                class="link"
                onclick={() => selectReview(r)}
                data-testid="review-option"
                data-review-id={r.review_id}>{r.title}</button
              >
              <span class="badge">{r.state}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else}
    <div class="card">
      <div class="row card-head">
        <h4>{review.title}</h4>
        <!--
          The ONLY retry, so it lives where it is always reachable.

          This button used to sit inside `{#if queue}`, which made recovery
          conditional on the very thing a failed load takes away: if the reads
          fell over, `queue` stayed null, the card never rendered, and the
          panel's only remaining live control was the seal. A page that answers
          a read failure by leaving nothing but a write is worse than one that
          shows an error. Here it is rendered for any selected review, whatever
          the state of the loads.

          It is also the panel's honest busy signal: disabled exactly while
          `busy !== null`, and enabled again the moment a load settles.
        -->
        <button
          class="ghost"
          onclick={() => run('refresh', refresh)}
          disabled={busy !== null || !review}
          data-testid="refresh-screening"
        >
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <dl class="facts">
        <div><dt>State</dt><dd data-testid="review-state">{review.state}</dd></div>
        <div><dt>Revision</dt><dd>{review.revision}</dd></div>
        <div>
          <dt>Protocol</dt>
          <dd>
            {#if protocol}
              v{protocol.version_number}
              <span class="badge {protocol.locked ? 'ok' : 'warn'}">
                {protocol.locked ? 'locked' : 'draft'}
              </span>
            {:else}
              {review.active_protocol_version_id ? 'locked' : '—'}
            {/if}
          </dd>
        </div>
        <div><dt>Reviewers required</dt><dd>{review.reviewers_required ?? '—'}</dd></div>
      </dl>
      <!--
        Which stage this panel is working in — the assignment it creates, the
        queue it shows, and the decisions it records all belong to whichever one
        is selected here. See `stageIndex`.

        Rendered only when there is more than one, so a single-stage review is
        unchanged: a select with one option is a control that cannot do
        anything, and this panel is already audited for those.
      -->
      {#if stages.length > 1}
        <label>
          Screening stage
          <select
            data-testid="stage-select"
            value={String(stageIndex)}
            onchange={(e) => {
              stageIndex = Number((e.currentTarget as HTMLSelectElement).value);
              // The queue is per-stage and is read in `refresh()`; without this
              // the selection would move while the list below kept showing the
              // previous stage's records.
              void run('refresh', refresh);
            }}
          >
            {#each stages as s, i (s.stage_id)}
              <option value={String(i)}>{s.stage_order}. {s.name}</option>
            {/each}
          </select>
        </label>
      {/if}
    </div>

    <div class="card">
      <h4>Corpus</h4>
      <!--
        Say what is about to be sealed, and where it came from, BEFORE the
        consent tick is spent.

        The seal reads the discovery SESSION, while the Discover screen shows
        only the last search. For any multi-query review those two numbers
        differ, and the session number is the larger and the correct one — so
        it leads, and the screen count is the aside. A "drift warning" that
        fires on every real session is a warning nobody reads.
      -->
      {#if provenance === undefined}
        <p class="hint">
          {papers.length} candidate{papers.length === 1 ? '' : 's'} from Discover.
        </p>
      {:else if provenance.source === 'unknown' && provenance.loading}
        <!--
          A read that is STILL RUNNING is not a read that FAILED.

          `snapshotState` starts 'unread', and everything that is not 'read' or
          'none' maps to source 'unknown' — so on every first arrival at
          Screening the source is 'unknown' while `loadScreeningSnapshot()` is
          in flight. Without this branch the panel accused the discovery session
          of being unreadable for the whole duration of a full session export,
          on the happy path, and then silently healed. A reviewer who saw that
          once has already concluded the stage is broken.

          Gated on `source === 'unknown'` as well as `loading` so a re-read of
          an ALREADY-read session (arriving at Screening a second time) does not
          blank the standing provenance line and flash a hint at the reviewer.
          The seal is genuinely held while this renders — `papers` is empty, so
          `import-corpus` stays disabled — and the copy says so rather than
          leaving a silent disabled button.
        -->
        <p class="hint" data-testid="corpus-source-reading">
          Reading this discovery session… Sealing is held until the records that
          would be imported are known.
        </p>
      {:else if provenance.source === 'unknown'}
        <p class="hint warn" data-testid="corpus-source-unknown">
          This discovery session could not be read{provenance.error
            ? `: ${provenance.error}`
            : ''}. Sealing is held — importing what this screen happens to be
          showing would seal the wrong records without saying so.
          <button
            type="button"
            class="link"
            data-testid="corpus-source-reload"
            disabled={provenance.loading}
            onclick={() => provenance.reload()}
            >{provenance.loading ? 'Reading…' : 'Try again'}</button
          >
        </p>
      {:else if provenance.source === 'screen'}
        <p class="hint" data-testid="corpus-source">
          {papers.length} record{papers.length === 1 ? '' : 's'} from this screen.
          There is no discovery session, so this is the last search only — it is
          not a search strategy and the flow counts will say so.
        </p>
      {:else}
        <p class="hint" data-testid="corpus-source">
          {papers.length} record{papers.length === 1 ? '' : 's'} from this discovery
          session — every query it holds, not just the last one.
        </p>
        {#if provenance.sessionCount !== null && provenance.screenCount > provenance.sessionCount}
          <p class="hint warn" data-testid="corpus-source-drift">
            This screen is showing {provenance.screenCount}, which is more than the
            session holds. Results that were never persisted to the session will
            not be sealed.
          </p>
        {:else if provenance.screenCount !== papers.length}
          <p class="hint" data-testid="corpus-source-drift">
            This screen is showing {provenance.screenCount} from the last search.
          </p>
        {/if}
      {/if}
      <p class="hint">
        Sealing writes the membership, the count and the manifest hash in one transaction; the
        database recomputes all three at commit and refuses the write if they disagree.
      </p>
      <!--
        Arming, not confirming.

        Once a corpus exists this button stops meaning "set the corpus" and
        starts meaning "supersede the corpus", using whatever Discover is
        holding in THIS browser. That is not the same act, and it did not look
        different: a second reviewer who joined the lead's review arrived here
        with their own search results behind a button identical to the one the
        lead had clicked once, and a single stray click would add their papers
        to somebody else's review and seal a new version over it.

        A checkbox that has to be ticked on purpose costs the deliberate case
        one extra click and makes the accidental case impossible, without a
        dialog framework and without removing the ability to re-seal — which is
        a real capability, since a corpus version explicitly supersedes its
        predecessor. It is not rendered at all until there IS a corpus, so the
        first seal is still one click and the first-run path is untouched.
      -->
      {#if corpusKnowledge !== 'read'}
        <!--
          The guard FAILS SAFE.

          A guard that is keyed on a value which a failed read sets to `null`
          is not a guard: a 500 or a 403 on `GET /corpus-versions` removed the
          checkbox, collapsed the button's disable to `busy || no papers`, and
          restored the first-run label — i.e. it reopened the exact one-click
          re-seal it exists to close, and did it silently, because a missing
          guard looks identical to a review that has no corpus.

          So "there is no corpus" and "I could not find out" are answered
          differently. Not knowing holds the seal and says why, rather than
          inviting a click whose consequence is unknown.
        -->
        <p class="notice" data-testid="corpus-unknown">
          This review's sealed corpus could not be read, so this panel cannot tell whether one
          exists. Sealing is held until it can — a seal made now would supersede a corpus that may
          already be there, using whatever Discover is holding in this browser. Use Refresh to try
          the read again.
        </p>
      {:else if corpus}
        <label class="arm">
          <input type="checkbox" bind:checked={resealArmed} data-testid="reseal-arm" />
          Seal a new version, superseding the {corpus.member_count} member{corpus.member_count === 1
            ? ''
            : 's'} already sealed as v{corpus.version_number}
        </label>
      {/if}
      <!--
        `import_payload` and `seal_corpus_version` are both
        `require_review_lead_for` (`services/imports.py:118,344`), so for a
        non-creator this button is two writes that can only be refused. The arm
        checkbox above is a SEPARATE guard against a different accident — a
        deliberate re-seal by somebody who IS entitled to make one — and neither
        substitutes for the other: arming it changes nothing about authority.
      -->
      {#if notReviewCreator}
        {@render leadOnly('Importing records and sealing a corpus', 'corpus-lead-only')}
      {/if}
      <button
        onclick={importFromDiscover}
        disabled={busy !== null ||
          papers.length === 0 ||
          corpusKnowledge !== 'read' ||
          notReviewCreator ||
          (corpus !== null && !resealArmed)}
        data-testid="import-corpus"
      >
        {busy === 'import'
          ? 'Importing…'
          : corpusKnowledge !== 'read'
            ? 'Corpus unknown — sealing held'
            : corpus
              ? `Import and seal v${corpus.version_number + 1}`
              : 'Import and seal corpus'}
      </button>
      {#if batch}
        <dl class="facts">
          <div><dt>Accepted</dt><dd data-testid="accepted-count">{batch.accepted_count}</dd></div>
          <div><dt>Quarantined</dt><dd>{batch.quarantined_count}</dd></div>
          <div><dt>Payload digest</dt><dd class="mono">{batch.raw_payload_digest.slice(0, 23)}…</dd></div>
        </dl>
        <!--
          WHICH DOCUMENT WAS SEALED, said out loud.

          `raw_payload_digest` above is the same number on both paths, so it
          cannot answer this on its own — and the difference is the whole
          provenance claim. A frozen batch is a document the engine stored and
          Evidence Review fetched and re-hashed; a fallback is bytes this tab
          built, which nothing can replay. Leaving that to inference is how the
          browser stayed in the data path unnoticed for as long as it did.
        -->
        {#if frozenBatch}
          <p class="notice" data-testid="corpus-from-frozen-batch">
            Sealed from the frozen batch <span class="mono">{citedBatchId}</span>, taken from this
            Discover session and fetched by Evidence Review itself — {frozenBatch.record_count}
            record{frozenBatch.record_count === 1 ? '' : 's'}, digest
            <span class="mono">{frozenBatch.digest.slice(0, 23)}…</span>. No record passed through
            this browser, and the import was refused unless the two digests agreed.
          </p>
          {#if replayedAnEarlierTaking}
            <!--
              A REPLAY IS NOT A SECOND IMPORT, and the card used to hide that.

              Re-taking an unchanged session produces byte-identical bytes — that
              is exactly what discovery-engine #58 removed `taken_at` to
              guarantee — so `POST review-export` mints a NEW batch id while
              Evidence Review, keyed on the digest, answers `replayed: true` and
              returns the FIRST batch's record. This card was rendering the
              receipt this browser had just been handed, so it asserted a batch
              id that the sealed record does not cite. It now names the record's
              own citation and says why the two differ.
            -->
            <p class="notice" data-testid="corpus-replayed-earlier-taking">
              This taking was byte-identical to an earlier one, so Evidence Review replayed that
              import rather than making a second. The corpus cites the earlier batch above; the
              batch just taken (<span class="mono">{frozenBatch.batch_id}</span>) is a second
              receipt for the same document.
            </p>
          {/if}
        {:else}
          <p class="notice" data-testid="corpus-from-this-browser">
            Sealed from the records this browser was holding — there was no Discover session to
            freeze. The corpus is what was on screen, so it cannot be replayed from the engine.
          </p>
        {/if}
      {/if}
      {#if corpus}
        <dl class="facts">
          <div><dt>Members sealed</dt><dd data-testid="corpus-members">{corpus.member_count}</dd></div>
          <div><dt>Manifest</dt><dd class="mono" data-testid="corpus-manifest">{corpus.member_manifest_hash.slice(0, 23)}…</dd></div>
        </dl>
      {/if}
      <!--
        WHAT THE IMPORT DROPPED, listed rather than counted.

        `listQuarantine` shipped in this client with zero callers anywhere in
        the frontend, while the count rendered twice — on this card and in the
        flow ledger. Evidence Review built the route for exactly this situation
        and stated why in its own docstring (`api/routers/imports.py:566-567`):
        "`ER-009.3` — an omission must be explicit. A quarantine count with no
        way to see what was quarantined presents a filtered corpus as a complete
        one."

        Behind a disclosure because on a healthy import there is nothing here
        and a reviewer should not have to scroll past an empty list; visible at
        all times when there IS something, because the count alone is precisely
        the failure named above.
      -->
      {#if quarantineKnowledge === 'unreadable'}
        <p class="notice" data-testid="quarantine-unknown">
          This review's quarantined rows could not be read, so this panel cannot say whether the
          import dropped anything. Whatever was dropped is still missing from the corpus. Use
          Refresh to retry.
        </p>
      {:else if quarantine.length}
        <p class="hint warn">
          <span data-testid="quarantine-count">{quarantine.length}</span>
          row{quarantine.length === 1 ? '' : 's'} could not be turned into a record and
          {quarantine.length === 1 ? 'is' : 'are'} not in the corpus, the counts or any export.
          <button
            type="button"
            class="link"
            onclick={() => (quarantineOpen = !quarantineOpen)}
            data-testid="quarantine-disclosure"
          >
            {quarantineOpen ? 'Hide them' : 'Show what was dropped'}
          </button>
        </p>
        {#if quarantineOpen}
          <!--
            The ORIGINAL BYTES, because they are the only thing that identifies
            a quarantined row. It never became a review record, so it has no
            title, no DOI and no version — a list of opaque ids beside a reason
            would be the count again with extra steps.
          -->
          <ul class="quarantine" data-testid="quarantine-rows">
            {#each quarantine as row (row.import_row_id)}
              <li data-testid="quarantine-row">
                <span class="badge warn">{row.quarantine_reason ?? 'reason not recorded'}</span>
                {#if row.row_index !== undefined}
                  <span class="meta">row {row.row_index}</span>
                {/if}
                <code class="code raw">{JSON.stringify(row.raw_representation ?? null)}</code>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>

    <div class="card">
      <h4>Duplicates</h4>
      <p class="hint">
        Exact identifier and normalized title+year. The engine proposes; a merge is only ever
        recorded by a person, and it is reversed by adding a new row rather than editing this one.
      </p>
      <!--
        The cross-repo regression this file was reopened for.

        `evidence_review_service` PR #13 moved BOTH writes on this card from
        `require_human` to `require_review_lead_for`
        (`services/deduplication.py:82` and `:221`). Measured against the merged
        service: as the review's creator `POST /deduplication-runs` reaches the
        corpus check (404, "no sealed corpus version"); as any other subject it
        returns 403 "starting a deduplication run requires the review lead role,
        or having created this review". The same call returned 201 on the
        previous service version.

        `GET /api/reviews` lists reviews this caller did not create, and
        `selectReview` makes every one of them selectable, so a joined reviewer
        sat in front of two enabled buttons whose only possible outcome was a
        generic red error and no next step. Both are held together because both
        are the same gate — holding only the one that starts a run would leave
        `merge-cluster` live over any clusters an earlier run had left behind.
      -->
      {#if notReviewCreator}
        {@render leadOnly('Comparing a corpus and recording a merge', 'dedupe-lead-only')}
      {/if}
      <button
        onclick={dedupe}
        disabled={busy !== null || !corpus || notReviewCreator}
        data-testid="run-dedupe"
      >
        {busy === 'dedupe' ? 'Comparing…' : 'Find duplicates'}
      </button>
      {#if clusters.length}
        <ul class="clusters">
          {#each clusters as cluster (cluster.cluster_id)}
            <li>
              <div class="cluster-members">
                {#each cluster.members as m (m.review_record_id)}
                  <span class="member">{m.title ?? '(untitled)'} <code class="code">{m.doi ?? '—'}</code></span>
                {/each}
              </div>
              {#if cluster.current_resolution}
                <span class="badge ok" data-testid="cluster-resolution">
                  {cluster.current_resolution.resolution_type}
                </span>
              {:else}
                <!-- `resolve_cluster` is `require_review_lead_for` too — see the card note above. -->
                <button
                  onclick={() => merge(cluster)}
                  disabled={busy !== null || notReviewCreator}
                  data-testid="merge-cluster"
                >
                  Merge
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if dedupIsStale}
        <!--
          The re-seal state, and the reason this card needed a third answer.

          Gating on "has anything ever been compared?" was not enough. With
          corpus [v1 (2 members, deduped), v2 (9 members, never deduped)] the
          run list is non-empty and `listClusters` — asked without a
          `dedup_run_id` — answers with v1's clusters, so the card stated "No
          duplicate clusters proposed." beside a `corpus-members` of 9: an
          answer about v1 presented as an answer about v2.

          Neither of the other two lines is true here. There ARE clusters in the
          database and they are not about this corpus; there is no comparison of
          this corpus to report. So it says that, rather than picking whichever
          existing sentence is less wrong.
        -->
        <p class="hint warn" data-testid="dedup-stale">
          Not compared since the corpus was re-sealed. The last comparison was made against
          {lastComparedVersion === null ? 'an earlier version' : `v${lastComparedVersion}`}; these
          {corpus?.member_count} members have not been compared. Run it again to get an answer about
          this corpus.
        </p>
      {:else if runForCorpus}
        <!--
          Gated on a deduplication run existing FOR THIS CORPUS, not on there
          being a corpus and not on there being any run at all.

          Keyed on `corpus` this line appeared the instant the corpus was
          sealed, before the engine had compared anything — an answer stated on
          behalf of a computation nobody had run. It is the server's run list
          rather than a flag set by `dedupe()`, so it survives the stepper
          unmounting this stage; and `clusters` is fetched for THIS run's id, so
          "none proposed" can never be shown over clusters belonging to another.
        -->
        <p class="hint" data-testid="no-duplicates">No duplicate clusters proposed.</p>
      {/if}
    </div>

    <div class="card">
      <h4>Reviewers</h4>
      <p class="hint">
        Both reviewers see every record. Neither can see the other's decision — enforced in the
        database, not in this page.
      </p>
      <!--
        The second field is not optional when the stage says it is not.

        `reviewers_required` defaults to 2 — dual blinded screening, which is
        what this stage is for — and the panel prefills only reviewer A from the
        signed-in user. So the default configuration put one name in front of the
        user, called the second field "Reviewer B" as though it were a spare, and
        sent the request anyway: `422 unprocessable_state: "this stage requires
        2 reviewers; 1 were named"`. The count was in the stage the whole time;
        the page simply never said it.
      -->
      <div class="row">
        <label>
          Reviewer A{#if requiredReviewers > 1}<span class="req" aria-hidden="true">*</span>{/if}
          <input bind:value={reviewerA} data-testid="reviewer-a" />
        </label>
        <label>
          Reviewer B{#if requiredReviewers > 1}<span class="req" aria-hidden="true">*</span>{/if}
          <input bind:value={reviewerB} data-testid="reviewer-b" />
        </label>
      </div>
      {#if requiredReviewers > 1}
        <p class="hint" data-testid="reviewers-required-hint">
          This stage screens every record {requiredReviewers} times, so it needs
          {requiredReviewers} reviewers. {namedReviewers.length} named.
        </p>
      {/if}
      <!--
        THE DEADLOCK, named before it is walked into.

        Reviewer A is prefilled with the signed-in user, and assignment is
        lead-only — so the default arrangement on this card is the lead
        screening their own dual review. If they then disagree with reviewer B,
        the conflict that opens cannot be adjudicated by anyone: the
        separation-of-duty trigger refuses any adjudicator who decided in that
        conflict, and there is one holder of `review-lead`. Nothing blocks,
        because consensus resolution lets the run reach a sealed export anyway —
        it just quietly removes adjudication from the review.

        A warning rather than a refusal, and only where a conflict is reachable.
        The full argument is on `prefilled`; the short form is that a
        single-reviewer review is a supported configuration in which none of
        this can happen, and that a tenant with two leads can adjudicate this
        perfectly well.
      -->
      {#if actingIsNamedReviewer}
        <p class="hint warn" data-testid="reviewer-is-lead">
          You are named as a reviewer of a review you organise. Screening it yourself is allowed,
          but if you disagree with the other reviewer, nobody will be able to adjudicate the
          conflict — a reviewer may not adjudicate a disagreement they are party to, and this review
          has one lead. The record would be settled by consensus instead, and the export would go
          out with no adjudication on it. Name somebody else as
          <code class="code">Reviewer {reviewerA.trim() && leadIdentities.includes(reviewerA.trim())
            ? 'A'
            : 'B'}</code>, or set this stage to a single reviewer if you mean to screen it alone.
        </p>
      {/if}
      <!--
        A subject id that cannot be a Keycloak `sub`.

        `create_assignments` does not check that a named subject exists or is in
        the tenant, so a typo is accepted, an assignment is written against
        nobody, and the stage waits forever on a reviewer who never appears.
        Shape is the only check available on this surface — see
        `malformedReviewers` for why this warns rather than refuses.
      -->
      {#if malformedReviewers.length}
        <p class="hint warn" data-testid="reviewer-subject-malformed">
          {malformedReviewers.join(' and ')}
          {malformedReviewers.length === 1 ? 'does' : 'do'} not look like a reviewer subject id,
          which is the UUID Keycloak issues as <code class="code">sub</code>. Evidence Review does
          not check that a named subject exists, so a mistyped one is accepted silently and produces
          a reviewer who never appears and a stage that can never complete.
        </p>
      {/if}
      <!--
        WHY the button is dead, in the one case where nothing else says.

        `assign-reviewers` is disabled by four different conditions and they all
        rendered as the same grey rectangle. Two of them already explain
        themselves elsewhere — a busy panel says `Assigning…` on the button, and
        an unknown corpus has the `corpus-unknown` prose one card up — but "not
        enough reviewers named" said nothing at all.

        That is the same defect class this panel is being fixed for, and it bit
        hardest on the RE-JOIN path (#787): a lead who leaves the stage and comes
        back gets a fresh component, so reviewer A is prefilled from the
        signed-in user and reviewer B is blank. Assignment is genuinely
        reachable — type a second name — but the page gave no clue that was what
        it was waiting for, which is indistinguishable from the pre-#787 bug
        where it was not reachable at all. A live dual drive went red here.

        Points at the BLANK FIELD, not at the count: the count is already stated
        above, and "Reviewer B is blank" is the thing the user can act on.
      -->
      {#if !enoughReviewers && corpusKnowledge === 'read' && stage}
        <p class="hint warn" data-testid="reviewers-missing">
          {#if namedReviewers.length === 0}
            Name {requiredReviewers === 1 ? 'a reviewer' : `${requiredReviewers} reviewers`} to
            assign. Both fields are blank.
          {:else}
            {reviewerA.trim() ? 'Reviewer B' : 'Reviewer A'} is blank — this stage cannot be assigned
            until {requiredReviewers} reviewers are named.
          {/if}
        </p>
      {/if}
      <!--
        `create_assignments` has been `require_review_lead` since before this
        panel existed (`services/screening.py:149`), and the button said nothing
        about it: for a non-creator, filling both fields correctly still bought
        a 403. Ordered AFTER `reviewers-missing` so a lead who is merely a name
        short still reads the actionable message first — this one is not
        actionable by them at all.
      -->
      {#if notReviewCreator}
        {@render leadOnly('Assigning reviewers to a stage', 'assign-lead-only')}
      {/if}
      <!--
        WHICH SCREENING PASS this stage is on — the concept the studio did not
        have at all.

        A round is one screening pass over ONE sealed corpus version, bound on
        every assignment row and impossible to re-point
        (`services/screening.py:265-323`). Nothing in this frontend named it, so
        every call took the service default of 1 — and this panel has its own
        armed control for sealing a v2, after which round 1 keeps serving v1's
        text and the export is refused forever.

        Rendered here rather than on the queue card because this is where the
        round is actually chosen, and because the queue card disappears when
        there is nothing assigned — which is exactly the state a wrong round
        produces.
      -->
      {#if stage}
        <p class="hint" data-testid="screening-round">
          Screening round <strong>{roundNumber}</strong>{#if queue && queue.round_number !== roundNumber}&nbsp;— the
            queue answered for round {queue.round_number}{/if}. A round screens one sealed corpus
          version; re-sealing the corpus needs a new round, because assignments are append-only.
        </p>
      {/if}
      <!--
        THE REFUSAL, RENDERED AS THE NEXT ACTION.

        `create_assignments` answers `409` when the round already holds a
        different corpus, and names the round that is free
        (`screening.py:310-323`). That number reaches the browser only inside
        the problem detail, and until this control existed there was no way to
        act on it: the studio showed a red sentence containing a round number
        and had no field that could set one.
      -->
      {#if boundRound}
        <p class="hint warn" data-testid="round-bound-elsewhere">
          Round {boundRound.round} of this stage is already screening
          {#if boundRound.corpora.length}
            corpus version <code class="code">{boundRound.corpora.join(', ')}</code>
          {:else}
            a different corpus version
          {/if}, and assignments are append-only — so it cannot be pointed at the corpus above.
          Screening this corpus is a NEW pass over it, which is what round {boundRound.next} is.
          The reviewers named above are unchanged.
        </p>
        <button
          onclick={screenAsNextRound}
          disabled={busy !== null || notReviewCreator}
          data-testid="screen-as-next-round"
        >
          {busy === 'assign' ? 'Assigning…' : `Screen this corpus as round ${boundRound.next}`}
        </button>
      {/if}
      <button
        onclick={assign}
        disabled={busy !== null || !corpus || !stage || !enoughReviewers || notReviewCreator}
        data-testid="assign-reviewers"
      >
        {busy === 'assign'
          ? 'Assigning…'
          : requiredReviewers > 1
            ? `Assign ${requiredReviewers} reviewers`
            : 'Assign reviewer'}
      </button>
      <!--
        The response was being thrown away. Assigning decides who is answerable
        for which records — the most consequential write on this page — and it
        reported nothing at all, so a lead who had just put two people on forty
        records saw exactly what a lead who had mistyped a subject id saw. The
        API already returns both counts; shown here the way the Corpus card
        shows the ones the seal returns, rather than as a notice, because
        `notice` is cleared by the next action and this is a standing fact about
        the review.
      -->
      {#if assignment}
        <dl class="facts">
          <div>
            <dt>Assignments created</dt>
            <dd data-testid="assignments-created">{assignment.assignments_created}</dd>
          </div>
          <div>
            <dt>Records covered</dt>
            <dd data-testid="assignment-records">{assignment.records}</dd>
          </div>
          {#if assignment.assignments_existing}
            <!--
              `0 created` alone cannot tell "every row was already there" from
              "the insert never ran", and the second is what a re-point looked
              like before the service started refusing it.
            -->
            <div>
              <dt>Already assigned</dt>
              <dd data-testid="assignments-existing">{assignment.assignments_existing}</dd>
            </div>
          {/if}
        </dl>
        <!--
          THE ROUND'S OWN CORPUS, when it is not the one on screen.

          `create_assignments` reports the corpus the round HOLDS, read back out
          of `screening_assignments` rather than echoed from the request
          (`screening.py:406`) — and this is the only place the studio can learn
          it, because the queue body names no corpus at all. Without this line
          the panel can be in the state where the card above says v2, the queue
          serves v1's text, and nothing distinguishes them.
        -->
        {#if corpus && assignment.corpus_version_id && assignment.corpus_version_id !== corpus.corpus_version_id}
          <p class="hint warn" data-testid="queue-corpus-mismatch">
            Round {assignment.round_number} holds corpus version
            <code class="code">{assignment.corpus_version_id}</code>, not the v{corpus.version_number}
            sealed above — so the queue below is serving the earlier corpus's text, and an export
            of this review would be refused until the current corpus has been screened in a round
            of its own.
          </p>
        {/if}
      {/if}
    </div>

    {#if queue}
      <div class="card" data-testid="screening-queue">
        <!--
          Everything on this panel refreshed only as a side effect of an action
          the CURRENT person took. A lead who assigns two reviewers and waits is
          the normal case, and for them nothing ever changed: the conflicts
          their reviewers opened, and the progress those reviewers made,
          appeared only if the lead happened to click something that reloaded.
          There was no way to ask. The Refresh that answers it is now on the
          review header card, where it survives a failed load — see there.
        -->
        <h4>Your queue</h4>
        <p class="hint" data-testid="queue-progress">
          <span data-testid="decided-by-me">{queue.decided_by_me}</span> of
          <span data-testid="assigned-to-me">{queue.assigned_to_me}</span> assigned to you
          <!--
            The badge was dead markup: `subject` was declared, never passed by
            the only caller, and so always `''`. In the three-context dual drive
            nothing on screen distinguished the reviewers at all.

            `queue?.acting_subject_id` first, because it is the only trustworthy
            answer — the identity the SERVICE bound the session to. The browser's
            own identity is a fallback, and an honest one: under `AUTH_BYPASS`,
            or behind an edge that stamps `X-Subject-Id`, the two can differ and
            the page cannot see it. Evidence Review does not return the field
            yet, so today this always renders the fallback; that is why nothing
            asserts on `acting_subject_id`.
          -->
          {#if actingSubject}
            <span class="badge" data-testid="acting-subject">acting as {actingSubject}</span>
          {/if}
        </p>
        {#if queue.incomplete}
          <!--
            The queue reader pages until `next_cursor` is null, but the traversal
            is BOUNDED — an unbounded loop over a cursor the server chooses is a
            hang, and a browser-side retry storm when the cursor stops advancing.
            When a bound is hit, the list above is a prefix and this says so.

            Silence here would be the original defect exactly: before paging, a
            reviewer with 51 assignments was shown 50 records and nothing at all
            to indicate the other one existed. Trading a cut at 50 for a cut at
            5,000 without saying so would be the same bug, just rarer and
            therefore harder to notice.
          -->
          <p class="hint" data-testid="queue-truncated">
            Showing {queue.count} of your {queue.assigned_to_me} assigned records — {queue.incomplete
              .reason === 'cursor_not_advancing'
              ? 'the service repeated a page instead of advancing, so reading stopped'
              : `reading stopped after ${queue.incomplete.pages} pages`}. The rest are not on this
            page and have not been screened; refresh, and report this if it persists.
          </p>
        {/if}
        {#if canScreen}
          <ul class="queue">
            {#each queue.items as item (item.assignment_id)}
              <li>
                <!--
                  THE ABSTRACT, AND A DOI YOU CAN OPEN.

                  This was a title, a year, a container and a `<code>` DOI —
                  and then three buttons asking for a verdict at a stage called
                  "Title/abstract". `QueueItem.abstract` was typed, served and
                  fetched on every page, and rendered nowhere. See
                  `QueueRecord.svelte` for why title-only screening is a
                  different instrument rather than a smaller one.
                -->
                <QueueRecord {item} />
                {#if item.my_decision}
                  <span class="badge ok" data-testid="my-decision">{item.my_decision.disposition}</span>
                  <!--
                    THE ONLY WAY BACK FROM A MIS-CLICK, and it was not here.

                    This arm rendered the badge and stopped, so the three
                    buttons vanished the instant a decision landed. There was no
                    control that could even provoke the `409` which hands back
                    `current_decision_id`, and `supersedes_decision_id` — a
                    declared parameter on `recordDecision` — was referenced
                    nowhere in the studio.

                    That is not a missing convenience. A wrong decision both
                    reviewers happen to share opens no conflict at all, and one
                    they disagree on leaves the record `not_yet_screened`, which
                    refuses the export permanently (`flow.py:736`). Evidence
                    Review supports the correction in full; only the browser did
                    not.

                    Opt-in per record, so a decided record still reads as
                    decided and the ordinary path down the list is unchanged.
                  -->
                  {#if correcting[item.review_record_id]}
                    <div class="correction" data-testid="decision-correction">
                      <p class="hint">
                        Recording a different decision SUPERSEDES the one above rather than
                        editing it — both stay in the review's history, attributed and in order,
                        and the new one becomes the current answer at this position.
                      </p>
                      {@render decideControls(
                        item.review_record_id,
                        item.my_decision.decision_id,
                      )}
                      <button
                        type="button"
                        class="link"
                        onclick={() => delete correcting[item.review_record_id]}
                        disabled={busy !== null}
                        data-testid="keep-decision"
                      >
                        Keep this decision
                      </button>
                    </div>
                  {:else}
                    <button
                      type="button"
                      class="link"
                      onclick={() => (correcting[item.review_record_id] = true)}
                      disabled={busy !== null}
                      data-testid="change-decision"
                    >
                      Change decision
                    </button>
                  {/if}
                {:else}
                  {@render decideControls(item.review_record_id, null)}
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="hint">Nothing assigned to you in this stage.</p>
        {/if}
      </div>
    {/if}

    {#if conflictsKnowledge === 'forbidden'}
      <!--
        A designed answer for a non-lead, not an error and not an empty list.

        `GET /conflicts` is `require_review_lead`, so a reviewer is refused 403.
        That used to land in `refresh()`'s aggregate failure and put "Could not
        read conflicts (…)" in front of every reviewer on every refresh — an
        error about something they were never entitled to see.

        One line rather than the card, because there is nothing here to act on.
        It discloses nothing a reviewer should not know: not whether any
        conflict exists, not who disagreed, not any disposition. "Somebody
        adjudicates disagreements and it is not me" is a fact about the
        PROTOCOL, which the lead configured and every reviewer is screening
        under — unlike the conflict contents, which stay redacted even from the
        lead until an unblinding is recorded.
      -->
      <p class="hint" data-testid="conflicts-not-visible">
        Disagreements are resolved by the review lead; conflicts are not visible to reviewers.
      </p>
    {:else if conflictsKnowledge === 'unreadable'}
      <!--
        A STANDING indicator for a read that broke, in the `corpus-unknown`
        idiom.

        `conflictsKnowledge` declares four states and this template branched on
        exactly one of them, so `unreadable` had no indicator at all. The
        aggregate error from `refresh()` does fire — and a spec asserts it — but
        `run()` clears `error` at the start of every action, so the one-shot
        message is erased by the next click while the panel stays stale. The
        lead is then looking at an empty conflicts area that means "I could not
        find out", presented exactly like "there are none".

        Deliberately NOT the `forbidden` sentence: a fault must never be
        reclassified as a permissions boundary. That direction is the worse
        error, because it reads as the service working correctly.
      -->
      <p class="notice" data-testid="conflicts-unknown">
        This review's conflicts could not be read, so this panel cannot tell whether any
        disagreements are open. Any that exist still block the export, and adjudicating is held
        until the list can be read again. Use Refresh to retry.
      </p>
    {:else if conflicts.length}
      <div class="card">
        <h4>Conflicts</h4>
        {#if conflictTotals && (conflictTotals.has_more || conflictTotals.total_open > conflicts.filter((c) => !c.resolved).length)}
          <!--
            The page is not the review. `POST /exports` gates on EVERY unresolved
            conflict, so a lead who adjudicates what is on screen and then reads
            "0 open" here gets a 422 from the export with nothing to explain it.
            Both numbers are the server's, and the banner appears only when they
            actually disagree with what is rendered.
          -->
          <p class="hint" data-testid="conflicts-truncated">
            Showing {conflicts.length} of {conflictTotals.total} conflicts.
            {conflictTotals.total_open} still need adjudication across the whole review — the export
            is refused until every one is resolved, not just the ones on this page.
          </p>
        {/if}
        <ul class="conflicts">
          {#each conflicts as conflict (conflict.conflict_id)}
            <li data-testid="conflict-row" data-conflict-id={conflict.conflict_id}>
              <div class="record">
                <strong>{conflict.title ?? '(untitled)'}</strong>
                <span class="meta" data-testid="conflict-dispositions">
                  {#if conflict.dispositions === 'redacted'}
                    <span class="badge warn" data-testid="dispositions-redacted">
                      dispositions redacted until unblinded
                    </span>
                  {:else if conflict.dispositions.length === 0}
                    <!--
                      Unblinded, and the service returned nothing. "0 decisions
                      visible" reads as a count of a thing; this is the ABSENCE
                      of the thing the unblinding existed to reveal, which is a
                      defect worth seeing rather than a tidy zero.
                    -->
                    <span class="badge warn" data-testid="dispositions-empty">
                      unblinded, but the service returned no decisions
                    </span>
                  {:else}
                    {conflict.dispositions.length} decisions visible
                  {/if}
                </span>
                <!--
                  WHAT the unblinding revealed, not merely THAT it happened.

                  Unblinding is a deliberate, recorded, irreversible act: a lead
                  lifts two reviewers' blinding and the service writes a
                  `screening_unblinding_events` row for it. The panel then said
                  "2 decisions visible" and stopped — naming the count of a
                  thing it declined to show. `to_public()` had been returning
                  both dispositions in full the whole time
                  (`blinded_reads.py:143-158`); only the render was missing.

                  This sits INSIDE `.record` (a column) so the summary line
                  above stays the one-line answer and this is the detail under
                  it. `.conflicts li` is `space-between`, so it also had to join
                  the `flex-wrap` group below — same squeeze a queue row already
                  hit.
                -->
                {#if conflict.dispositions !== 'redacted' && conflict.dispositions.length > 0}
                  {@const dispositions = conflict.dispositions}
                  <div class="dispositions" data-testid="conflict-disposition-list">
                    {#each dispositions as d}
                      <!--
                        Deliberately UNKEYED. `decision_id` is the obvious key
                        and it is the wrong one: existing fixtures carry
                        `{ disposition: 'include' }` with no id at all, and
                        Svelte 5 throws on an undefined key. An unkeyed each
                        renders those as the fallbacks below, which is correct.
                      -->
                      <div class="disposition" data-testid="conflict-disposition">
                        <span class="badge {d.disposition === 'include' ? 'ok' : 'warn'}">
                          {d.disposition}
                        </span>
                        {#if d.exclusion_reason_code}
                          <code class="code">{d.exclusion_reason_code}</code>
                        {/if}
                        <!--
                          Attributed only when the service chose to attribute it
                          (`blinded_reads.py:156-157` adds `reviewer_subject_id`
                          for a lead who does not owe a decision here). Absent is
                          said as "not disclosed" rather than rendered blank,
                          which would read as an unattributed decision.
                        -->
                        <code class="code" data-testid="disposition-reviewer">
                          {d.reviewer_subject_id ?? 'reviewer not disclosed'}
                        </code>
                        <span data-testid="disposition-rationale">
                          {d.rationale ?? 'not recorded'}
                        </span>
                        <span class="small">{fmtDate(d.decided_at)}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
              {#if conflict.resolved}
                <!--
                  HOW it stopped being open, not merely THAT it did.

                  `conflict.adjudication` was declared in `reviews.ts` and read
                  in zero places, so a lead typed a permanent, attributable
                  rationale for settling a disagreement and the product never
                  rendered it again anywhere. Worse, the badge here said
                  "adjudicated" for every resolved conflict — including the ones
                  that closed because the reviewers came to AGREE, where no lead
                  ruled at all and `adjudication` is null. That names a decision
                  nobody made.

                  Three arms, because the field is a tri-state and each one is a
                  different fact — the same shape `dispositions` already has,
                  and for the same reason: the service answers the literal
                  `"redacted"` when the caller still owes their own decision at
                  that position, and collapsing that into null would tell a
                  reviewer the disagreement is unsettled when it is settled
                  against them.
                -->
                {#if conflict.adjudication === 'redacted'}
                  <span class="badge warn" data-testid="adjudication-redacted">
                    settled by the lead — the ruling is withheld until you record your own decision
                    on this record
                  </span>
                {:else if conflict.adjudication}
                  {@const ruling = conflict.adjudication as Adjudication}
                  <span class="badge ok" data-testid="conflict-resolved">adjudicated</span>
                  <dl class="facts" data-testid="adjudication-summary">
                    <div>
                      <dt>Ruling</dt>
                      <dd>
                        {ruling.disposition}{#if ruling.exclusion_reason_code}&nbsp;<code
                            class="code">{ruling.exclusion_reason_code}</code
                          >{/if}
                      </dd>
                    </div>
                    <div>
                      <dt>Grounds</dt>
                      <!--
                        The sentence the lead typed. `null` is possible on an
                        older row and is said as such rather than rendered as an
                        empty cell, which would read as "they gave none".
                      -->
                      <dd data-testid="adjudication-grounds">
                        {ruling.rationale ?? 'not recorded'}
                      </dd>
                    </div>
                    <div>
                      <dt>By</dt>
                      <dd>
                        <!--
                          Name if the service could derive one, else the subject
                          id, else nothing was recorded. The id stays the
                          evidentiary attribution — the name is a label on top of
                          it — and every row written before the column existed
                          falls through to the id permanently, because
                          `screening_adjudications` is append-only and cannot be
                          backfilled.
                        -->
                        <code class="code" data-testid="adjudicator">
                          {ruling.adjudicator_display_name ??
                            ruling.adjudicator_subject_id ??
                            'unattributed'}
                        </code>
                      </dd>
                    </div>
                  </dl>
                {:else}
                  <!--
                    Resolved with NO adjudication row: the reviewers converged,
                    consensus resolution closed it (`services/flow.py:1049-1105`)
                    and no lead ever ruled. Calling that "adjudicated" is the
                    claim this branch exists to stop making.
                  -->
                  <span class="badge ok" data-testid="conflict-consensus">
                    settled by consensus — the reviewers agreed, no lead ruling was needed
                  </span>
                {/if}
              {:else}
                <!--
                  The adjudication is the decision that settles the
                  disagreement and stands as the record's own. Citing
                  `vocabulary[0]` made the lead's stated grounds a fiction — the
                  same defect as the queue's Exclude, in the place where it
                  matters most.
                -->
                {#if !conflict.unblinded}
                  <!--
                    WHO the unblinding discloses to, and it only appears while
                    the conflict is still blinded — the audience is written onto
                    the unblinding event and the event is append-only, so after
                    the fact there is nothing this box could change. Rendering it
                    anyway would be a control that silently does nothing, which
                    is the class of defect this panel keeps being audited for.

                    Empty is a real answer, not an unset one: the disclosure goes
                    to the acting lead alone. Said in the hint rather than left
                    to be discovered, because the reviewers NOT being able to see
                    what they disagreed about is the surprising half.
                  -->
                  <label class="disclose">
                    <span class="sr-only">Disclose this unblinding to</span>
                    <input
                      type="text"
                      placeholder="Disclose to (optional): reviewer subject ids, separated by commas"
                      bind:value={
                        () => discloseTo[conflict.conflict_id] ?? '',
                        (v) => (discloseTo[conflict.conflict_id] = v)
                      }
                      disabled={busy !== null}
                      data-testid="disclose-to"
                    />
                    <span class="hint" data-testid="disclose-to-hint">
                      Leave empty and only you will see the dispositions. Named reviewers see what
                      was decided, never who decided it.
                    </span>
                  </label>
                {/if}
                <!--
                  THE GROUNDS, in the lead's own words, before either button
                  will fire.

                  This was a constant in the component
                  (`'lead adjudication from the research studio'`), written into
                  an append-only row as the attributable reason a disagreement
                  was settled. Every adjudication in the product carried the
                  same sentence.

                  Required, unlike the merge and unblinding rationales, because
                  no accurate default exists: the grounds depend on what the two
                  reviewers disagreed about, which is the one thing this
                  component cannot know.
                -->
                <label class="disclose">
                  <span class="sr-only">Grounds for this adjudication</span>
                  <input
                    type="text"
                    placeholder="Grounds for this adjudication — recorded permanently against the record"
                    bind:value={
                      () => adjudicationRationale[conflict.conflict_id] ?? '',
                      (v) => (adjudicationRationale[conflict.conflict_id] = v)
                    }
                    disabled={busy !== null}
                    data-testid="adjudication-rationale"
                    data-conflict-id={conflict.conflict_id}
                  />
                </label>
                {#if !(adjudicationRationale[conflict.conflict_id] ?? '').trim()}
                  <p class="hint warn" data-testid="adjudication-rationale-required">
                    An adjudication settles this record for good and cannot be explained
                    afterwards. State the grounds before recording it.
                  </p>
                {/if}
                <div class="decide">
                  <button
                    onclick={() => unblindAndAdjudicate(conflict, 'include')}
                    disabled={busy !== null ||
                      !(adjudicationRationale[conflict.conflict_id] ?? '').trim()}
                    data-testid="adjudicate-include"
                  >
                    {conflict.unblinded ? 'Include' : 'Unblind & include'}
                  </button>
                  {#if vocabulary.length}
                    <label class="reason">
                      <span class="sr-only">Adjudication exclusion reason</span>
                      <select
                        bind:value={
                          () => adjudicationReason[conflict.conflict_id] ?? vocabulary[0],
                          (v) => (adjudicationReason[conflict.conflict_id] = v)
                        }
                        disabled={busy !== null}
                        data-testid="adjudication-reason"
                        data-conflict-id={conflict.conflict_id}
                      >
                        {#each vocabulary as code (code)}
                          <option value={code}>{code}</option>
                        {/each}
                      </select>
                    </label>
                  {/if}
                  <button
                    onclick={() => unblindAndAdjudicate(conflict, 'exclude')}
                    disabled={busy !== null ||
                      vocabulary.length === 0 ||
                      !(adjudicationRationale[conflict.conflict_id] ?? '').trim()}
                    data-testid="adjudicate-exclude"
                  >
                    {conflict.unblinded ? 'Exclude' : 'Unblind & exclude'}
                  </button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="card">
      <h4>Flow ledger</h4>
      <p class="hint">
        Derived from the immutable history on every read — never served from the cache. Lead only:
        the counts describe both reviewers' work.
      </p>
      <!--
        The hint above already said "Lead only", and then offered two live
        buttons anyway. `read_flow` is `require_review_lead` and `rebuild_flow`
        is `require_review_lead_for` (`services/flow.py:382,346`), so for a
        non-creator both were prose and a 403 rather than prose and a boundary.
      -->
      {#if notReviewCreator}
        {@render leadOnly('Reading and rebuilding the flow ledger', 'flow-lead-only')}
      {/if}
      <div class="actions">
        <button onclick={loadFlow} disabled={busy !== null || notReviewCreator} data-testid="load-flow">Show flow</button>
        <button
          class="ghost"
          onclick={rebuild}
          disabled={busy !== null || !flow || notReviewCreator}
          data-testid="rebuild-flow"
        >
          Rebuild from zero
        </button>
      </div>
      {#if flow?.counts}
        <dl class="facts wide" data-testid="flow-counts">
          <!--
            Testids on the counts a browser drive needs to check ARITHMETICALLY
            rather than by eye. Asserting only that the ledger renders, and that
            its hash reproduces on a rebuild, cannot catch a ledger that is
            self-consistently WRONG — a derivation filtered to the caller's own
            decisions reproduces its hash perfectly, because the same filter
            applies to both derivations.
          -->
          <div><dt>Identified</dt><dd data-testid="flow-identified">{flow.counts.identified_total}</dd></div>
          <div><dt>Quarantined</dt><dd data-testid="flow-quarantined">{flow.counts.quarantined}</dd></div>
          <div><dt>Duplicates removed</dt><dd data-testid="flow-duplicates-removed">{flow.counts.duplicates_removed}</dd></div>
          <div><dt>Screened</dt><dd data-testid="flow-screened">{flow.counts.records_screened}</dd></div>
          <div><dt>Included</dt><dd data-testid="flow-included">{flow.counts.included}</dd></div>
          <div><dt>Excluded</dt><dd data-testid="flow-excluded">{flow.counts.excluded}</dd></div>
          <div><dt>Uncertain</dt><dd data-testid="flow-uncertain">{flow.counts.uncertain}</dd></div>
          <div><dt>Not yet screened</dt><dd data-testid="flow-not-yet-screened">{flow.counts.not_yet_screened}</dd></div>
        </dl>
        <p class="mono small" data-testid="counts-hash">{flow.canonical_counts_hash}</p>
        <!--
          THE DIAGRAM, which is the artefact all of this is FOR.

          Everything below this line is the ledger as tallies, and it stays:
          the numbers are the audit trail and a lead checking arithmetic wants
          them flat. But a systematic review reports its flow as PRISMA's
          diagram, and no amount of correct `<dl>` markup is one — the standard's
          content is which population each number counts and where it went,
          which lives in the boxes and the arrows.

          Fed the whole `flow`, not the derived lists above, because the diagram
          has to be able to tell "this service serves no per-stage split" from
          "this review has no exclusions" and draw a different figure for each.
        -->
        <PrismaFlowDiagram {flow} />
        <!--
          THE REASONS, WHICH WERE FETCHED AND THROWN AWAY.

          Rendered only when there are some. An empty histogram is a real server
          answer — a review whose reviewers have only ever agreed to include —
          and a caption over a blank list would say "no reasons were recorded"
          in the same shape a review with reasons uses, which is the state this
          card exists to distinguish.
        -->
        {#if flowReasons.length}
          <div class="reason-split">
            <h5>Excluded, by reason</h5>
            <p class="hint">
              Every exclusion this review has recorded, MERGED across its stages. PRISMA 2020
              reports full-text exclusions on their own, so this number is transcribable into a
              flow diagram only for a single-stage review; where a per-stage split is available
              it is below, and that is the one a diagram takes.
            </p>
            <dl class="facts wide" data-testid="flow-exclusion-reasons">
              {#each flowReasons as [code, count] (code)}
                <div>
                  <dt>{code}</dt>
                  <dd data-testid="flow-reason-{code}">{count}</dd>
                </div>
              {/each}
            </dl>
          </div>
        {/if}
        <!--
          THE PRISMA SPLIT.

          Absent on every deployment of Evidence Review that predates
          `counts_by_stage`, which is why this is `{#if flowStages.length}` and
          not a placeholder: a studio that drew an empty "by stage" box against
          a service that cannot fill it would be reporting the absence of a
          field as the absence of screening work.
        -->
        {#if flowStages.length}
          <div class="stage-split" data-testid="flow-by-stage">
            <h5>By stage</h5>
            <!--
              The caveat is not decoration, and it is not a disclaimer either —
              it is the difference between a transcribable diagram and a wrong
              one. Two of the four tallies below are not PRISMA boxes, the
              arithmetic between stages does not close, and none of that is
              visible from the numbers.
            -->
            <p class="hint" data-testid="flow-by-stage-caveat">
              One tally per screening stage, in protocol order. Only <strong>excluded here</strong>
              is a PRISMA box — it is “Reports excluded, with reasons”, and the reasons under it
              are that stage's own. <strong>Reached</strong> counts every record with at least one
              reviewer decision at this stage, not every record assessed: a record still waiting
              on its second reviewer is already in it. <strong>Settled here as include</strong> is
              not “studies included” at any stage but the last — it means the record passed here
              and no later stage has ruled on it; the review's inclusion set is the flat
              <em>Included</em> above and only that. Do not subtract across stages: a stage's
              reached minus its exclusions need not equal the next stage's reached, because a
              record can settle at one stage and never be worked at the next.
            </p>
            {#each flowStages as stage (stage.stage_key)}
              <section
                class="stage-tally"
                data-flow-stage={stage.stage_key}
                data-testid="flow-stage-{stage.stage_key}"
              >
                <h6>{stage.name}</h6>
                <dl class="facts wide">
                  <div>
                    <dt>Reached (≥1 decision)</dt>
                    <dd data-testid="flow-stage-{stage.stage_key}-reached">{stage.reached}</dd>
                  </div>
                  <div>
                    <dt>Excluded here, with reasons</dt>
                    <dd data-testid="flow-stage-{stage.stage_key}-settled-exclude">
                      {stage.settled_exclude}
                    </dd>
                  </div>
                  <div>
                    <dt>Settled here as include</dt>
                    <dd data-testid="flow-stage-{stage.stage_key}-settled-include">
                      {stage.settled_include}
                    </dd>
                  </div>
                  <div>
                    <dt>Settled here as uncertain</dt>
                    <dd data-testid="flow-stage-{stage.stage_key}-settled-uncertain">
                      {stage.settled_uncertain}
                    </dd>
                  </div>
                </dl>
                {#if stageReasons(stage).length}
                  <dl class="facts wide" data-testid="flow-stage-{stage.stage_key}-reasons">
                    {#each stageReasons(stage) as [code, count] (code)}
                      <div>
                        <dt>{code}</dt>
                        <dd data-testid="flow-stage-{stage.stage_key}-reason-{code}">{count}</dd>
                      </div>
                    {/each}
                  </dl>
                {:else}
                  <p class="hint" data-testid="flow-stage-{stage.stage_key}-no-reasons">
                    No exclusions settled at this stage.
                  </p>
                {/if}
              </section>
            {/each}
          </div>
        {/if}
        <!--
          TWO DIFFERENT STALENESS CLAIMS, and only one of them was ever made.

          `projection_stale` is the SERVER's answer to "was my cache behind when
          I derived this?" — and the ledger is always freshly derived, so a
          `false` is true, reassuring, and says nothing whatever about whether
          these numbers predate the decision the user just recorded. Nothing
          re-read the ledger after `decide`, `unblindAndAdjudicate` or `seal`,
          so the only indicator on this card gave exactly the wrong
          reassurance at exactly the moment it was read.

          A marker rather than an automatic re-read: `read_flow` is
          `require_review_lead`, so firing it after every decision would put a
          403 in front of every reviewer on every click.
        -->
        {#if flowStale}
          <p class="notice" data-testid="flow-stale">
            These counts were read before your most recent write and no longer describe this
            review. Show the flow again to re-derive them.
          </p>
        {/if}
        {#if flow.projection_stale}
          <p class="notice">The cached projection is stale; the numbers above are freshly derived.</p>
        {/if}
      {:else if flow}
        <!--
          A flow response that carries no `counts`. Rendering
          `flow.counts.identified_total` here threw a TypeError and blanked the
          whole stage — the panel disappeared and the console said only
          "Cannot read properties of undefined". A ledger we cannot read is a
          fact worth stating, not a reason to take the page down.
        -->
        <p class="notice" data-testid="flow-unreadable">
          The ledger response carried no counts. Nothing has been lost — the flow is derived from
          immutable history, so it can be rebuilt — but this response cannot be displayed.
        </p>
      {/if}
    </div>

    <div class="card">
      <h4>Sealed inclusion set</h4>
      <p class="hint">
        Refused while anything is unscreened or a conflict is open — an export of an unfinished
        review would present a filtered set as a complete one. Every omission is listed explicitly.
      </p>
      <!--
        Every export route is lead-only, the WRITE and both READS
        (`api/routers/exports.py:55,81,93`), so `seal()` cannot even get as far
        as the verification it chains. The refusals this card's own copy is
        about — "refused while anything is unscreened or a conflict is open" —
        are 422s a lead would meet; this is a different refusal entirely and
        would otherwise arrive looking like one of them.
      -->
      {#if notReviewCreator}
        {@render leadOnly('Sealing and verifying an inclusion export', 'export-lead-only')}
      {/if}
      {#if exportsKnowledge === 'unreadable'}
        <!--
          A STANDING indicator, in the `corpus-unknown` / `conflicts-unknown`
          idiom. `run()` clears `error` at the start of every action, so the
          aggregate message from `refresh()` is erased by the next click while
          the card stays exactly as stale as it was — and a card that says
          nothing about a seal is read as "there is no seal", which for this
          object is the difference between "produce the evidence" and "the
          evidence does not exist".
        -->
        <p class="notice" data-testid="exports-unknown">
          This review's inclusion exports could not be read, so this panel cannot tell whether it
          has already been sealed. Sealing now would be safe — an unchanged review replays the
          existing seal rather than minting a second one — but nothing here can confirm that. Use
          Refresh to retry.
        </p>
      {/if}
      {#if sealedExport}
        <!--
          Said NEXT TO the button, because with the export read in place the
          card knows something the button's old label denied: this review is
          already sealed. "Export and verify" invited a write to answer a
          question that is now a read.

          It states what a second seal would actually do rather than refusing
          one. Refusing would encode a guess: a review that has been reopened
          and re-screened has a different manifest and a genuinely new export is
          the correct act, and this panel cannot tell that case from an
          unchanged one — the export summary carries no flow revision. So the
          read leads, the write stays reachable, and what it will do is stated.
        -->
        <p class="hint warn" data-testid="export-already-sealed">
          This review is already sealed
          <code class="code">{sealedExport.manifest_hash.slice(0, 23)}…</code>. Sealing again adds
          nothing while the review is unchanged: Evidence Review matches the manifest and replays
          this same export rather than writing a second one. A new seal is only minted once the
          review has been reopened and re-screened.
        </p>
      {/if}
      <div class="actions">
        {#if sealedExport}
          <!--
            The READ leads once there is something to read. The question a lead
            returning to a sealed review has is whether their inclusion set
            still reproduces, and until `listExports` existed the only way to
            ask it was to seal first, because the studio had no `export_id` it
            had not just minted.
          -->
          <button
            onclick={recheckSeal}
            disabled={busy !== null || notReviewCreator}
            data-testid="verify-export"
          >
            {busy === 'verify' ? 'Verifying…' : 'Verify this seal'}
          </button>
          <button
            class="ghost"
            onclick={seal}
            disabled={busy !== null || notReviewCreator}
            data-testid="create-export"
          >
            {busy === 'export' ? 'Sealing…' : 'Seal again'}
          </button>
        {:else}
          <button
            onclick={seal}
            disabled={busy !== null || notReviewCreator}
            data-testid="create-export"
          >
            {busy === 'export' ? 'Sealing…' : 'Export and verify'}
          </button>
        {/if}
      </div>
      {#if exportReplayed}
        <!--
          A replay is not a seal. Nothing was written, and presenting the
          response as if something had been is a false claim about an evidence
          artefact — the same distinction the Corpus card already draws with
          `corpus-replayed-earlier-taking`.
        -->
        <p class="notice" data-testid="export-replayed">
          Nothing new was written. This review was already sealed with this exact manifest, so
          Evidence Review replayed the existing export rather than appending a duplicate.
        </p>
      {/if}
      {#if sealedExport}
        <dl class="facts">
          <div><dt>Included</dt><dd data-testid="export-included">{sealedExport.included_count}</dd></div>
          <div><dt>Omissions</dt><dd data-testid="export-omissions">{sealedExport.omissions_count}</dd></div>
          <div><dt>Manifest</dt><dd class="mono">{sealedExport.manifest_hash.slice(0, 23)}…</dd></div>
          <div><dt>Payload</dt><dd class="mono">{sealedExport.payload_digest.slice(0, 23)}…</dd></div>
          <div>
            <dt>Verified</dt>
            <dd data-testid="export-verified">
              <!--
                THREE outcomes, three words. `outcome` is the field to branch
                on; a server that predates it leaves this `unverifiable`, which
                is the honest answer for "I do not know what this deployment
                checked" and is the safe direction to fail.
              -->
              {#if verificationFailure}
                <!--
                  The check did not RUN. Branched first, and kept apart from the
                  `{:else}` below, because "I could not ask" is not a statement
                  about the export at all — while "cannot be checked here" is a
                  statement about the installed contract wheel. Collapsing the
                  two presented a 503 from the verifier as a property of the
                  seal, and the two have different remedies.
                -->
                <span class="badge warn" data-testid="export-verify-failed" title={verificationFailure}>
                  verification could not be run
                </span>
              {:else if verification?.outcome === 'verified'}
                <span class="badge ok">round-trips</span>
              {:else if verification?.outcome === 'tampered'}
                <span class="badge bad" data-testid="export-tampered">
                  {verification.items_match === false
                    ? 'a record was substituted'
                    : 'seal did not reproduce'}
                </span>
              {:else}
                <span class="badge warn" title={verification?.seal_unavailable_reason ?? undefined}>
                  cannot be checked here
                </span>
              {/if}
            </dd>
          </div>
        </dl>
        <!--
          THE SEAL'S CONTENTS — which could not be read through this product at
          all.

          What this card showed of the artefact the entire stage exists to
          produce was two integers and a 23-character hash prefix. None of that
          identifies anything: a reader cannot tell whether the right paper is
          in the set, an auditor cannot check an omission, and a reviewer cannot
          see their own work.

          `GET /exports/{id}` has served the whole envelope all along, with the
          payload attached BY DEFAULT (`api/routers/exports.py:85-98`); the
          client deliberately had no read for it, on the circular grounds that
          nothing on this surface rendered a payload.

          Loaded on demand rather than in `refresh()`: it is the largest
          response on this surface, and a lead arriving at a sealed review
          usually wants the seal's identity rather than its contents.
        -->
        <div class="actions">
          <button
            class="ghost"
            onclick={readSealedSet}
            disabled={busy !== null || notReviewCreator}
            data-testid="read-sealed-set"
          >
            {busy === 'sealed-set'
              ? 'Reading…'
              : `Show the ${sealedExport.included_count} record${
                  sealedExport.included_count === 1 ? '' : 's'
                } this seal contains`}
          </button>
        </div>
        {#if sealedSetOpen}
          <div class="sealed-set" data-testid="sealed-set">
            {#if payloadKnowledge === 'forbidden'}
              <!--
                A designed answer, not a fault — every export route is lead-only
                including the reads, because the contents of an inclusion set
                are progress information about both reviewers.
              -->
              <p class="hint warn" data-testid="sealed-set-forbidden">
                The contents of an inclusion export are visible to the review lead only.
              </p>
            {:else if payloadKnowledge === 'unreadable'}
              <p class="notice" data-testid="sealed-set-unreadable">
                The seal exists and its hashes are above, but its contents could not be read. That
                is a failed request, not a statement about the export.
              </p>
            {:else if includedRecords === null && payloadKnowledge === 'read'}
              <!--
                `with_payload` is a parameter and an older service carries no
                envelope at all, so an absent payload is a real answer. It must
                never render as an empty inclusion set: "this seal contains
                nothing" and "this response did not carry the records" look
                identical on screen and have nothing else in common.
              -->
              <p class="notice" data-testid="export-payload-unavailable">
                This service returned the seal without its payload, so the {sealedExport.included_count}
                record{sealedExport.included_count === 1 ? '' : 's'} it contains cannot be listed
                here. The counts and hashes above are still the export's own.
              </p>
            {:else if includedRecords}
              <h5>Included</h5>
              <ul class="included">
                {#each includedRecords as r (r.review_record_version_id)}
                  <li data-testid="export-included-row">
                    <strong>{r.title ?? '(untitled)'}</strong>
                    <span class="meta">
                      {r.publication_year ?? '—'}
                      {#if r.doi}<code class="code">{r.doi}</code>{/if}
                      {#if r.pmid}<code class="code">PMID {r.pmid}</code>{/if}
                    </span>
                  </li>
                {/each}
              </ul>
              <!--
                EVERY omission, and the two shapes are kept apart. A screened
                record that did not reach `included` is keyed by
                `review_record_id` and carries its bucket and reason; a
                QUARANTINED IMPORT ROW never became a record at all and is keyed
                by `import_row_id` with a `quarantine_reason`
                (`flow.py:861-887`). Rendering one shape drops every row of the
                other, and the quarantined ones are exactly the omissions a
                reader has no other way to learn about.
              -->
              <h5>Omissions</h5>
              {#if sealedOmissions?.length}
                <ul class="omissions">
                  {#each sealedOmissions as o (isRecordOmission(o) ? o.review_record_id : o.import_row_id)}
                    <li data-testid="export-omission-row">
                      {#if isRecordOmission(o)}
                        <span class="badge">{o.bucket}</span>
                        {#if o.exclusion_reason_code}<code class="code">{o.exclusion_reason_code}</code>{/if}
                        {#if o.adjudicated}<span class="badge ok">adjudicated</span>{/if}
                        <code class="code">{o.review_record_id}</code>
                      {:else}
                        <span class="badge warn">quarantined</span>
                        {o.quarantine_reason ?? 'reason not recorded'}
                        <code class="code">{o.import_row_id}</code>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {:else if sealedOmissions !== null}
                <p class="hint" data-testid="export-no-omissions">
                  Nothing was omitted — every record in the sealed corpus is in the set above.
                </p>
              {:else}
                <!--
                  "The response did not carry the omissions" is not "nothing was
                  omitted", and this is the ER-009.3 claim — the one place the
                  studio asserts an evidence set is COMPLETE.

                  `sealedOmissions` is `payload?.omissions ?? omissions ?? null`,
                  so a response carrying neither leaves it `null`, and
                  `null?.length` is falsy. Under the old two-branch form that
                  landed in the same arm as `[]` and the studio affirmed
                  completeness it had never read.

                  Two branches up, `includedRecords === null` already renders
                  `export-payload-unavailable` for exactly this reason: "contains
                  nothing" and "did not carry them" must not look alike. This is
                  the same argument, and it was handled the opposite way one
                  branch over.
                -->
                <p class="notice" data-testid="export-omissions-unavailable">
                  This response did not carry the omissions, so this panel cannot say whether
                  anything was left out. That is not the same as nothing having been omitted —
                  re-read the sealed set, and if it persists the export was served without the
                  block <code class="code">ER-009.3</code> requires.
                </p>
              {/if}
              <!--
                The studio already downloads the UNSCREENED Discover candidates
                as .bib/.ris/.json; the screened RESULT could not be taken out
                of the product at all.

                Two formats because they answer different questions. The JSON is
                the response verbatim — the sealed envelope an auditor
                re-hashes. The RIS is DERIVED from `payload.included` for a
                reference manager, and is labelled as derived: nothing about it
                round-trips to `payload_digest`.
              -->
              <div class="actions">
                <button
                  class="ghost"
                  onclick={() => downloadExport('ris')}
                  disabled={busy !== null}
                  data-testid="download-export-ris"
                >
                  Download the inclusion set (.ris)
                </button>
                <button
                  class="ghost"
                  onclick={() => downloadExport('json')}
                  disabled={busy !== null}
                  data-testid="download-export-json"
                >
                  Download the sealed envelope (.json)
                </button>
              </div>
              <!--
                This copy used to claim the `.json` "is the export exactly as
                Evidence Review served it, which is what reproduces
                `payload_digest`". BOTH halves were false, and on the card whose
                whole subject is hash provenance.

                `payload_digest` is
                `sha256(json.dumps(envelope, sort_keys=True, separators=(",", ":")))`
                over the SEALED ENVELOPE ONLY (`flow.py:963-972`) — compact and
                key-sorted. What this button writes is `JSON.stringify(response,
                null, 2)`: the whole HTTP response (the flat summary AND the
                envelope AND the top-level `omissions`), pretty-printed, in
                JavaScript's insertion order.

                So it is neither the served bytes nor the digest's preimage, and
                an auditor who followed that sentence would compute a mismatch
                and have no way to tell whether the seal or the sentence was
                wrong. Reproducing the digest in the browser would need a
                canonical JSON serialiser this file does not have — and claiming
                it without one is the failure this card exists to prevent.
              -->
              <p class="hint">
                The <code class="code">.json</code> is this whole response, pretty-printed —
                the summary, the sealed envelope and the omissions together. It is for reading
                and for keeping, <strong>not</strong> for re-computing
                <code class="code">payload_digest</code>: that hash is taken over the envelope
                alone, serialised compactly with sorted keys, and this file is neither. Verify
                the seal with <em>Verify this seal</em> above, which asks the service. The
                <code class="code">.ris</code> is a rendering of the included records for a
                reference manager and is not part of the seal.
              </p>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .screening {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  h3 {
    margin: 0 0 0.25rem;
  }
  h4 {
    margin: 0 0 0.5rem;
    font-size: 0.95rem;
  }
  .lede,
  .hint {
    margin: 0 0 0.75rem;
    color: var(--color-text-muted);
    font-size: 0.85rem;
    line-height: 1.45;
  }
  .card {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 1rem;
    background: var(--color-surface);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    margin-bottom: 0.6rem;
  }
  input,
  select {
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
    font: inherit;
  }
  .row {
    display: flex;
    gap: 1rem;
  }
  .row label {
    flex: 1;
  }
  /* A title and the control that reloads it: opposite ends of the same line,
     aligned on the text baseline rather than stretched to equal height. */
  .card-head {
    justify-content: space-between;
    align-items: baseline;
  }
  /* `label` above is a column stack sized for text fields; a checkbox and its
     text belong on one line, next to each other. */
  .arm {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
  }
  .arm input {
    width: auto;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  button {
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    border: 1px solid var(--color-border-strong);
    background: var(--color-accent);
    color: var(--color-on-primary);
    font: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.ghost {
    background: transparent;
    color: inherit;
  }
  button.link {
    background: none;
    border: none;
    color: var(--color-accent-text);
    padding: 0;
    text-decoration: underline;
    cursor: pointer;
  }
  ul {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
    border-top: 1px solid var(--color-border);
  }
  .record {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .meta,
  .small {
    font-size: 0.78rem;
    color: var(--color-text-muted);
  }
  .decide {
    display: flex;
    gap: 0.35rem;
    flex-shrink: 0;
    align-items: center;
  }
  /*
    The per-record reason select. `label` above is a column with a bottom
    margin, which would push the select out of line with the buttons beside it;
    inside `.decide` it is a bare wrapper for the visually-hidden label text.
  */
  .decide .reason {
    margin: 0;
    display: block;
  }
  .decide .reason select {
    padding: 0.3rem 0.4rem;
    font-size: 0.78rem;
    max-width: 11rem;
  }
  /*
    Visually hidden, still announced. The select's options are reason CODES
    (`wrong_design`), which say nothing on their own to a screen reader without
    a name for the control.
  */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  /* The stage requires this field; the asterisk is decorative, the hint is the text. */
  .req {
    color: var(--color-danger, var(--color-text-muted));
    margin-left: 0.15rem;
  }
  .hint.warn {
    color: var(--color-warning-text, var(--color-text-muted));
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.5rem 1rem;
    margin: 0.75rem 0 0;
  }
  .facts.wide {
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  }
  .facts dt {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .facts dd {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .mono,
  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    font-weight: 400;
  }
  .code {
    background: var(--color-surface-strong);
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    margin-left: 0.35rem;
  }
  .badge {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    font-size: 0.72rem;
    background: var(--color-surface-strong);
  }
  .badge.ok {
    background: var(--color-success-bg);
    color: var(--color-success-text);
  }
  .badge.warn {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
  }
  /* Tampered is not a warning. It is the one state on this panel that asserts
     the evidence artefact has been altered, and it must not share a colour with
     "this deployment cannot tell". */
  .badge.bad {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }
  .error {
    color: var(--color-danger-text);
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin: 0;
    font-size: 0.85rem;
  }
  .notice {
    color: var(--color-accent-text);
    background: var(--color-accent-bg);
    border: 1px solid var(--color-accent-border);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    margin: 0;
    font-size: 0.85rem;
  }
  .cluster-members {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
    min-width: 0;
  }
  /* Modelled on .cluster-members deliberately: a div of spans, NOT a nested
     <ul>. The bare `li` rule above puts a border-top and `space-between` on
     every nested list item, which is wrong for a detail block. */
  .dispositions {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
    min-width: 0;
    margin-top: 0.2rem;
  }
  .disposition {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.35rem;
    min-width: 0;
  }
  /* A queue row can now carry a correction block under the badge, so the row
     has to wrap rather than squeeze the record title to nothing. */
  .queue li,
  .quarantine li,
  .omissions li,
  .conflicts li {
    flex-wrap: wrap;
  }
  .correction {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.35rem;
    width: 100%;
  }
  .correction .hint {
    margin: 0;
  }
  .quarantine .raw {
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .sealed-set {
    margin-top: 0.75rem;
    border-top: 1px solid var(--color-border);
    padding-top: 0.5rem;
  }
  .sealed-set h5 {
    margin: 0.75rem 0 0;
    font-size: 0.85rem;
  }
  /* The reason histogram and the per-stage split hang off the flow ledger and
     are read as blocks under it, not as more cells in the same grid — a
     stage's own tally has to be visibly ITS tally, or the split is no clearer
     than the merge it replaces. */
  .reason-split,
  .stage-split {
    margin-top: 0.75rem;
    border-top: 1px solid var(--color-border);
    padding-top: 0.5rem;
  }
  .reason-split h5,
  .stage-split h5 {
    margin: 0 0 0.35rem;
    font-size: 0.85rem;
  }
  .stage-tally {
    border-left: 2px solid var(--color-border);
    padding-left: 0.6rem;
    margin-top: 0.6rem;
  }
  .stage-tally h6 {
    margin: 0 0 0.3rem;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .stage-tally .hint {
    margin: 0.2rem 0 0;
  }
  /* The included list is read down rather than across: a title and its
     identifiers belong on the same visual line as each other, not opposite ends
     of the row. */
  .included li {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
  }
</style>
