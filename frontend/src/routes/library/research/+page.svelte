<!--
  /library/research — Scientific Research studio (7-stage stepper).

  An interactive, stage-by-stage scientific-inquiry workspace over the KAG
  gateway's Discovery Engine + Scientific Processor. The user walks a gated
  sequence — Input → Discover → Screening → Appraise → Build → Verify →
  Synthesize — reviewing each stage's output and advancing when it is
  satisfied. Stage numbers below are 1-based positions in `STEPS`; Screening
  was inserted at 3 and every later stage shifted up by one. A rigor
  preset (quick/standard/rigorous) seeds every stage's knobs (overridable).

  All feature logic (search, snowball, trust scoring, push + per-paper outcome,
  integrity verify, ask-your-corpus, export) is the proven flat-studio code,
  relocated into stage panels — not rewritten. Stage 6 (verify) is integrity-only
  here and broadened to the full Scientific surface in a follow-up; Stage 7 is the
  ask + export today and grows into the four-deliverable synthesis.
-->
<script lang="ts">
  import CockpitBackLink from '$lib/components/library/CockpitBackLink.svelte';
  import { onDestroy, onMount } from 'svelte';
  import { usePoll, type PollHandle } from '$lib/net/poll';
  import { AssetError } from '$lib/api/assets';
  // The house rule for a degraded read. Nothing here is asset-workspace
  // specific: `readFailureReason` keeps the REASON a read failed (the only fact
  // that says whether retrying can help), and `scopeRefState` is the
  // three-state verdict — unreadable / empty / ready — that stops "we could not
  // ask" from rendering as "there are none".
  import { readFailureReason, scopeRefState } from '$lib/asset-workspace/scopeRefs';
  import {
    corpusConflictNotice,
    sessionIdFromCorpusConflict,
  } from '$lib/research/session-conflict';
  import {
    loadResearchSessionId,
    saveResearchSessionId,
  } from '$lib/kag/sessionPersistence';
  import {
    researchApi,
    isPushTerminal,
    isKagTerminal,
    isSnowballTerminal,
    isExplainTerminal,
    paperIdOf,
    type PaperResult,
    type SourceInfo,
    type OrchestratorJob,
    type IntegrityResponse,
    type CoveResponse,
    type RagasResponse,
    type ContradictionResponse,
    type AuthorityResponse,
    type SubgraphResponse,
    type CommunityResponse,
    type ExplainJob,
    type TrendResponse,
    type FormalResponse,
    type FormalProof,
    type TrustScore,
    type TrustComponents,
    type ExportFormat,
    type SnowballDirection,
  } from '$lib/api/research';
  import {
    DOMAINS,
    domainById,
    inferDomain,
    inferScopeSources,
    buildSearchRequest,
    type DomainId,
  } from '$lib/research/domains';
  import {
    detectInput,
    INPUT_TYPE_LABELS,
    type DetectedInputType,
  } from '$lib/research/detect-input';
  import {
    PRESET_ORDER,
    PRESET_LABELS,
    presetKnobs,
    type RigorPreset,
    type StageKnobs,
  } from '$lib/research/presets';
  import {
    toScreeningRecords,
    type CandidateProvenance,
  } from '$lib/research/screening-records';
  import ResearchStepper, {
    type StepDef,
  } from '$lib/components/ResearchStepper.svelte';
  import PaperCard from './components/PaperCard.svelte';
  import TrustBreakdown from './components/TrustBreakdown.svelte';
  import ClaimLedgerRow from './components/ClaimLedgerRow.svelte';
  import DeliverableTabs from './components/DeliverableTabs.svelte';
  import CorpusGraphPanel from './components/CorpusGraphPanel.svelte';
  import EvidenceSynthesisPanel from './components/EvidenceSynthesisPanel.svelte';
  import CrossPaperContradictions from './components/CrossPaperContradictions.svelte';
  import type { SessionPaper } from './components/crossPaperContradictions';
  import SandboxCell from './components/SandboxCell.svelte';
  import SessionQualityPanel from './components/SessionQualityPanel.svelte';
  import ScreeningPanel from './components/ScreeningPanel.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { safeHref } from '$lib/utils/safeUrl';

  // ---- Stepper state ----
  const STEPS: StepDef[] = [
    { id: 'input', label: 'Input' },
    { id: 'discover', label: 'Discover' },
    // Screening sits between Discover and Appraise because everything Discover
    // produces is a CANDIDATE. Appraising a corpus nobody has screened appraises
    // records that were never eligible.
    { id: 'screening', label: 'Screening' },
    { id: 'appraise', label: 'Appraise' },
    { id: 'build', label: 'Build' },
    { id: 'verify', label: 'Verify' },
    { id: 'synthesize', label: 'Synthesize' },
  ];
  let stage = $state(1);
  let maxReached = $state(1);

  function goStage(s: number): void {
    stage = s;
    if (s > maxReached) maxReached = s;
    // Screening seals the SESSION, not this screen. Read the server's set on
    // arrival so the count shown next to the consent tick is the count that
    // will be imported. `goStage` is the only writer of `stage` besides the
    // initialiser, so this is a real choke point; an $effect keyed on
    // `sessionId` would re-fire on every session change instead.
    if (STEPS[s - 1]?.id === 'screening') void loadScreeningSnapshot();
  }

  // ---- Rigor preset (a starting point, not a lock) ----
  let preset = $state<RigorPreset>('standard');
  let knobs = $state<StageKnobs>(presetKnobs('standard'));

  function applyPreset(p: RigorPreset): void {
    preset = p;
    knobs = presetKnobs(p);
    maxPerSource = knobs.maxPerSource;
    sortBy = knobs.sortBy;
    sbDepth = knobs.snowballDepth;
  }

  // The raw research input — declared up here because the Stage-1 detector and
  // the domain smart-suggest both derive from it.
  let query = $state('');

  // ---- Stage 1: smart-input detection ----
  const INPUT_TYPES: readonly DetectedInputType[] = [
    'topic',
    'question',
    'title',
    'doi',
    'arxiv',
    'url',
  ];
  let inputOverride = $state<DetectedInputType | null>(null);
  const detected = $derived(detectInput(query));
  const effectiveInputType = $derived<DetectedInputType>(
    inputOverride ?? detected.type,
  );

  // ---- Scope panel state ---- (seeded from the standard preset)
  let domainOverride = $state<DomainId | null>(null);
  let sourceOverride = $state<string[]>([]); // explicit picks; empty = follow domain
  let advancedOpen = $state(false);
  let liveSources = $state<SourceInfo[]>([]);
  // Why the live source list could not be read — null means NO FAILURE WAS
  // RECORDED, which is not the same as "the list loaded".
  //
  // `liveSources = []` on its own is indistinguishable from "the engine enables
  // no sources", and `pickerSources` below SUBSTITUTES the built-in union of
  // every domain's sources on exactly that value. So a dead `listSources()`
  // handed the reviewer a hardcoded scope and presented it as the live one —
  // the worst direction, because the picker then looks complete and the sources
  // it lists may not be the ones that will actually be queried.
  let sourcesUnreadable = $state<string | null>(null);
  let yearMin = $state<number | null>(null);
  let yearMax = $state<number | null>(null);
  let sortBy = $state<'relevance' | 'citation_count' | 'year'>('relevance');
  let maxPerSource = $state(25);

  // Smart-suggest: re-infer from the query until the user manually picks a chip.
  const suggested = $derived(inferDomain(query));
  const activeDomain = $derived<DomainId>(domainOverride ?? suggested);

  // ---- Search results state ----
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  let sessionId = $state<string | null>(null);
  // Honest "the engine handed us a different session than the one we threaded"
  // line — never silently repoint the workspace.
  let sessionSwitchNotice = $state<string | null>(null);
  // Why the durable session could not be created. The search still runs, but
  // without persistence or push — and the reviewer is entitled to the reason,
  // not just the consequence.
  let sessionError = $state<string | null>(null);
  let results = $state<PaperResult[]>([]);
  let sourcesQueried = $state<string[]>([]);
  let sourcesFailed = $state<string[]>([]);
  let totalResults = $state<number | null>(null);
  let selected = $state<string[]>([]);

  // Sources that were asked and answered — the ones a "no results" verdict can
  // honestly speak for. A source that failed did not answer, so an empty
  // result set from it is an outage, not an absence of evidence.
  const sourcesAnswering = $derived(
    sourcesQueried.filter((s) => !sourcesFailed.includes(s)),
  );

  // ---- What Screening will seal ----
  //
  // Four states, not `PaperResult[] | null`, for the same reason ScreeningPanel
  // keeps `corpusKnowledge` three-valued: "there is no session" and "I could
  // not find out what is in the session" are different facts, and conflating
  // them lets a failed read present as a first run.
  let sessionSnapshot = $state<PaperResult[] | null>(null);
  let snapshotState = $state<'unread' | 'read' | 'unreadable' | 'none'>(
    'unread',
  );
  let snapshotError = $state<string | null>(null);
  let snapshotAt = $state<string | null>(null);
  let snapshotLoading = $state(false);

  // ---- Client-side filter bar ----
  let filterText = $state('');
  let filterSource = $state<string | null>(null);
  let filterOA = $state(false);
  let filterPdf = $state(false);
  let clientSort = $state<'default' | 'trust'>('default');

  // ---- Trust scoring (7-signal, opt-in) ----
  let scoring = $state(false);
  let scoreError = $state<string | null>(null);
  let scores = $state<Record<string, number>>({});
  let scoreTitles = $state<Record<string, string>>({});
  let scoreComponentsById = $state<Record<string, TrustComponents>>({});

  function componentSummary(ts: TrustScore): string {
    const c = ts.components ?? {};
    const parts: string[] = [];
    const add = (label: string, v: unknown): void => {
      if (typeof v === 'number') parts.push(`${label} ${v.toFixed(2)}`);
    };
    add('peer-review', c.peer_review_status);
    add('citations', c.citation_impact);
    add('h-index', c.author_h_index);
    add('venue', c.venue_prestige);
    add('recency', c.recency);
    add('cross-ref', c.cross_reference_reliability);
    add('consensus', c.consensus_confidence);
    return parts.join(' · ');
  }

  async function scoreResults(): Promise<void> {
    if (scoring) return;
    const ids = results.map((p) => paperIdOf(p)).filter(Boolean) as string[];
    if (ids.length === 0) return;
    scoring = true;
    scoreError = null;
    try {
      const res = await researchApi.scoreBatch(ids);
      const nextScores: Record<string, number> = {};
      const nextTitles: Record<string, string> = {};
      const nextComponents: Record<string, TrustComponents> = {};
      for (const ts of res) {
        if (typeof ts.overall_score === 'number') {
          nextScores[ts.paper_id] = ts.overall_score;
          nextTitles[ts.paper_id] = componentSummary(ts);
          if (ts.components) nextComponents[ts.paper_id] = ts.components;
        }
      }
      scores = nextScores;
      scoreTitles = nextTitles;
      scoreComponentsById = nextComponents;
      clientSort = 'trust';
    } catch (e) {
      scoreError = errMsg(e);
    } finally {
      scoring = false;
    }
  }

  // ---- Push state ----
  let pushing = $state(false);
  let pushError = $state<string | null>(null);
  let pushId = $state<string | null>(null);
  let pushStatus = $state<string | null>(null);
  // Per-paper ingest outcome (kag_status / document_id / entity_ids), enriched
  // by the push-status endpoint and updated on every poll.
  let pushJobs = $state<OrchestratorJob[]>([]);

  // paper_id → title, so the outcome list can name each pushed paper.
  const titleById = $derived(
    new Map(
      results
        .map((p) => [paperIdOf(p), p.title] as const)
        .filter((e): e is [string, string] => Boolean(e[0])),
    ),
  );

  // ---- Session export ----
  let exporting = $state<ExportFormat | null>(null);
  let exportError = $state<string | null>(null);
  // True when the last export came back with no papers — surface an honest
  // "nothing to export" line instead of downloading a 0-byte valid-looking file.
  let exportEmpty = $state(false);

  async function exportSession(format: ExportFormat): Promise<void> {
    if (sessionId === null || exporting) return;
    exporting = format;
    exportError = null;
    exportEmpty = false;
    try {
      const res = await researchApi.exportSession(sessionId, format);
      const data = res.data ?? '';
      // Guard the empty session: a 0-paper export produces an empty string that
      // would download as a valid-looking but useless .bib/.ris/.json.
      if (typeof data !== 'string' || data.trim() === '') {
        exportEmpty = true;
        return;
      }
      // Trigger a download when the browser supports it (skipped in jsdom).
      if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const ext = format === 'bibtex' ? 'bib' : format === 'ris' ? 'ris' : 'json';
        const blob = new Blob([data], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `research-session-${sessionId}.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      exportError = errMsg(e);
    } finally {
      exporting = null;
    }
  }

  /**
   * Read the session's full paper set — what Screening will seal.
   *
   * Called on arrival at Screening (and from the panel's retry), NOT at click
   * time: the count has to be on screen before the consent tick is spent, and
   * fetching again on click would mean the user consented to a number that is
   * no longer the one being imported.
   *
   * A failure sets `unreadable` and does NOT fall back to `results`. Falling
   * back would restore the exact defect this exists to fix, and it would do so
   * invisibly — the seal would succeed with the wrong records.
   */
  async function loadScreeningSnapshot(): Promise<void> {
    if (snapshotLoading) return;
    if (sessionId === null) {
      snapshotState = 'none';
      sessionSnapshot = null;
      snapshotError = null;
      snapshotAt = null;
      return;
    }
    snapshotLoading = true;
    snapshotError = null;
    try {
      const res = await researchApi.exportSession(sessionId, 'json');
      // `data` is a JSON *string* — discovery-engine's SessionExport nests the
      // papers one level down. Same parse as `onSnowballTerminal`.
      const parsed = JSON.parse(res.data ?? '{}') as { papers?: PaperResult[] };
      sessionSnapshot = parsed.papers ?? [];
      snapshotAt = new Date().toISOString();
      snapshotState = 'read';
    } catch (e) {
      sessionSnapshot = null;
      snapshotState = 'unreadable';
      snapshotError = errMsg(e);
    } finally {
      snapshotLoading = false;
    }
  }

  // ---- Verify state (Stage 6 — the full Scientific surface) ----
  // Per graph entity: integrity + topology (contradictions/authority/subgraph)
  // + CoVe on the paper's claim + async SubgraphX explainability. Kept in the
  // page so Stage 7's deliverables (ledger, citation annotation) read the same
  // results, and so all polling shares the page's pollHandles Map.
  interface EntityVerification {
    integrity?: IntegrityResponse;
    contradictions?: ContradictionResponse;
    authority?: AuthorityResponse;
    subgraph?: SubgraphResponse;
    cove?: CoveResponse;
    explain?: ExplainJob;
    running: boolean;
    error?: string;
  }
  let verifyByEntity = $state<Record<string, EntityVerification>>({});

  // Graph-wide analyses.
  let communitiesResult = $state<CommunityResponse | null>(null);
  let communitiesRunning = $state(false);
  let communitiesError = $state<string | null>(null);
  let trendResult = $state<TrendResponse | null>(null);
  let trendRunning = $state(false);
  let trendError = $state<string | null>(null);
  let formalClaim = $state(''); // the formal-logic expression (typed, or filled by translate)
  let formalResult = $state<FormalResponse | null>(null);
  let formalRunning = $state(false);
  let formalError = $state<string | null>(null);
  // Frictionless path: natural-language claim → translate → editable expression.
  let formalNl = $state('');
  let formalTranslating = $state(false);
  let formalTranslateError = $state<string | null>(null);
  let formalConfidence = $state<number | null>(null);
  // Proof persistence (keyed by a stable slug of the claim).
  let formalSaving = $state(false);
  let formalSaveMsg = $state<string | null>(null);
  let formalProofs = $state<FormalProof[]>([]);
  let formalProofsError = $state<string | null>(null);

  // Bound the verify list: one row PER graph entity across all pushed papers,
  // capped globally so a large push can't render hundreds of one-click rows
  // (mirrors CrossPaperContradictions' MAX_ENTITIES fan-out cap).
  const MAX_VERIFY_ENTITIES = 60;

  // The pushed papers that produced ≥1 graph entity to verify — emitting ONE
  // entry per entity_id (not just the first of each paper, which silently
  // dropped the rest). The first entity keeps the paper title; each additional
  // entity is annotated `… · entity k` so the row is still identifiable.
  const verifiableEntities = $derived.by<Array<{ entityId: string; title: string }>>(
    () => {
      const rows: Array<{ entityId: string; title: string }> = [];
      // Dedup by entityId across ALL papers — a graph entity is routinely shared
      // by several papers, and `verifyByEntity` + the keyed {#each} are both keyed
      // on entityId, so a duplicate id would collide the verification state and
      // throw Svelte's each_key_duplicate. First occurrence wins (keeps the paper
      // title). Mirrors CrossPaperContradictions.svelte's `seen` set.
      const seen = new Set<string>();
      for (const j of pushJobs) {
        const ids = (j.entity_ids ?? []).filter(Boolean) as string[];
        const baseTitle =
          (j.paper_id && titleById.get(j.paper_id)) || j.paper_id || ids[0] || '';
        ids.forEach((entityId, k) => {
          if (seen.has(entityId)) return;
          seen.add(entityId);
          rows.push({
            entityId,
            title: k === 0 ? baseTitle : `${baseTitle} · entity ${k + 1}`,
          });
        });
      }
      return rows.slice(0, MAX_VERIFY_ENTITIES);
    },
  );

  // True when the push linked more UNIQUE entities than we render (list is capped).
  const verifyTruncated = $derived(
    new Set(pushJobs.flatMap((j) => (j.entity_ids ?? []).filter(Boolean))).size >
      MAX_VERIFY_ENTITIES,
  );

  // ≥2 dated + cited papers → a citation-vs-year series for trend analysis.
  const citationSeries = $derived(
    results
      .filter(
        (p): p is PaperResult & { year: number; citation_count: number } =>
          typeof p.year === 'number' && typeof p.citation_count === 'number',
      )
      .sort((a, b) => a.year - b.year),
  );

  // Top-5 communities by member count for a compact graph-wide chip readout
  // (previously community_sizes came back from the engine but was never shown).
  const topCommunities = $derived.by<Array<{ id: string; size: number }>>(() => {
    const sizes = communitiesResult?.community_sizes;
    if (!sizes) return [];
    return Object.entries(sizes)
      .map(([id, size]) => ({ id, size: Number(size) }))
      .filter((c) => Number.isFinite(c.size))
      .sort((a, b) => b.size - a.size)
      .slice(0, 5);
  });

  function patchVerify(
    entityId: string,
    fields: Partial<EntityVerification>,
  ): void {
    const prev: EntityVerification = verifyByEntity[entityId] ?? {
      running: false,
    };
    verifyByEntity = { ...verifyByEntity, [entityId]: { ...prev, ...fields } };
  }

  async function verifyEntity(entityId: string, claim: string): Promise<void> {
    if (verifyByEntity[entityId]?.running) return;
    patchVerify(entityId, { running: true, error: undefined });
    const next: EntityVerification = {
      ...(verifyByEntity[entityId] ?? { running: false }),
      running: false,
    };
    const tasks: Array<Promise<void>> = [
      researchApi
        .verifyIntegrity({ entity_id: entityId })
        .then((r) => void (next.integrity = r)),
      researchApi
        .topologyAuthority({ entity_id: entityId })
        .then((r) => void (next.authority = r)),
      researchApi
        .topologySubgraph({ entity_id: entityId })
        .then((r) => void (next.subgraph = r)),
    ];
    if (knobs.contradictions) {
      tasks.push(
        researchApi
          .topologyContradictions({ entity_id: entityId })
          .then((r) => void (next.contradictions = r)),
      );
    }
    if (knobs.cove && claim) {
      tasks.push(
        researchApi
          .verifyCove({ claim_text: claim })
          .then((r) => void (next.cove = r)),
      );
    }
    const settled = await Promise.allSettled(tasks);
    const failed = settled.find((s) => s.status === 'rejected');
    if (failed && failed.status === 'rejected') next.error = errMsg(failed.reason);
    verifyByEntity = { ...verifyByEntity, [entityId]: next };
    if (knobs.subgraphx) void startExplain(entityId);
  }

  async function startExplain(entityId: string): Promise<void> {
    try {
      const job = await researchApi.explainSubgraphx({ node_id: entityId });
      patchVerify(entityId, { explain: job });
      const jobId = job.job_id;
      if (jobId && !isExplainTerminal(job.status)) {
        const key = `explain:${entityId}`;
        clearPoll(key);
        let failures = 0;
        const handle = usePoll(
          async () => {
            try {
              const d = await researchApi.getExplainJob(jobId);
              failures = 0;
              patchVerify(entityId, { explain: d });
              if (isExplainTerminal(d.status)) clearPoll(key);
            } catch (e) {
              failures += 1;
              if (failures >= MAX_POLL_FAILURES) {
                // Only now is "failed" honest: the job itself may well have
                // finished — what failed is our ability to read it.
                patchVerify(entityId, {
                  explain: { status: 'failed', error: `lost contact: ${errMsg(e)}` },
                });
                clearPoll(key);
                return;
              }
              // Rethrow so usePoll backs off, rather than calling a job that
              // is still running "failed" on the first blip.
              throw e;
            }
          },
          { intervalMs: 3000 },
        );
        pollHandles.set(key, handle);
        handle.start();
      }
    } catch (e) {
      patchVerify(entityId, { explain: { status: 'failed', error: errMsg(e) } });
    }
  }

  async function runCommunities(): Promise<void> {
    if (communitiesRunning) return;
    communitiesRunning = true;
    communitiesError = null;
    try {
      communitiesResult = await researchApi.topologyCommunities({});
    } catch (e) {
      communitiesError = errMsg(e);
    } finally {
      communitiesRunning = false;
    }
  }

  async function runTrend(): Promise<void> {
    if (trendRunning) return;
    if (citationSeries.length < 3) {
      trendError = 'Need ≥3 dated, cited papers to analyse a trend.';
      return;
    }
    trendRunning = true;
    trendError = null;
    try {
      // The Scientific Processor's stats/trend takes a numeric time-series:
      // `data: [{timestamp, value}]` (≥3 points), citation_count vs. year.
      trendResult = await researchApi.statsTrend({
        data: citationSeries.map((p) => ({
          timestamp: p.year,
          value: p.citation_count,
        })),
      });
    } catch (e) {
      trendError = errMsg(e);
    } finally {
      trendRunning = false;
    }
  }

  async function runFormal(): Promise<void> {
    if (formalRunning || !formalClaim.trim()) return;
    formalRunning = true;
    formalError = null;
    try {
      formalResult = await researchApi.formalVerify({
        formal_expression: formalClaim.trim(),
      });
    } catch (e) {
      formalError = errMsg(e);
    } finally {
      formalRunning = false;
    }
  }

  // A stable per-claim id from the NL claim (or the expression as fallback), so
  // a saved proof can be reloaded for the same claim later.
  function formalClaimId(): string {
    const src = (formalNl.trim() || formalClaim.trim()).toLowerCase();
    const slug = src
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
    return slug ? `research:${slug}` : '';
  }

  async function runTranslate(): Promise<void> {
    if (formalTranslating || !formalNl.trim()) return;
    formalTranslating = true;
    formalTranslateError = null;
    try {
      const res = await researchApi.formalTranslate({
        claim_text: formalNl.trim(),
        target_language: 'z3',
      });
      if (res.formal_expression) formalClaim = res.formal_expression;
      formalConfidence = typeof res.confidence === 'number' ? res.confidence : null;
    } catch (e) {
      formalTranslateError = errMsg(e);
    } finally {
      formalTranslating = false;
    }
  }

  async function saveProof(): Promise<void> {
    const claimId = formalClaimId();
    if (formalSaving || !formalResult || !formalClaim.trim() || !claimId) return;
    formalSaving = true;
    formalSaveMsg = null;
    try {
      await researchApi.formalProofStore(claimId, {
        expression: formalClaim.trim(),
        language: 'z3',
        is_valid: formalResult.is_valid ?? null,
        proof: formalResult.proof ?? null,
      });
      formalSaveMsg = 'Saved';
    } catch (e) {
      formalSaveMsg = errMsg(e);
    } finally {
      formalSaving = false;
    }
  }

  async function loadProofs(): Promise<void> {
    const claimId = formalClaimId();
    if (!claimId) return;
    formalProofsError = null;
    try {
      formalProofs = await researchApi.formalProofGet(claimId);
    } catch (e) {
      formalProofsError = errMsg(e);
      formalProofs = [];
    }
  }

  // ---- Ask-your-corpus state ----
  let askQuery = $state('');
  let asking = $state(false);
  let askError = $state<string | null>(null);
  let askAnswer = $state<string | null>(null);
  let askCitations = $state<Array<Record<string, unknown>>>([]);
  let askDocId = $state(''); // '' = whole tenant graph; else a pushed document_id
  let answerCopied = $state(false); // transient "Copied" feedback on the copy button

  // Copy the verified answer to the clipboard (frontend-only; no endpoint).
  async function copyAnswer(): Promise<void> {
    if (!askAnswer) return;
    try {
      await navigator.clipboard.writeText(askAnswer);
      answerCopied = true;
      setTimeout(() => {
        answerCopied = false;
      }, 1500);
    } catch {
      // Clipboard denied/unavailable — leave the button state unchanged.
    }
  }

  // SubgraphX explanation → top-k (node id, importance) rows for display. The
  // upstream `explanation` object is loose; pull a ranked list defensively from
  // the common shapes (an array of {node_id/id, score/importance}, or a
  // node_id→score map), else render nothing.
  function explainTopK(
    explanation: Record<string, unknown> | undefined,
    k = 5,
  ): Array<{ label: string; score?: number }> {
    if (!explanation || typeof explanation !== 'object') return [];
    const arrKey = [
      'important_nodes',
      'top_nodes',
      'node_importances',
      'nodes',
      'important_subgraph',
    ].find((key) => Array.isArray((explanation as Record<string, unknown>)[key]));
    let rows: Array<{ label: string; score?: number }> = [];
    if (arrKey) {
      const arr = (explanation as Record<string, unknown>)[arrKey] as unknown[];
      rows = arr.map((it) => {
        if (it && typeof it === 'object') {
          const o = it as Record<string, unknown>;
          const label = String(o['node_id'] ?? o['id'] ?? o['label'] ?? o['name'] ?? '');
          const rawScore = o['score'] ?? o['importance'] ?? o['weight'];
          return {
            label,
            score: typeof rawScore === 'number' ? rawScore : undefined,
          };
        }
        return { label: String(it) };
      });
    } else {
      // Fall back to a node_id→numeric-score map.
      rows = Object.entries(explanation)
        .filter(([, val]) => typeof val === 'number')
        .map(([label, val]) => ({ label, score: val as number }));
    }
    rows = rows.filter((r) => r.label);
    rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return rows.slice(0, k);
  }

  // Pushed documents available to scope an answer to (kag-completed only).
  const askableDocs = $derived(
    pushJobs
      .filter((j) => j.document_id)
      .map((j) => ({
        docId: j.document_id as string,
        title:
          (j.paper_id && titleById.get(j.paper_id)) ||
          j.paper_id ||
          (j.document_id as string),
      })),
  );

  // Pushed papers that contributed graph entities — the input to the cross-paper
  // contradiction finder (needs ≥2 papers with entities to compare).
  const sessionPapers = $derived<SessionPaper[]>(
    pushJobs
      .filter((j) => j.paper_id && (j.entity_ids?.length ?? 0) > 0)
      .map((j) => ({
        paperId: j.paper_id as string,
        title: (j.paper_id && titleById.get(j.paper_id)) || (j.paper_id as string),
        entityIds: j.entity_ids ?? [],
      })),
  );

  async function askCorpus(): Promise<void> {
    if (!askQuery.trim() || asking) return;
    asking = true;
    askError = null;
    askAnswer = null;
    askCitations = [];
    ragasResult = null;
    ragasError = null;
    try {
      const res = await researchApi.askCorpus({
        query: askQuery.trim(),
        doc_id: askDocId || undefined,
      });
      askAnswer = res.answer ?? '(no answer returned)';
      askCitations = res.citations ?? [];
    } catch (e) {
      askError = errMsg(e);
    } finally {
      asking = false;
    }
  }

  // ---- Stage 7 deliverables ----
  // (a) RAGAS faithfulness scoring of the generated answer.
  let ragasResult = $state<RagasResponse | null>(null);
  let ragasRunning = $state(false);
  let ragasError = $state<string | null>(null);

  async function runRagas(): Promise<void> {
    if (!askAnswer || ragasRunning) return;
    ragasRunning = true;
    ragasError = null;
    try {
      const contexts = askCitations
        .map((c) => (c['snippet'] as string) ?? (c['title'] as string) ?? '')
        .filter(Boolean);
      ragasResult = await researchApi.verifyRagas({
        answer: askAnswer,
        contexts,
      });
    } catch (e) {
      ragasError = errMsg(e);
    } finally {
      ragasRunning = false;
    }
  }

  // (b) Annotated literature review: papers ranked by 7-signal trust (scored
  // first; unscored keep their returned order at the bottom).
  const rankedResults = $derived(
    [...results].sort(
      (a, b) =>
        (scores[paperIdOf(b) ?? ''] ?? -1) - (scores[paperIdOf(a) ?? ''] ?? -1),
    ),
  );

  // (c) Claim-verification ledger: every verified entity carrying a CoVe verdict
  // or contradiction analysis.
  const ledgerEntries = $derived(
    verifiableEntities
      .map((e) => ({ ...e, v: verifyByEntity[e.entityId] }))
      .filter((e) => e.v && (e.v.cove || e.v.contradictions)),
  );

  // (d) Curated corpus: total entities linked into the graph by the push.
  const pushedEntityCount = $derived(
    pushJobs.reduce((n, j) => n + (j.entity_ids?.length ?? 0), 0),
  );

  // (e) Knowledge graph: the node ids the push linked, fed to the embedded
  // graph/verify/ask panel so the loop closes in-page.
  const pushedEntityIds = $derived(
    pushJobs.flatMap((j) => j.entity_ids ?? []),
  );

  // Best-effort CoVe annotation for an answer citation (matched by title).
  function citationVerdict(title: string): string | null {
    const match = ledgerEntries.find((e) => e.title === title);
    const cove = match?.v?.cove;
    // Upstream emits `overall_verdict`; `supported` is a legacy read-fallback.
    const overall = cove?.overall_verdict;
    if (overall === 'verified') return 'CoVe ✓';
    if (overall === 'disputed') return 'CoVe ✗';
    if (overall != null) return null;
    const supported = cove?.supported;
    if (supported === true) return 'CoVe ✓';
    if (supported === false) return 'CoVe ✗';
    return null;
  }

  // ---- Snowball state (citation-graph walk from selected seeds) ----
  let snowballing = $state(false);
  let snowballError = $state<string | null>(null);
  let snowballJobId = $state<string | null>(null);
  let snowballStatus = $state<string | null>(null);
  let snowballDiscovered = $state(0);
  let snowballEdges = $state(0);
  let snowballDepth = $state(0);
  // Scope controls for the walk (engine defaults: both / depth 2 / 200 papers).
  let sbDirection = $state<SnowballDirection>('both');
  let sbDepth = $state(1);
  let sbMaxPapers = $state(200);
  // paper_ids merged into `results` from a completed walk → render a badge.
  let snowballIds = $state<string[]>([]);
  // How many discovered papers were actually merged into the list — surfaced
  // when it's below the engine's discovered count (id-less/anonymous residue).
  let snowballAdded = $state<number | null>(null);

  const pollHandles = new Map<string, PollHandle>();
  function clearPoll(key: string): void {
    const h = pollHandles.get(key);
    if (h) {
      h.stop();
      pollHandles.delete(key);
    }
  }

  // How many consecutive failed ticks a status poll tolerates before it gives
  // up. usePoll backs off exponentially on a REJECTED tick (3s → 6s → 12s →
  // 24s → 48s), so this is ~90s of retrying — long enough to ride out a proxy
  // blip against a GPU-bound ingest, short enough not to poll a dead job all
  // afternoon.
  const MAX_POLL_FAILURES = 5;

  // Set when the push poll has stopped retrying, so the page can offer a
  // recheck instead of leaving "push the same papers again" — a duplicate
  // ingest into the tenant graph — as the only way forward.
  let pushPollGaveUp = $state(false);

  // Drop the current push's local state + poll. A new search invalidates the
  // push: its papers are no longer on screen, and a poll that outlives them
  // refills `pushJobs` and flips `pushTerminalReached`, opening Build → Verify
  // for a corpus the reviewer never pushed. (Local reset only — no server
  // cancel; the poll is cleared and the polled function is id-guarded, so
  // nothing from the old push lands.) Mirrors KagDiscoverTab's resetSnowball.
  function resetPush(): void {
    if (pushId !== null) clearPoll(`push:${pushId}`);
    pushId = null;
    pushStatus = null;
    pushError = null;
    pushJobs = [];
    pushPollGaveUp = false;
  }

  // Same, for an in-flight citation walk: never merge a walk seeded from
  // papers that are no longer on screen into the new query's results.
  function resetSnowball(): void {
    if (snowballJobId !== null) clearPoll(`snowball:${snowballJobId}`);
    snowballing = false;
    snowballError = null;
    snowballJobId = null;
    snowballStatus = null;
    snowballDiscovered = 0;
    snowballEdges = 0;
    snowballDepth = 0;
    snowballIds = [];
    snowballAdded = null;
  }

  const canPush = $derived(
    sessionId !== null && selected.length > 0 && !pushing,
  );

  const canSnowball = $derived(
    sessionId !== null &&
      selected.length > 0 &&
      !snowballing &&
      knobs.snowball,
  );

  // True while a snowball job is in flight (so the Cancel button is shown).
  const snowballActive = $derived(
    snowballStatus === 'pending' || snowballStatus === 'running',
  );

  // A terminal push with ≥1 orchestrator job → Build is satisfied (→ Verify).
  const pushTerminalReached = $derived(
    isPushTerminal(pushStatus ?? undefined) && pushJobs.length > 0,
  );

  // Per-stage advance gate (the stepper's Next button + forward rail clicks).
  // What Screening will seal, as canonical-JSON import records.
  //
  // This reads the SESSION, not `results`. `runSearch` clears `results` on
  // every search (:938) and refills it with that query's hits, so a review run
  // across four queries used to seal the fourth and report a PRISMA
  // "identified" count that read as the whole search. The server accumulates
  // across queries; the browser does not.
  //
  // On `unread`/`unreadable` this is deliberately EMPTY — ScreeningPanel
  // already disables the import on `papers.length === 0`, so a session we
  // could not read holds the seal instead of quietly falling back to the
  // screen, which is the original bug restored.
  //
  // The mapping lives in $lib/research/screening-records so its return type is
  // closed: Evidence Review rejects a body carrying a guarded regulatory
  // discriminator at ANY depth, and `PaperResult` has an open index signature.
  const screeningCandidates = $derived(
    toScreeningRecords(
      snapshotState === 'read'
        ? (sessionSnapshot ?? [])
        : snapshotState === 'none'
          ? results
          : [],
    ),
  );

  // Said next to the consent tick, before it is spent — not after.
  const screeningProvenance = $derived<CandidateProvenance>({
    source:
      snapshotState === 'read'
        ? 'session'
        : snapshotState === 'none'
          ? 'screen'
          : 'unknown',
    sessionCount: sessionSnapshot?.length ?? null,
    screenCount: results.length,
    loadedAt: snapshotAt,
    error: snapshotError,
    loading: snapshotLoading,
    reload: () => void loadScreeningSnapshot(),
  });

  // Keyed on the step ID, not its position. Inserting Screening shifted every
  // later index by one, and a positional switch would have silently re-pointed
  // Appraise's gate at Build's condition — a bug with no error and no visible
  // symptom until somebody could not advance.
  const canAdvanceNow = $derived.by(() => {
    switch (STEPS[stage - 1]?.id) {
      case 'input':
        return query.trim().length > 0;
      case 'discover':
        return results.length > 0;
      // Screening is optional: a session may go straight to Appraise, and
      // forcing a review would make the studio unusable for anything that is
      // not a systematic review.
      case 'screening':
        return true;
      case 'appraise':
        return selected.length > 0;
      case 'build':
        return pushTerminalReached;
      case 'verify':
        return true;
      default:
        return false;
    }
  });

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }

  // The source names available in the advanced picker: live if loaded, else the
  // union of every domain's source set (so the picker still works offline).
  const pickerSources = $derived<string[]>(
    liveSources.length > 0
      ? liveSources.map((s) => s.name)
      : Array.from(new Set(DOMAINS.flatMap((d) => d.sources ?? []))).sort(),
  );

  // What the picker may CLAIM about that list. `unreadable` outranks a non-zero
  // count deliberately (see scopeRefs.ts): a list left over from an earlier tick
  // beside a failed read is a stale set shown as if it were current.
  const sourcePickerState = $derived(
    scopeRefState(liveSources.length, sourcesUnreadable),
  );

  // Source chips for the results filter bar (only sources actually returned).
  const resultSources = $derived<string[]>(
    Array.from(
      new Set(results.map((p) => p.source).filter(Boolean) as string[]),
    ).sort(),
  );

  const visibleResults = $derived.by(() => {
    const filtered = results.filter((p) => {
      if (filterSource && p.source !== filterSource) return false;
      if (filterOA && !p.is_open_access) return false;
      if (filterPdf && !p.pdf_url) return false;
      if (filterText.trim()) {
        const t = (p.title ?? '').toLowerCase();
        if (!t.includes(filterText.trim().toLowerCase())) return false;
      }
      return true;
    });
    if (clientSort === 'trust') {
      // Stable sort by trust score desc; unscored papers sink to the bottom.
      return [...filtered].sort((a, b) => {
        const sa = scores[paperIdOf(a) ?? ''] ?? -1;
        const sb = scores[paperIdOf(b) ?? ''] ?? -1;
        return sb - sa;
      });
    }
    return filtered;
  });

  onMount(() => {
    // Best-effort: hydrate the advanced picker with the live source list.
    // Best-effort about the DATA, never about the FACT that it failed — the
    // fallback below is only honest if it is labelled as one.
    sourcesUnreadable = null;
    void researchApi
      .listSources()
      .then((r) => {
        liveSources = (r.sources ?? []).filter((s) => s.enabled !== false);
        sourcesUnreadable = null;
      })
      .catch((e) => {
        liveSources = [];
        // The fallback names the READ, not the error: a throw with no message
        // must still leave the reviewer something reportable.
        sourcesUnreadable = readFailureReason(
          e,
          'The source-list read failed without a message.',
        );
      });

    // Restore a persisted session so the workspace survives a reload. There is
    // no session-list endpoint, so the single stored id is verified with
    // getSession; if it 404s / rejects (server-expired) we drop it.
    const persisted = loadResearchSessionId();
    if (persisted !== null) {
      void researchApi
        .getSession(persisted)
        .then(() => {
          sessionId = persisted;
        })
        .catch(() => {
          saveResearchSessionId(null);
        });
    }
  });

  function toggleSourcePick(name: string): void {
    sourceOverride = sourceOverride.includes(name)
      ? sourceOverride.filter((s) => s !== name)
      : [...sourceOverride, name];
  }

  function resetScope(): void {
    domainOverride = null;
    sourceOverride = [];
    yearMin = null;
    yearMax = null;
    sortBy = knobs.sortBy;
    maxPerSource = knobs.maxPerSource;
  }

  async function runSearch(): Promise<void> {
    if (!query.trim() || searching) return;
    searching = true;
    searchError = null;
    sessionError = null;
    sessionSwitchNotice = null;
    results = [];
    selected = [];
    // The push this search is about to discard.
    //
    // Clearing it BEFORE the await is correct and must stay (#813): a poll that
    // outlives its query refills `pushJobs` and flips `pushTerminalReached`,
    // opening Build → Verify for a corpus the reviewer never pushed. But the
    // catch restored nothing, so a search that THREW discarded a push that is
    // still running server-side — `resetPush()` nulls `pushId`, `recheckPush()`
    // returns early on a null id, and the Recheck button is gated on it, so the
    // ingest became permanently unreachable from this browser. The page's own
    // copy then warns against the only remaining option (pushing the same
    // papers again, a duplicate ingest into the tenant KAG graph).
    //
    // So: discard now, and put it back only if this search never happened.
    const priorPush = {
      id: pushId,
      status: pushStatus,
      error: pushError,
      jobs: pushJobs,
      gaveUp: pushPollGaveUp,
    };
    // Stop the polls before clearing what they write into: clearing alone left
    // the previous query's push/snowball polls alive to refill it.
    resetPush();
    resetSnowball();
    // These describe the PREVIOUS search's sources. Leaving them set meant a
    // search that threw rendered the last search's outage as if it were this
    // one's.
    sourcesQueried = [];
    sourcesFailed = [];
    totalResults = null;
    verifyByEntity = {};
    communitiesResult = null;
    trendResult = null;
    formalResult = null;
    formalConfidence = null;
    formalSaveMsg = null;
    formalProofs = [];
    formalProofsError = null;
    askAnswer = null;
    askCitations = [];
    askError = null;
    ragasResult = null;
    ragasError = null;
    filterText = '';
    filterSource = null;
    filterOA = false;
    filterPdf = false;
    clientSort = 'default';
    scores = {};
    scoreTitles = {};
    scoreComponentsById = {};
    scoreError = null;
    try {
      // Ensure a durable session backbone: persists results (exportable) and
      // enables push. Reused across searches so the session is a working set.
      // Non-fatal — a search still works without one (just no persistence).
      let sid = sessionId;
      if (sid === null) {
        try {
          const s = await researchApi.createSession(query.trim().slice(0, 120));
          sid = s.id ?? null;
          sessionId = sid;
          saveResearchSessionId(sid);
        } catch (e) {
          // A 409 here is not a fault — it is the ONE refusal that names its own
          // remedy, and until now we threw the remedy away.
          //
          // The session is named after the query (`createSession(query…)` above),
          // so searching the same terms twice from a fresh browser always
          // collides with the session the first search created. discovery-engine
          // refuses to discover into a session that already holds a corpus —
          // correctly, because doing so would seal a review export over two runs
          // — and tells the caller "GET it if you meant to continue that
          // corpus". Continuing it IS what the user meant: they typed the same
          // query.
          //
          // Measured before this change: 7 of 7 session creates 409'd in one
          // dev-cluster run, and every one degraded to "No discovery session".
          // Push stayed disabled and Screening fell back to sealing whatever
          // this browser screen was holding instead of the engine-frozen batch —
          // which is the corpus-provenance seam, so the cost was not cosmetic.
          const existing = sessionIdFromCorpusConflict(e);
          if (existing !== null) {
            sid = existing;
            sessionId = sid;
            saveResearchSessionId(sid);
            sessionSwitchNotice = corpusConflictNotice(e);
          } else {
            // Any other failure keeps the old behaviour. The degradation is
            // already visible downstream (no session → Screening seals "this
            // screen only", push stays disabled); what was missing is WHY, so a
            // 401 is distinguishable from a cold upstream.
            sid = null;
            sessionError = errMsg(e);
          }
        }
      }
      const body = buildSearchRequest({
        query,
        domainId: activeDomain,
        // Precedence: explicit picker wins; else, while the chip is auto
        // (no manual override), default to the UNION source scope so an
        // out-of-vocab medical query scopes to medical sources and a
        // multi-domain query searches every matched domain's sources. When
        // the user has picked a chip, follow that chip's domain default.
        sourcesOverride:
          sourceOverride.length > 0
            ? sourceOverride
            : domainOverride === null
              ? inferScopeSources(query)
              : null,
        yearMin,
        yearMax,
        sortBy,
        maxPerSource,
      });
      if (sid) body.session_id = sid;
      const res = await researchApi.search(body);
      results = res.results ?? [];
      const returned = res.session_id ?? sid;
      // Only adopt a *changed* id, and never silently repoint: if the engine
      // returns a different session than the one we threaded, the prior
      // workspace expired server-side — say so instead of orphaning it.
      if (sid !== null && returned !== null && returned !== sid) {
        sessionSwitchNotice = 'Started a new session (the previous one expired).';
      }
      sessionId = returned;
      saveResearchSessionId(sessionId);
      sourcesQueried = res.sources_queried ?? [];
      sourcesFailed = res.sources_failed ?? [];
      totalResults = res.total_results ?? results.length;
    } catch (e) {
      searchError = errMsg(e);
      // No new query landed, so the push this search discarded is still the
      // current one. Put it back, and resume polling under exactly the
      // condition `pushSelected` uses to start it — plus `!gaveUp`, so a poll
      // that had already exhausted its retries is not silently revived behind
      // the Recheck button the user is being offered.
      //
      // `results`/`selected` and the source counters stay cleared: those are
      // #813's, and `page.test.ts` pins that a failed search does not leave the
      // previous search's outage on screen.
      if (priorPush.id !== null) {
        pushId = priorPush.id;
        pushStatus = priorPush.status;
        pushError = priorPush.error;
        pushJobs = priorPush.jobs;
        pushPollGaveUp = priorPush.gaveUp;
        if (!priorPush.gaveUp && (!isPushTerminal(pushStatus) || jobsNeedPolling(pushJobs)))
          startPushPoll(priorPush.id);
      }
    } finally {
      searching = false;
    }
  }

  function toggle(id: string): void {
    selected = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id];
  }

  async function pushSelected(): Promise<void> {
    if (!canPush || sessionId === null) return;
    pushing = true;
    pushError = null;
    pushStatus = null;
    pushJobs = [];
    pushPollGaveUp = false;
    try {
      const res = await researchApi.ingestPush({
        session_id: sessionId,
        paper_ids: selected,
        mode: knobs.ingestMode,
      });
      pushId = res.push_id ?? null;
      pushStatus = res.status ?? 'pushing';
      pushJobs = res.orchestrator_jobs ?? [];
      // The push-level status can return "completed" the instant the jobs are
      // accepted, while each paper's KAG ingestion (entity extraction + linking)
      // is still running. Poll until the per-paper jobs reach a terminal
      // kag_status too, so document_id / entity_ids land in the UI (and Stage 7's
      // graph + Stage 6's verify get something to work with).
      if (pushId && (!isPushTerminal(pushStatus) || jobsNeedPolling(pushJobs)))
        startPushPoll(pushId);
    } catch (e) {
      pushError = errMsg(e);
    } finally {
      pushing = false;
    }
  }

  // True while any pushed paper's KAG ingestion hasn't reached a terminal
  // kag_status yet — i.e. its entity_ids may still be on the way.
  function jobsNeedPolling(jobs: OrchestratorJob[]): boolean {
    return jobs.some((j) => !isKagTerminal(j.kag_status));
  }

  function startPushPoll(id: string): void {
    clearPoll(`push:${id}`);
    pushPollGaveUp = false;
    let failures = 0;
    const handle = usePoll(
      async () => {
        try {
          const detail = await researchApi.getIngestPushStatus(id);
          // A response for a push this page has moved on from must not
          // repaint the state a new search just cleared: stopping the timer
          // does not un-send a request that was already in flight.
          if (pushId !== id) return;
          failures = 0;
          pushError = null;
          pushStatus = detail.status ?? 'unknown';
          if (detail.orchestrator_jobs) pushJobs = detail.orchestrator_jobs;
          if (isPushTerminal(pushStatus) && !jobsNeedPolling(pushJobs))
            clearPoll(`push:${id}`);
        } catch (e) {
          if (pushId !== id) return;
          failures += 1;
          if (failures >= MAX_POLL_FAILURES) {
            pushPollGaveUp = true;
            pushError = `Lost contact with the ingest after ${MAX_POLL_FAILURES} attempts (${errMsg(e)}). The push may still be running — recheck it rather than pushing the same papers again.`;
            clearPoll(`push:${id}`);
            return;
          }
          pushError = `Contact with the ingest failed (${errMsg(e)}) — retrying.`;
          // Rethrow: usePoll counts the failure and backs off (poll.ts:106).
          // Swallowing it here and clearing the poll is what let one transient
          // 502 freeze pushStatus — and the Build → Verify gate — forever.
          throw e;
        }
      },
      { intervalMs: 3000 },
    );
    pollHandles.set(`push:${id}`, handle);
    handle.start();
  }

  // Resume polling a push whose status poll gave up. The ingest itself is
  // server-side and unaffected by our losing contact with it.
  function recheckPush(): void {
    if (pushId === null) return;
    pushError = null;
    pushPollGaveUp = false;
    startPushPoll(pushId);
  }

  async function snowballSelected(): Promise<void> {
    if (!canSnowball || sessionId === null) return;
    snowballing = true;
    snowballError = null;
    snowballStatus = null;
    snowballDiscovered = 0;
    snowballEdges = 0;
    snowballDepth = 0;
    snowballAdded = null;
    try {
      const res = await researchApi.startSnowball({
        seed_paper_ids: selected,
        session_id: sessionId,
        direction: sbDirection,
        max_depth: sbDepth,
        max_papers: sbMaxPapers,
      });
      snowballJobId = res.job_id ?? null;
      snowballStatus = res.status ?? 'pending';
      snowballDiscovered = res.papers_discovered ?? 0;
      snowballEdges = res.edges_discovered ?? 0;
      snowballDepth = res.current_depth ?? 0;
      if (snowballJobId && !isSnowballTerminal(snowballStatus)) {
        startSnowballPoll(snowballJobId);
      } else if (isSnowballTerminal(snowballStatus)) {
        await onSnowballTerminal();
      }
    } catch (e) {
      snowballError = errMsg(e);
    } finally {
      snowballing = false;
    }
  }

  function startSnowballPoll(id: string): void {
    clearPoll(`snowball:${id}`);
    let failures = 0;
    const handle = usePoll(
      async () => {
        try {
          const detail = await researchApi.getSnowballStatus(id);
          // The walk this page is showing may no longer be this one.
          if (snowballJobId !== id) return;
          failures = 0;
          snowballStatus = detail.status ?? 'unknown';
          snowballDiscovered = detail.papers_discovered ?? snowballDiscovered;
          snowballEdges = detail.edges_discovered ?? snowballEdges;
          snowballDepth = detail.current_depth ?? snowballDepth;
          if (detail.error) snowballError = detail.error;
          else snowballError = null;
          if (isSnowballTerminal(snowballStatus)) {
            clearPoll(`snowball:${id}`);
            await onSnowballTerminal();
          }
        } catch (e) {
          if (snowballJobId !== id) return;
          failures += 1;
          if (failures >= MAX_POLL_FAILURES) {
            snowballError = `Lost contact with the citation walk after ${MAX_POLL_FAILURES} attempts (${errMsg(e)}). The walk may still be running.`;
            clearPoll(`snowball:${id}`);
            return;
          }
          snowballError = `Contact with the citation walk failed (${errMsg(e)}) — retrying.`;
          // Rethrow so usePoll backs off instead of the walk dying on a blip.
          throw e;
        }
      },
      { intervalMs: 3000 },
    );
    pollHandles.set(`snowball:${id}`, handle);
    handle.start();
  }

  // Stable dedup key: paper id when present, else a normalised title. Empty when
  // the paper is truly anonymous (neither) and therefore cannot be rendered.
  function paperKey(p: PaperResult): string {
    const id = paperIdOf(p);
    if (id) return `id:${id}`;
    const title = typeof p.title === 'string' ? p.title.trim().toLowerCase() : '';
    return title ? `t:${title}` : '';
  }

  // On a completed walk with new papers, pull them out of the session (the
  // discovered set is persisted there, not in the job response) and merge any
  // not already shown into the results list, flagged "via snowball".
  async function onSnowballTerminal(): Promise<void> {
    if (
      snowballStatus !== 'completed' ||
      snowballDiscovered <= 0 ||
      sessionId === null
    ) {
      return;
    }
    try {
      const res = await researchApi.exportSession(sessionId, 'json');
      const parsed = JSON.parse(res.data ?? '{}') as {
        papers?: PaperResult[];
      };
      // Dedup on a stable key: the paper id when present, otherwise a normalised
      // title. This recovers id-less-but-titled papers the engine counted yet
      // that were previously silently dropped (id-only dedup). Truly anonymous
      // papers (no id, no title) have no key → still can't be rendered.
      const known = new Set(results.map(paperKey).filter(Boolean));
      const seen = new Set<string>();
      const fresh = (parsed.papers ?? []).filter((p) => {
        const key = paperKey(p);
        if (key === '' || known.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      snowballAdded = fresh.length;
      if (fresh.length > 0) {
        snowballIds = [
          ...snowballIds,
          ...(fresh.map((p) => paperIdOf(p)).filter(Boolean) as string[]),
        ];
        results = [...results, ...fresh];
      }
    } catch (e) {
      snowballError = `could not load discovered papers: ${errMsg(e)}`;
    }
  }

  async function cancelSnowball(): Promise<void> {
    if (snowballJobId === null) return;
    clearPoll(`snowball:${snowballJobId}`);
    try {
      const res = await researchApi.cancelSnowball(snowballJobId);
      snowballStatus = res.status ?? 'cancelled';
    } catch (e) {
      snowballError = errMsg(e);
    }
  }

  onDestroy(() => {
    for (const key of Array.from(pollHandles.keys())) clearPoll(key);
  });
</script>

<div class="px-6 py-4 flex flex-col gap-4" data-testid="research-page">
  <!-- Above the header, not inside it: the header is a justify-between flex row,
       and a third child would push the h1 to the middle. -->
  <CockpitBackLink />
  <header class="flex items-baseline justify-between gap-4">
    <h1 class="text-2xl font-semibold">Scientific Research</h1>
    <!--
      Derived from STEPS, never restated. This line was a hardcoded
      "input → discover → appraise → build → verify → synthesize" and silently
      lost Screening the moment the stage was added — the rail showed seven
      steps and the summary above it listed six, in the same viewport.
    -->
    <span class="text-sm text-[var(--color-text-muted)]" data-testid="research-stage-summary"
      >{STEPS.map((s) => s.id).join(' → ')}</span
    >
  </header>

  <!-- Rigor preset bar -->
  <div
    class="flex flex-wrap items-center gap-2 text-sm"
    data-testid="research-preset-bar"
  >
    <span class="text-[var(--color-text-muted)]">Rigor</span>
    {#each PRESET_ORDER as p (p)}
      <button
        type="button"
        data-testid={`research-preset-${p}`}
        aria-pressed={preset === p}
        onclick={() => applyPreset(p)}
        class={`rounded-full border px-3 py-1 ${
          preset === p
            ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)] border-[var(--color-accent)]'
            : 'bg-[var(--color-bg)] dark:bg-[var(--color-surface)]'
        }`}
      >
        {PRESET_LABELS[p]}
      </button>
    {/each}
  </div>

  <ResearchStepper
    steps={STEPS}
    current={stage}
    canAdvance={canAdvanceNow}
    {maxReached}
    onnavigate={goStage}
    panel={stagePanel}
  />
</div>

{#snippet stagePanel(id: string)}
  {#if id === 'input'}{@render stageInput()}
  {:else if id === 'discover'}{@render stageDiscover()}
  {:else if id === 'screening'}{@render stageScreening()}
  {:else if id === 'appraise'}{@render stageAppraise()}
  {:else if id === 'build'}{@render stageBuild()}
  {:else if id === 'verify'}{@render stageVerify()}
  {:else if id === 'synthesize'}{@render stageSynthesize()}
  {/if}
{/snippet}

<!-- ───────────────────────── Stage 1: Input ───────────────────────── -->
{#snippet stageInput()}
  <section
    class="rounded border bg-[var(--color-bg)] p-4 shadow-sm dark:bg-[var(--color-surface)] flex flex-col gap-3"
    data-testid="research-input"
  >
    <label class="flex flex-col gap-1">
      <span class="text-sm font-medium">Your research input</span>
      <input
        id="research-query"
        data-testid="research-query"
        bind:value={query}
        placeholder="A question, topic, paper title, DOI or arXiv id…"
        class="rounded border px-3 py-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      />
    </label>
    <div class="flex flex-wrap items-center gap-2 text-sm" data-testid="research-input-detected">
      <span class="text-[var(--color-text-muted)]">Looks like</span>
      <span
        class="rounded-full border px-2 py-0.5 bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]"
        data-testid="research-input-type-pill">{INPUT_TYPE_LABELS[effectiveInputType]}</span
      >
      <label class="flex items-center gap-1">
        <span class="text-[var(--color-text-muted)]">override</span>
        <select
          data-testid="research-input-type"
          bind:value={inputOverride}
          class="rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        >
          <option value={null}>auto-detect</option>
          {#each INPUT_TYPES as t (t)}
            <option value={t}>{INPUT_TYPE_LABELS[t]}</option>
          {/each}
        </select>
      </label>
    </div>
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="research-input-hint">
      Have a raw document (PDF, paper file)? Upload it in the
      <a href="/library/kag/documents" class="underline text-[var(--color-accent)]">KAG workspace</a>,
      then return here to ask &amp; verify against the graph. Otherwise enter a
      topic/question above and continue to discovery.
    </p>
  </section>
{/snippet}

<!-- ──────────────────────── Stage 2: Discover ──────────────────────── -->
{#snippet stageDiscover()}
  <section
    class="rounded border bg-[var(--color-bg)] p-4 shadow-sm dark:bg-[var(--color-surface)] flex flex-col gap-3"
    data-testid="research-scope"
  >
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void runSearch();
      }}
      class="flex gap-2"
    >
      <input
        data-testid="research-query-discover"
        bind:value={query}
        placeholder="A question, topic, or paper title…"
        class="flex-1 rounded border px-3 py-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      />
      <button
        type="submit"
        data-testid="research-search-btn"
        disabled={searching || !query.trim()}
        class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] disabled:opacity-50"
      >
        {searching ? 'Searching…' : 'Search'}
      </button>
    </form>

    <!-- Domain chips (smart-suggested, changeable) -->
    <div class="flex flex-col gap-1">
      <div class="flex flex-wrap gap-2 items-center" data-testid="research-domains">
        {#each DOMAINS as d (d.id)}
          <button
            type="button"
            data-testid={`research-domain-${d.id}`}
            aria-pressed={activeDomain === d.id}
            onclick={() => (domainOverride = d.id)}
            title={d.hint}
            class={`text-sm rounded-full border px-3 py-1 ${
              activeDomain === d.id
                ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)] border-[var(--color-accent)]'
                : 'bg-[var(--color-bg)] dark:bg-[var(--color-surface)]'
            }`}
          >
            {d.label}
          </button>
        {/each}
      </div>
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="research-domain-hint">
        {#if domainOverride === null && query.trim()}
          Detected <strong>{domainById(activeDomain).label}</strong> from your query
          — change anytime.
        {:else}
          Searching <strong>{domainById(activeDomain).label}</strong>
          {#if sourceOverride.length === 0}· {domainById(activeDomain).hint}{/if}
        {/if}
      </p>
    </div>

    <!-- Secondary scope controls -->
    <div class="flex flex-wrap gap-4 items-end text-sm">
      <label class="flex flex-col gap-1">
        <span class="text-[var(--color-text-muted)]">Year from</span>
        <input
          type="number"
          data-testid="research-year-min"
          bind:value={yearMin}
          placeholder="any"
          class="w-24 rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-[var(--color-text-muted)]">Year to</span>
        <input
          type="number"
          data-testid="research-year-max"
          bind:value={yearMax}
          placeholder="any"
          class="w-24 rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-[var(--color-text-muted)]">Sort by</span>
        <select
          data-testid="research-sort"
          bind:value={sortBy}
          class="rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        >
          <option value="relevance">Relevance</option>
          <option value="citation_count">Most cited</option>
          <option value="year">Newest</option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-[var(--color-text-muted)]">Per source</span>
        <input
          type="number"
          min="1"
          max="100"
          data-testid="research-per-source"
          bind:value={maxPerSource}
          class="w-20 rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        />
      </label>
      <button
        type="button"
        class="text-xs underline text-[var(--color-text-muted)] pb-1"
        onclick={resetScope}>Reset scope</button
      >
    </div>

    <!-- Advanced: explicit source picker -->
    <details bind:open={advancedOpen} data-testid="research-advanced-sources">
      <summary class="text-sm cursor-pointer text-[var(--color-text-muted)]"
        >Advanced: choose sources {sourceOverride.length > 0
          ? `(${sourceOverride.length} selected — overrides domain)`
          : '(empty = follow domain)'}</summary
      >
      {#if sourcePickerState === 'unreadable'}
        <!-- ⚠️ Do NOT let the built-in union stand in silently. `pickerSources`
             substitutes it the moment the live read fails, so without this line
             the reviewer picks a scope from a hardcoded list believing it is
             what the engine will query. A source can be missing from it, or
             listed in it and unavailable — the set is UNKNOWN, not known to be
             this one. -->
        <p
          class="mt-2 text-xs text-[var(--color-warning-text)]"
          data-testid="research-sources-unreadable"
          role="alert"
        >
          The live source list could not be read, so the sources below are a
          built-in <strong>fallback</strong>, not the engine's current set. The
          available sources are <strong>unknown</strong> — not known to be these.
          A pick made here may not be queried, and a source that is available may
          be missing. Retry, and report this if it persists.
          <span class="block pt-1 font-mono text-[var(--color-text-muted)]"
            >{sourcesUnreadable}</span
          >
        </p>
      {/if}
      <div class="flex flex-wrap gap-3 mt-2">
        {#each pickerSources as name (name)}
          <label class="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={sourceOverride.includes(name)}
              onchange={() => toggleSourcePick(name)}
            />
            {name}
          </label>
        {/each}
      </div>
    </details>

    {#if sessionSwitchNotice}
      <p class="text-xs text-[var(--color-warning-text)]" data-testid="research-session-switched">
        {sessionSwitchNotice}
      </p>
    {/if}

    {#if searchError}
      <p class="text-sm text-[var(--color-danger)]" data-testid="research-search-error">
        {searchError}
      </p>
    {/if}

    {#if sessionError}
      <p class="text-xs text-[var(--color-warning-text)]" data-testid="research-session-error">
        No discovery session: {sessionError}. This search still ran, but its
        results are not persisted and cannot be pushed to the graph.
      </p>
    {/if}
  </section>

  {#if results.length > 0}
    <section class="flex flex-col gap-2 mt-3">
      {@render resultSummary()}
      {@render snowballBar()}
      {@render resultsList()}
    </section>
  {:else if sourcesFailed.length > 0 && !searching}
    <!--
      Nothing came back AND at least one source never answered. "No results"
      would be a claim about the reviewer's query that the search did not
      earn — PubMed / Semantic Scholar / arXiv rate-limit routinely, and the
      studio used to blame itself for their outage. Say who was unreachable.
    -->
    <section
      class="rounded border border-[var(--color-danger)] p-4 text-sm mt-3 flex flex-col gap-1"
      data-testid="research-sources-unavailable"
    >
      <p class="font-medium text-[var(--color-danger)]">
        {sourcesFailed.length} of {Math.max(sourcesQueried.length, sourcesFailed.length)}
        {sourcesFailed.length === 1 ? 'source is' : 'sources are'} unavailable: {sourcesFailed.join(
          ', ',
        )}
      </p>
      {#if sourcesAnswering.length === 0}
        <p class="text-[var(--color-text-muted)]">
          No source answered, so this is not a finding about your query. These
          sources rate-limit routinely — retry in a moment.
        </p>
      {:else}
        <p class="text-[var(--color-text-muted)]">
          {sourcesAnswering.join(', ')} answered and returned nothing. Retry to include
          the unavailable
          {sourcesFailed.length === 1 ? 'source' : 'sources'}, or widen the year
          range.
        </p>
      {/if}
    </section>
  {:else if totalResults === 0 && !searching}
    <section
      class="rounded border p-4 text-sm text-[var(--color-text-muted)] mt-3"
      data-testid="research-empty"
    >
      No results. Try a different domain, widen the year range, or broaden the
      sources.
    </section>
  {/if}
{/snippet}

<!-- ─────────────────────── Stage 3: Screening ─────────────────────── -->
{#snippet stageScreening()}
  <!--
    `subject` was declared on the panel and never passed, so the "acting as"
    badge was dead markup and the three-context dual drive had nothing on screen
    distinguishing one reviewer from another.

    This is the identity THIS browser holds. It is not necessarily the subject
    the service acted as — under `AUTH_BYPASS`, or behind an edge that stamps
    `X-Subject-Id`, the two can differ and the page cannot see it — which is why
    the panel prefers `queue.acting_subject_id` when Evidence Review starts
    returning it and treats this as the fallback.
  -->
  <ScreeningPanel
    papers={screeningCandidates}
    provenance={screeningProvenance}
    {sessionId}
    subject={auth.user?.id ?? ''}
  />
{/snippet}

<!-- ──────────────────────── Stage 4: Appraise ──────────────────────── -->
{#snippet stageAppraise()}
  {#if results.length > 0}
    <section class="flex flex-col gap-2" data-testid="research-appraise">
      {@render resultSummary()}
      {@render filterBar()}
      {@render resultsList()}
      <div class="mt-2 border-t pt-3">
        <SessionQualityPanel
          {sessionId}
          ondelete={() => {
            sessionId = null;
            saveResearchSessionId(null);
          }}
        />
      </div>
    </section>
  {:else}
    <section
      class="rounded border p-4 text-sm text-[var(--color-text-muted)]"
      data-testid="research-appraise-empty"
    >
      Nothing to appraise yet — run a search in the Discover stage first.
    </section>
  {/if}
{/snippet}

<!-- ───────────────────────── Stage 5: Build ────────────────────────── -->
{#snippet stageBuild()}
  <section
    class="rounded border p-3 bg-[var(--color-bg)] dark:bg-[var(--color-surface)] flex flex-col gap-2"
    data-testid="research-build"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-sm font-semibold">Build knowledge</h2>
      <button
        type="button"
        data-testid="research-push-btn"
        disabled={!canPush}
        onclick={() => void pushSelected()}
        title={sessionId === null
          ? 'Searching creates a session; push will enable once a session exists'
          : ''}
        class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] disabled:opacity-50"
      >
        {pushing ? 'Pushing…' : `Push ${selected.length} to graph`}
      </button>
    </div>
    <p class="text-xs text-[var(--color-text-muted)]">
      Ingest the {selected.length} selected
      {selected.length === 1 ? 'paper' : 'papers'} ({knobs.ingestMode}): fetch full
      text when available else the abstract → extract entities → link them into your
      tenant's KAG graph.
    </p>

    {#if pushId}<p class="text-sm text-[var(--color-text-muted)]">
        push {pushId} — {pushStatus ?? 'pushing'}
      </p>{/if}
    {#if pushError}
      <p class="text-sm text-[var(--color-danger)]" data-testid="research-push-error">
        {pushError}
      </p>
    {/if}
    {#if pushPollGaveUp && pushId}
      <div>
        <button
          type="button"
          data-testid="research-push-recheck"
          onclick={recheckPush}
          class="rounded border px-3 py-1 text-sm"
        >
          Recheck this push
        </button>
      </div>
    {/if}

    {#if pushJobs.length > 0}
      <ul class="flex flex-col gap-1 mt-1" data-testid="research-push-jobs">
        {#each pushJobs as job (job.paper_id ?? job.orchestrator_job_id)}
          {@const entityCount = job.entity_ids?.length ?? 0}
          {@const title =
            (job.paper_id && titleById.get(job.paper_id)) || job.paper_id}
          <li
            class="text-sm flex flex-wrap items-center gap-2 border-t pt-1 first:border-t-0 first:pt-0"
            data-testid="research-push-job"
          >
            <span class="font-medium truncate max-w-md">{title ?? 'paper'}</span>
            <span
              class={`text-xs rounded px-1.5 py-0.5 border ${
                job.kag_status === 'completed'
                  ? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)]'
                  : job.kag_status === 'failed'
                    ? 'bg-[var(--color-danger)] text-[var(--color-on-primary)]'
                    : 'bg-[var(--color-surface)]'
              }`}
              data-testid="research-push-job-status"
              >{job.kag_status ?? job.status ?? 'pending'}</span
            >
            {#if entityCount > 0}
              <span class="text-xs" data-testid="research-push-job-entities"
                >{entityCount}
                {entityCount === 1 ? 'entity' : 'entities'} added</span
              >
            {/if}
            {#if job.document_id}
              <span
                class="text-xs text-[var(--color-text-muted)] font-mono truncate"
                title={job.document_id}
                data-testid="research-push-job-doc">doc {job.document_id}</span
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/snippet}

<!-- ───────────────────────── Stage 6: Verify ───────────────────────── -->
{#snippet stageVerify()}
  <section
    class="rounded border p-3 bg-[var(--color-bg)] dark:bg-[var(--color-surface)] flex flex-col gap-3"
    data-testid="research-verify"
  >
    <h2 class="text-sm font-semibold">Verify</h2>
    {#if verifiableEntities.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="research-verify-empty">
        Nothing to verify yet — push papers in the Build stage to create graph
        entities, then verify them here.
      </p>
    {:else}
      <!-- Per-entity: integrity + topology + CoVe + async explainability -->
      <ul class="flex flex-col gap-2" data-testid="research-verify-jobs">
        {#each verifiableEntities as ent (ent.entityId)}
          {@const v = verifyByEntity[ent.entityId]}
          <li
            class="flex flex-col gap-1 border-t pt-2 first:border-t-0 first:pt-0"
            data-testid="research-verify-job"
          >
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="font-medium truncate max-w-md">{ent.title}</span>
              <button
                type="button"
                data-testid="research-verify-btn"
                disabled={v?.running}
                onclick={() => void verifyEntity(ent.entityId, ent.title)}
                class="text-xs underline text-[var(--color-accent)] disabled:opacity-50"
              >
                {v?.running ? 'Verifying…' : v ? 'Re-verify' : 'Verify'}
              </button>
              {#if v?.explain}
                <span
                  class="text-xs text-[var(--color-text-muted)]"
                  data-testid="research-verify-explain"
                  >explainability {v.explain.status ?? 'pending'}</span
                >
              {/if}
              {#if v?.error}
                <span class="text-xs text-[var(--color-danger)]" data-testid="research-verify-error"
                  >verify failed</span
                >
              {/if}
            </div>
            {#if v?.explain?.status === 'completed'}
              {@const topNodes = explainTopK(v.explain.explanation)}
              {#if topNodes.length > 0}
                <ul
                  class="flex flex-col gap-0.5 text-xs text-[var(--color-text-muted)] pl-2"
                  data-testid="research-verify-explain-detail"
                >
                  {#each topNodes as n, i (i)}
                    <li class="flex items-center gap-1">
                      <span class="truncate max-w-xs" title={n.label}>{n.label}</span>
                      {#if typeof n.score === 'number'}
                        <span class="text-[var(--color-text-subtle)]"
                          >{n.score.toFixed(3)}</span
                        >
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
            {#if v?.integrity || v?.cove || v?.contradictions}
              {@const authorityScore = v?.authority?.scores?.[ent.entityId]}
              {@const authorityRank = v?.authority?.top_entities?.findIndex(
                (e) => (e?.['entity_id'] ?? e?.['id']) === ent.entityId,
              )}
              {@const community = communitiesResult?.entity_communities?.[ent.entityId]}
              <TrustBreakdown integrity={v?.integrity} />
              <ul class="flex flex-col gap-1">
                <ClaimLedgerRow
                  claim={ent.title}
                  cove={v?.cove}
                  contradictions={v?.contradictions}
                  running={v?.running}
                />
              </ul>
              <div class="flex flex-wrap gap-3 text-xs text-[var(--color-text-muted)]">
                {#if typeof authorityScore === 'number'}
                  <span data-testid="research-verify-authority"
                    >authority {authorityScore.toFixed(2)}{#if v?.authority
                      ?.algorithm}{' · '}{v.authority.algorithm}{/if}{#if typeof authorityRank ===
                      'number' &&
                      authorityRank >= 0}{' · #'}{authorityRank + 1}{#if typeof v?.authority
                        ?.entity_count === 'number'}{' of '}{v.authority.entity_count}{/if}{/if}</span
                  >
                {/if}
                {#if v?.subgraph?.nodes}
                  {@const edgeCount = v.subgraph.edge_count ?? v.subgraph.edges?.length}
                  <span data-testid="research-verify-subgraph"
                    >subgraph {v.subgraph.nodes.length} nodes{#if typeof edgeCount ===
                      'number'}{' · '}{edgeCount} edges{/if}{#if typeof v.subgraph.max_hops_used ===
                      'number'}{' · '}{v.subgraph.max_hops_used} hops{/if}</span
                  >
                {/if}
                {#if community !== undefined}
                  <span data-testid="research-verify-community"
                    >community {community}</span
                  >
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if verifyTruncated}
        <p
          class="text-[10px] text-[var(--color-text-muted)]"
          data-testid="research-verify-truncated"
        >
          Showing the first {MAX_VERIFY_ENTITIES} entities; some pushed papers'
          entities are not listed here.
        </p>
      {/if}

      <!-- Graph-wide analyses -->
      <div class="flex flex-col gap-2 border-t pt-2" data-testid="research-verify-graphwide">
        <span class="text-sm font-semibold">Graph-wide</span>
        <div class="flex flex-wrap items-center gap-3 text-xs">
          <button
            type="button"
            data-testid="research-communities-btn"
            disabled={communitiesRunning}
            onclick={() => void runCommunities()}
            class="rounded border px-2 py-1 disabled:opacity-50"
            >{communitiesRunning ? 'Detecting…' : 'Detect communities'}</button
          >
          {#if typeof communitiesResult?.number_of_communities === 'number'}
            <span data-testid="research-communities-result"
              >{communitiesResult.number_of_communities} communities{#if typeof communitiesResult.modularity ===
                'number'}{' · modularity '}{communitiesResult.modularity.toFixed(2)}{/if}</span
            >
          {/if}
          {#if communitiesResult?.algorithm}
            <span
              class="text-[var(--color-text-muted)]"
              data-testid="research-communities-algorithm"
              >{communitiesResult.algorithm}</span
            >
          {/if}
          {#if topCommunities.length > 0}
            <span
              class="flex flex-wrap items-center gap-1"
              data-testid="research-community-sizes"
            >
              {#each topCommunities as c (c.id)}
                <span
                  class="rounded border px-1.5 py-0.5"
                  data-testid={`research-community-size-${c.id}`}
                  >community {c.id} · {c.size}
                  {c.size === 1 ? 'member' : 'members'}</span
                >
              {/each}
            </span>
          {/if}
          {#if communitiesError}
            <span class="text-[var(--color-danger)]">{communitiesError}</span>
          {/if}

          <button
            type="button"
            data-testid="research-trend-btn"
            disabled={trendRunning || !knobs.trend}
            onclick={() => void runTrend()}
            title={!knobs.trend
              ? `Citation-trend analysis is off in the ${PRESET_LABELS[preset]} rigor preset`
              : ''}
            class="rounded border px-2 py-1 disabled:opacity-50"
            >{trendRunning ? 'Analysing…' : 'Citation trend'}</button
          >
          {#if !knobs.trend}
            <span
              class="text-[var(--color-text-muted)]"
              data-testid="research-trend-preset-hint"
              >off in the {PRESET_LABELS[preset]} preset</span
            >
          {/if}
          {#if trendResult && typeof trendResult.slope === 'number'}
            <span data-testid="research-trend-result"
              >trend {trendResult.trend ?? ''} (slope {trendResult.slope.toFixed(2)}){#if typeof trendResult.p_value ===
                'number'}{' · p='}{trendResult.p_value.toFixed(3)}{/if}{#if typeof trendResult.statistic ===
                'number'}{' · stat '}{trendResult.statistic.toFixed(2)}{/if}</span
            >
          {/if}
          {#if trendError}
            <span class="text-[var(--color-danger)]" data-testid="research-trend-error"
              >{trendError}</span
            >
          {/if}
        </div>

        <div class="flex flex-col gap-2">
          <!-- Step 1: translate a plain-language claim into a formal expression -->
          <form
            class="flex flex-wrap items-center gap-2 text-xs"
            onsubmit={(e) => {
              e.preventDefault();
              void runTranslate();
            }}
          >
            <input
              data-testid="research-formal-nl"
              bind:value={formalNl}
              placeholder="Plain-language claim, e.g. every dose lowers blood pressure"
              class="flex-1 min-w-60 rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
            />
            <button
              type="submit"
              data-testid="research-formal-translate-btn"
              disabled={formalTranslating || !formalNl.trim()}
              class="rounded border px-2 py-1 disabled:opacity-50"
              >{formalTranslating ? 'Translating…' : 'Translate → formal'}</button
            >
            {#if formalConfidence !== null}
              <span
                class="text-[var(--color-text-muted)]"
                data-testid="research-formal-confidence"
                >confidence {(formalConfidence * 100).toFixed(0)}%</span
              >
            {/if}
            {#if formalTranslateError}
              <span
                class="text-[var(--color-danger)]"
                data-testid="research-formal-translate-error">{formalTranslateError}</span
              >
            {/if}
          </form>

          <!-- Step 2: verify the formal expression (editable; or type one directly) -->
          <form
            class="flex flex-wrap items-center gap-2 text-xs"
            onsubmit={(e) => {
              e.preventDefault();
              void runFormal();
            }}
          >
            <input
              data-testid="research-formal-input"
              bind:value={formalClaim}
              placeholder="Formal expression, e.g. x > 0 and x < 1"
              class="flex-1 min-w-60 rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
            />
            <button
              type="submit"
              data-testid="research-formal-btn"
              disabled={formalRunning || !formalClaim.trim()}
              class="rounded border px-2 py-1 disabled:opacity-50"
              >{formalRunning ? 'Checking…' : 'Formal verify'}</button
            >
            {#if formalResult}
              <span data-testid="research-formal-result"
                >{formalResult.is_valid === true
                  ? '✓ valid'
                  : formalResult.is_valid === false
                    ? '✗ invalid'
                    : (formalResult.proof ?? 'undecidable')}</span
              >
              <button
                type="button"
                data-testid="research-formal-save-btn"
                disabled={formalSaving || !formalClaim.trim()}
                onclick={() => void saveProof()}
                class="rounded border px-2 py-1 disabled:opacity-50"
                >{formalSaving ? 'Saving…' : 'Save proof'}</button
              >
              {#if formalSaveMsg}
                <span
                  class="text-[var(--color-text-muted)]"
                  data-testid="research-formal-save-msg">{formalSaveMsg}</span
                >
              {/if}
            {/if}
            <button
              type="button"
              data-testid="research-formal-load-btn"
              disabled={!formalNl.trim() && !formalClaim.trim()}
              onclick={() => void loadProofs()}
              class="rounded border px-2 py-1 disabled:opacity-50">Saved proofs</button
            >
            {#if formalError}
              <span class="text-[var(--color-danger)]" data-testid="research-formal-error"
                >{formalError}</span
              >
            {/if}
          </form>

          {#if formalProofs.length > 0}
            <ul
              class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]"
              data-testid="research-formal-proofs"
            >
              {#each formalProofs as p, i (i)}
                <li>
                  {p.is_valid === true ? '✓' : p.is_valid === false ? '✗' : '·'}
                  <code>{p.expression ?? ''}</code>
                  {#if p.language}<span> ({p.language})</span>{/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if formalProofsError}
            <span
              class="text-[var(--color-danger)]"
              data-testid="research-formal-proofs-error">{formalProofsError}</span
            >
          {/if}
        </div>

        <SandboxCell />
      </div>
    {/if}
  </section>
{/snippet}

<!-- ─────────────────────── Stage 7: Synthesize ─────────────────────── -->
{#snippet stageSynthesize()}
  <DeliverableTabs
    answer={dAnswer}
    review={dReview}
    ledger={dLedger}
    corpus={dCorpus}
    graph={dGraph}
    synthesis={dSynthesis}
  />
{/snippet}

<!-- Deliverable (a): verified answer + citations -->
{#snippet dAnswer()}
  <div class="flex flex-col gap-2" data-testid="research-ask">
    <h2 class="text-sm font-semibold">Verified answer &amp; citations</h2>
    <form
      class="flex flex-wrap gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        void askCorpus();
      }}
    >
      <input
        data-testid="research-ask-query"
        bind:value={askQuery}
        placeholder="Ask a question about what you pushed…"
        class="flex-1 min-w-60 rounded border px-3 py-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      />
      {#if askableDocs.length > 0}
        <select
          data-testid="research-ask-scope"
          bind:value={askDocId}
          class="rounded border px-2 py-2 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        >
          <option value="">Whole graph</option>
          {#each askableDocs as d (d.docId)}
            <option value={d.docId}>{d.title}</option>
          {/each}
        </select>
      {/if}
      <button
        type="submit"
        data-testid="research-ask-btn"
        disabled={asking || !askQuery.trim()}
        class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] disabled:opacity-50"
      >
        {asking ? 'Asking…' : 'Ask'}
      </button>
    </form>

    {#if askError}
      <p class="text-sm text-[var(--color-danger)]" data-testid="research-ask-error">
        {askError}
      </p>
    {/if}

    {#if askAnswer}
      <div
        class="rounded border p-3 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        data-testid="research-ask-answer"
      >
        <div class="flex items-start justify-between gap-2">
          <p class="whitespace-pre-line">{askAnswer}</p>
          <button
            type="button"
            data-testid="research-answer-copy"
            disabled={!askAnswer}
            onclick={() => void copyAnswer()}
            class="shrink-0 rounded border px-2 py-1 text-xs text-[var(--color-text-muted)] disabled:opacity-50"
            >{answerCopied ? 'Copied' : 'Copy answer'}</button
          >
        </div>
        {#if askCitations.length > 0}
          <div class="mt-2 text-xs text-[var(--color-text-muted)]">
            <span class="font-medium">Citations</span>
            <ul class="list-disc pl-5">
              {#each askCitations as c, i (i)}
                {@const cTitle =
                  (c['title'] as string) ?? (c['doc_id'] as string) ?? 'source'}
                {@const verdict = citationVerdict(cTitle)}
                <li>
                  {cTitle}
                  {#if c['url']}
                    {@const cHref = safeHref(c['url'])}
                    {#if cHref}
                      <a
                        href={cHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="underline text-[var(--color-accent)]"
                        data-testid="research-citation-link">link</a
                      >
                    {:else}
                      <span class="break-all" data-testid="research-citation-url-text"
                        >{String(c['url'])}</span
                      >
                    {/if}
                  {/if}
                  {#if verdict}
                    <span
                      class="rounded px-1 py-0.5 border bg-[var(--color-surface)]"
                      data-testid="research-citation-verdict">{verdict}</span
                    >
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <!-- RAGAS faithfulness scoring of the generated answer -->
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="research-ragas-btn"
            disabled={ragasRunning || !knobs.ragas}
            onclick={() => void runRagas()}
            title={!knobs.ragas
              ? `RAGAS faithfulness scoring is off in the ${PRESET_LABELS[preset]} rigor preset`
              : ''}
            class="rounded border px-2 py-1 text-xs disabled:opacity-50"
            >{ragasRunning ? 'Scoring…' : 'Score answer (RAGAS)'}</button
          >
          {#if !knobs.ragas}
            <span
              class="text-xs text-[var(--color-text-muted)]"
              data-testid="research-ragas-preset-hint"
              >off in the {PRESET_LABELS[preset]} preset</span
            >
          {/if}
          {#if ragasResult}
            {@const relevancy = ragasResult.answer_relevancy ?? ragasResult.answer_relevance}
            <span class="text-xs" data-testid="research-ragas-result">
              {#if typeof ragasResult.faithfulness === 'number'}faithfulness {ragasResult.faithfulness.toFixed(2)}{/if}
              {#if typeof relevancy === 'number'}<span data-testid="research-ragas-relevancy"> · relevance {relevancy.toFixed(2)}</span>{/if}
              {#if typeof ragasResult.factual_accuracy === 'number'}<span data-testid="research-ragas-factual"> · accuracy {ragasResult.factual_accuracy.toFixed(2)}</span>{/if}
              {#if typeof ragasResult.context_precision === 'number'}<span data-testid="research-ragas-precision"> · precision {ragasResult.context_precision.toFixed(2)}</span>{/if}
            </span>
          {/if}
          {#if ragasError}
            <span class="text-xs text-[var(--color-danger)]" data-testid="research-ragas-error"
              >{ragasError}</span
            >
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/snippet}

<!-- Deliverable (b): annotated literature review (trust-ranked) -->
{#snippet dReview()}
  <div class="flex flex-col gap-2" data-testid="research-review">
    <h2 class="text-sm font-semibold">Annotated literature review</h2>
    {#if results.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="research-review-empty">
        Nothing to review yet — run a search and score the results to rank them.
      </p>
    {:else}
      <p class="text-xs text-[var(--color-text-muted)]">
        {results.length}
        {results.length === 1 ? 'paper' : 'papers'}{#if Object.keys(scores).length > 0}, ranked by 7-signal trust{/if}.
      </p>
      <ul class="flex flex-col gap-2" data-testid="research-review-list">
        {#each rankedResults as p (paperIdOf(p) ?? p.title)}
          {@const id = paperIdOf(p)}
          {@const sc = id ? scores[id] : undefined}
          {@const highlight =
            knobs.scoreThreshold > 0 &&
            typeof sc === 'number' &&
            sc >= knobs.scoreThreshold}
          <PaperCard
            paper={p}
            selected={id ? selected.includes(id) : false}
            onToggle={toggle}
            score={id ? scores[id] : undefined}
            scoreTitle={id ? scoreTitles[id] : undefined}
            scoreComponents={id ? scoreComponentsById[id] : undefined}
            {highlight}
          />
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

<!-- Deliverable (c): claim-verification ledger -->
{#snippet dLedger()}
  <div class="flex flex-col gap-2" data-testid="research-ledger">
    <h2 class="text-sm font-semibold">Claim-verification ledger</h2>
    {#if ledgerEntries.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="research-ledger-empty">
        No verified claims yet — run Verify on your pushed entities to build the
        ledger.
      </p>
    {:else}
      <ul class="flex flex-col gap-1" data-testid="research-ledger-list">
        {#each ledgerEntries as e (e.entityId)}
          <ClaimLedgerRow
            claim={e.title}
            cove={e.v?.cove}
            contradictions={e.v?.contradictions}
          />
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

<!-- Deliverable (d): curated corpus -->
{#snippet dCorpus()}
  <div class="flex flex-col gap-2" data-testid="research-corpus">
    <h2 class="text-sm font-semibold">Curated corpus</h2>
    <p class="text-xs text-[var(--color-text-muted)]">
      {pushedEntityCount}
      {pushedEntityCount === 1 ? 'entity' : 'entities'} from {pushJobs.length}
      pushed {pushJobs.length === 1 ? 'paper' : 'papers'} are now in your tenant's
      KAG graph{#if pushId}
        (push {pushId}){/if}.
    </p>
    <div class="flex flex-wrap items-center gap-2">
      {#if sessionId !== null}
        <div class="flex items-center gap-1 text-xs" data-testid="research-export">
          <span class="text-[var(--color-text-muted)]">Export</span>
          {#each ['bibtex', 'ris', 'json'] as const as fmt (fmt)}
            <button
              type="button"
              data-testid={`research-export-${fmt}`}
              disabled={exporting !== null}
              onclick={() => void exportSession(fmt)}
              class="rounded border px-2 py-1 disabled:opacity-50"
              >{exporting === fmt ? '…' : fmt.toUpperCase()}</button
            >
          {/each}
        </div>
      {/if}
      <a
        href="/library/kag/ask"
        class="text-xs underline text-[var(--color-accent)]"
        data-testid="research-kag-link">Open KAG ask &amp; search →</a
      >
    </div>
    {#if exportError}
      <p class="text-xs text-[var(--color-danger)]" data-testid="research-export-error">
        Export failed: {exportError}
      </p>
    {/if}
    {#if exportEmpty}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="research-export-empty">
        Nothing to export (0 papers). Push papers into this session first.
      </p>
    {/if}
  </div>
{/snippet}

<!-- Deliverable (e): interactive knowledge graph of the pushed corpus -->
{#snippet dGraph()}
  <CorpusGraphPanel
    entityIds={pushedEntityIds}
    docs={askableDocs}
    defaultQuery={query}
  />
{/snippet}

<!-- Deliverable (f): evidence synthesis — pool effects + surface cross-paper conflict -->
{#snippet dSynthesis()}
  <div class="space-y-4">
    <EvidenceSynthesisPanel studyLabels={askableDocs.map((d) => d.title)} />
    <CrossPaperContradictions papers={sessionPapers} />
  </div>
{/snippet}

<!-- ───────────────────── Shared sub-snippets ───────────────────── -->
{#snippet resultSummary()}
  <div
    class="text-sm text-[var(--color-text-muted)]"
    data-testid="research-result-summary"
  >
    <span
      >{totalResults ?? results.length} results from {sourcesQueried.length}
      {sourcesQueried.length === 1 ? 'source' : 'sources'}</span
    >
    {#if sourcesQueried.length > 0}<span> ({sourcesQueried.join(', ')})</span>{/if}
    {#if sourcesFailed.length > 0}
      <span class="text-[var(--color-danger)]"
        > · {sourcesFailed.length} unavailable: {sourcesFailed.join(', ')}</span
      >
    {/if}
    <span> · {selected.length} selected</span>
    {#if visibleResults.length !== results.length}
      <span> · showing {visibleResults.length}</span>
    {/if}
  </div>
{/snippet}

{#snippet snowballBar()}
  <div
    class="flex flex-wrap items-center gap-2 text-sm border rounded p-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
    data-testid="research-snowball-bar"
  >
    <span class="text-[var(--color-text-muted)]">Snowball from {selected.length} selected</span>
    <label class="flex items-center gap-1">
      <span class="text-[var(--color-text-muted)]">Direction</span>
      <select
        data-testid="research-snowball-direction"
        bind:value={sbDirection}
        class="rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      >
        <option value="both">Both</option>
        <option value="forward">Forward (citing)</option>
        <option value="backward">Backward (cited)</option>
      </select>
    </label>
    <label class="flex items-center gap-1">
      <span class="text-[var(--color-text-muted)]">Depth</span>
      <input
        type="number"
        min="1"
        max="10"
        data-testid="research-snowball-depth"
        bind:value={sbDepth}
        class="w-16 rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      />
    </label>
    <label class="flex items-center gap-1">
      <span class="text-[var(--color-text-muted)]">Max papers</span>
      <input
        type="number"
        min="1"
        max="5000"
        data-testid="research-snowball-max"
        bind:value={sbMaxPapers}
        class="w-20 rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      />
    </label>
    <button
      type="button"
      data-testid="research-snowball-btn"
      disabled={!canSnowball}
      onclick={() => void snowballSelected()}
      title={!knobs.snowball
        ? `Citation-graph snowball is off in the ${PRESET_LABELS[preset]} rigor preset`
        : sessionId === null
          ? 'Searching creates a session; snowball enables once a session exists'
          : 'Walk citations/references from the selected papers into your working set'}
      class="rounded border px-3 py-1 disabled:opacity-50"
    >
      {snowballing ? 'Walking…' : 'Snowball'}
    </button>
    {#if !knobs.snowball}
      <span
        class="text-xs text-[var(--color-text-muted)]"
        data-testid="research-snowball-preset-hint"
        >off in the {PRESET_LABELS[preset]} preset</span
      >
    {/if}
    {#if snowballActive}
      <button
        type="button"
        data-testid="research-snowball-cancel"
        onclick={() => void cancelSnowball()}
        class="rounded border px-3 py-1"
      >
        Cancel
      </button>
    {/if}
  </div>
  {#if snowballStatus}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="research-snowball-state">
      Snowball {snowballStatus} · {snowballDiscovered} papers{#if snowballAdded !== null && snowballAdded < snowballDiscovered}<span
          data-testid="research-snowball-added"> ({snowballAdded} added to list)</span
        >{/if} · {snowballEdges}
      edges · depth {snowballDepth}
      {#if snowballStatus === 'completed' && snowballDiscovered === 0}
        — no new papers. Citation edges come from Semantic Scholar, so
        DOI-bearing journal/medical seeds (e.g. PubMed) expand best; preprints
        often have no resolvable citations.
      {/if}
    </p>
  {/if}
  {#if snowballError}
    <p class="text-xs text-[var(--color-danger)]" data-testid="research-snowball-error">
      Snowball failed: {snowballError}
    </p>
  {/if}
{/snippet}

{#snippet filterBar()}
  <div
    class="flex flex-wrap items-center gap-2 text-sm border rounded p-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
    data-testid="research-filter-bar"
  >
    <input
      data-testid="research-filter-text"
      bind:value={filterText}
      placeholder="Filter by title…"
      class="rounded border px-2 py-1 flex-1 min-w-40 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
    />
    <select
      data-testid="research-filter-source"
      bind:value={filterSource}
      class="rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
    >
      <option value={null}>All sources</option>
      {#each resultSources as s (s)}
        <option value={s}>{s}</option>
      {/each}
    </select>
    <label class="flex items-center gap-1">
      <input type="checkbox" data-testid="research-filter-oa" bind:checked={filterOA} />
      Open access
    </label>
    <label class="flex items-center gap-1">
      <input type="checkbox" data-testid="research-filter-pdf" bind:checked={filterPdf} />
      Has PDF
    </label>
    <div class="flex items-center gap-2 ml-auto">
      {#if Object.keys(scores).length > 0}
        <label class="flex items-center gap-1">
          <span class="text-[var(--color-text-muted)]">Sort</span>
          <select
            data-testid="research-sort-client"
            bind:value={clientSort}
            class="rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
          >
            <option value="default">As returned</option>
            <option value="trust">Trust (high→low)</option>
          </select>
        </label>
      {/if}
      <button
        type="button"
        data-testid="research-score-btn"
        disabled={scoring}
        onclick={() => void scoreResults()}
        class="rounded border px-3 py-1 disabled:opacity-50"
      >
        {scoring
          ? 'Scoring…'
          : Object.keys(scores).length > 0
            ? 'Re-score'
            : 'Score trust'}
      </button>
    </div>
  </div>
  {#if scoreError}
    <p class="text-xs text-[var(--color-danger)]" data-testid="research-score-error">
      Scoring failed: {scoreError}
    </p>
  {/if}
{/snippet}

{#snippet resultsList()}
  {#if knobs.scoreThreshold > 0 && Object.keys(scores).length > 0}
    <p
      class="text-xs text-[var(--color-text-muted)]"
      data-testid="research-appraise-threshold-hint"
    >
      Highlighting papers with trust ≥ {knobs.scoreThreshold.toFixed(2)} ({PRESET_LABELS[
        preset
      ]} preset).
    </p>
  {/if}
  <ul class="flex flex-col gap-2" data-testid="research-results">
    {#each visibleResults as p (paperIdOf(p) ?? p.title)}
      {@const id = paperIdOf(p)}
      {@const sc = id ? scores[id] : undefined}
      {@const highlight =
        knobs.scoreThreshold > 0 &&
        typeof sc === 'number' &&
        sc >= knobs.scoreThreshold}
      <div class="relative">
        {#if id && snowballIds.includes(id)}
          <span
            class="absolute right-2 top-2 z-10 rounded bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-on-primary)]"
            data-testid="research-snowball-badge"
            title="Discovered by walking the citation graph">via snowball</span
          >
        {/if}
        <PaperCard
          paper={p}
          selected={id ? selected.includes(id) : false}
          onToggle={toggle}
          score={id ? scores[id] : undefined}
          scoreTitle={id ? scoreTitles[id] : undefined}
          scoreComponents={id ? scoreComponentsById[id] : undefined}
          {highlight}
        />
      </div>
    {/each}
  </ul>
{/snippet}
