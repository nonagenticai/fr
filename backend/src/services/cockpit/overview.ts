// src/services/cockpit/overview.ts
//
// R2 of FR-PROJECT-HOME-REDESIGN-2026-10-26 (§2b, §4, §7.1): the read-model data behind the
// project Overview — the project as a CHAIN OF PHASES (Setup · Preliminary · Execution · Closure),
// each with its board summary, outputs, decisions, cost and sign-off, plus the outcome of a
// finished project and the "something is wrong now" lines (D4).
//
// ⛔ A phase is RECORDED, never guessed. Every entity is placed by an exact link only:
//   cards      the card's own `phase` field; Closure = card type `project_closure`  (spine.ts)
//   outputs    the artifact's card (`planka_card_id`, `card_id`, or tag `planka_card:<id>`) → that
//              card's phase; else the producer's own `phase` column (DOC-1); else UNASSIGNED
//   decisions  the approval's card → that card's phase; else project-wide            (spine.ts)
//   PRs        the PR's card → that card's phase; else unassigned
//   cost       billing `by_card` → the card's phase; spend on no card / an unplaced card is
//              unassigned
// Anything without an exact phase lands in `unassigned`, which the UI shows as "not tied to a
// phase" — never in the phase whose time window happens to hold it.
//
// Pure: project-cockpit.ts feeds it what it already read. fr judges nothing here.
import { humanCardType } from '../conveyor-history/history';
import type { ArtifactOut } from '../../integrations/artifacts';
import type { DeliveredPr } from '../conveyor-history/history';
import type { CockpitDecision, CockpitSpine, DecidedByKind, SpineCardState, SpinePhaseState } from './spine';
import type { CockpitState } from './cockpit-status';
import { isFinishedState } from './cockpit-status';

export type OverviewOutputStatus = 'published' | 'draft' | 'in_review' | 'open' | 'merged' | 'closed' | null;

export interface OverviewOutput {
  id: string;
  kind: 'document' | 'pull_request';
  /** A human title — never a file name or an id (DOC-1 `title`, else derived from the card). */
  title: string;
  /** "Analysis report", "Pull request" … ; null when nothing says what kind it is. */
  type_label: string | null;
  status: OverviewOutputStatus;
  /** One line (DOC-1 `summary`); null when the producer wrote none. */
  summary: string | null;
  at: string | null;
  card_id: string | null;
  card_name: string | null;
  /** The exact phase; null = not tied to a phase. */
  phase: string | null;
  /** The project's final report (the newest published report). */
  is_final: boolean;
  /** Only for a PR (its GitHub url); documents open from the Outputs page. */
  url: string | null;
}

export interface OverviewCost {
  cost: number | null;
  calls: number;
}

export interface OverviewSignoff {
  at: string | null;
  by_kind: DecidedByKind | null;
  by_name: string | null;
  subject: string | null;
}

export interface OverviewPhase {
  name: string;
  label: string;
  /** 1-based position in the chain. */
  position: number;
  state: SpinePhaseState;
  entered_at: string | null;
  left_at: string | null;
  duration_ms: number | null;
  cards: {
    total: number;
    by_state: Record<SpineCardState, number>;
    items: { id: string; name: string; state: SpineCardState }[];
  };
  /** Newest first. Drafts only while the project runs (D6). */
  outputs: OverviewOutput[];
  /** The phase's published documents and merged PRs — "what it delivered". */
  delivered: OverviewOutput[];
  decisions: number;
  open_asks: number;
  /** null = no per-card cost could be read; else the sum over this phase's cards. */
  cost: OverviewCost | null;
  /** Who signed the phase off, and when (a past phase); null when nothing was recorded. */
  signoff: OverviewSignoff | null;
}

export interface OverviewProblem {
  code: 'flow_failures' | 'blocked_card';
  /** One plain sentence: what is wrong now. */
  message: string;
  /** Where to look (a page of this project). */
  href: string;
}

export interface ProjectOverview {
  phases: OverviewPhase[];
  /** The phase the project is in now (null = not started); Closure once a closure card moved. */
  current_phase: string | null;
  current_position: number | null;
  phase_count: number;
  /** Entities with no exact phase — shown project-wide, never guessed into a phase. */
  unassigned: { cards: number; outputs: OverviewOutput[]; decisions: number; cost: OverviewCost | null };
  /** Every output, newest first (the "Latest outputs" list when no phase is chosen). */
  outputs: OverviewOutput[];
  /** A finished project's outcome (completed / cancelled); null while it runs. */
  outcome: {
    state: 'completed' | 'cancelled';
    final_report: OverviewOutput | null;
    /** The final report's own summary paragraph; null = it carries none. */
    summary: string | null;
    pull_requests: OverviewOutput[];
  } | null;
  /** D4: only what is wrong NOW. Empty on a healthy or finished project. */
  problems: OverviewProblem[];
  /** billing's per-card figures cover spend since this instant (null = not read). */
  cost_by_card_since: string | null;
  currency: string | null;
}

export interface OverviewInputs {
  projectId: string;
  state: CockpitState;
  spine: CockpitSpine | null;
  decisions: readonly CockpitDecision[];
  artifacts: readonly ArtifactOut[] | null;
  pullRequests: readonly DeliveredPr[] | null;
  byCard: { rows: readonly { card_id: string | null; cost: number | null; calls: number }[]; since: string | null; currency: string } | null;
  /** Unresolved flow failures (no later success). */
  flowFailures: readonly { workflow_name: string | null; failed_node: string | null; started_at: string | null; card_id: string | null }[];
  /** Cards blocked for a reason other than an open approval. */
  blockedCards: readonly { id: string; name: string; age_in_phase_ms: number | null; blocked_reason: string | null }[];
  cardNames: ReadonlyMap<string, string>;
  now: number;
}

const REPORT_FILE = 'report.json';
const CARD_TAG = /^planka_card:(.+)$/;

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** "analysis_report" → "Analysis report". */
export function humanType(v: string | null | undefined): string | null {
  const s = humanCardType(v);
  if (!s) return null;
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

/** The card an artifact belongs to, by an exact link only. */
export function artifactCardId(a: Pick<ArtifactOut, 'planka_card_id' | 'card_id' | 'tags'>): string | null {
  const direct = (a.planka_card_id ?? a.card_id ?? '').trim();
  if (direct) return direct;
  for (const t of a.tags ?? []) {
    const m = CARD_TAG.exec(t);
    const id = m?.[1]?.trim();
    if (id) return id;
  }
  return null;
}

function durationShort(msv: number): string {
  const min = Math.floor(msv / 60_000);
  if (min < 1) return 'under a minute';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? (m > 0 ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

function artifactStatus(a: ArtifactOut): OverviewOutputStatus {
  if (a.publish_status === 'published') return 'published';
  if (a.status === 'needs_revision') return 'in_review';
  if (a.publish_status === 'draft') return 'draft';
  return null;
}

/** Documents (artifacts) as outputs. Drafts are dropped on a finished project (D6). */
export function documentOutputs(
  rows: readonly ArtifactOut[],
  cardPhase: ReadonlyMap<string, string>,
  phases: ReadonlySet<string>,
  cardNames: ReadonlyMap<string, string>,
  finished: boolean,
): OverviewOutput[] {
  const out = rows.map((a): OverviewOutput => {
    const cardId = artifactCardId(a);
    const cardName = cardId ? (cardNames.get(cardId) ?? null) : null;
    const ownPhase = (a.phase ?? '').trim().toLowerCase();
    const phase = (cardId ? cardPhase.get(cardId) : undefined) ?? (ownPhase && phases.has(ownPhase) ? ownPhase : null);
    const typeLabel = humanType(a.doc_type) ?? (a.filename === REPORT_FILE ? 'Report' : null);
    const title =
      (a.title ?? '').trim() ||
      (a.filename === REPORT_FILE ? (cardName ? `Report: ${cardName}` : 'Report') : a.filename);
    return {
      id: a.id,
      kind: 'document',
      title,
      type_label: typeLabel,
      status: artifactStatus(a),
      summary: (a.summary ?? '').trim() || null,
      at: a.created_at ?? null,
      card_id: cardId,
      card_name: cardName,
      phase,
      is_final: false,
      url: null,
    };
  });
  const kept = finished ? out.filter((o) => o.status === 'published') : out;
  kept.sort((x, y) => ms(y.at) - ms(x.at));
  // The final report: the newest published document of the Closure phase, else the newest published report.
  const published = kept.filter((o) => o.status === 'published');
  const finalReport =
    published.find((o) => o.phase === 'closure') ?? published.find((o) => o.type_label !== null) ?? null;
  if (finalReport) finalReport.is_final = true;
  return kept;
}

/** Delivered PRs as outputs, by their card's exact phase. */
export function prOutputs(prs: readonly DeliveredPr[], cardPhase: ReadonlyMap<string, string>): OverviewOutput[] {
  return prs
    .map(
      (p): OverviewOutput => ({
        id: `pr:${p.repo}#${p.number}`,
        kind: 'pull_request',
        title: `PR #${p.number}${p.title ? ` · ${p.title}` : ''}`,
        type_label: 'Pull request',
        status: p.state,
        summary: null,
        at: p.first_seen_at,
        card_id: p.card_id,
        card_name: p.card_name || null,
        phase: cardPhase.get(p.card_id) ?? null,
        is_final: false,
        url: p.url,
      }),
    )
    .sort((x, y) => ms(y.at) - ms(x.at));
}

const ZERO_STATES = (): Record<SpineCardState, number> => ({ todo: 0, doing: 0, qa: 0, done: 0, blocked: 0 });

export function composeOverview(i: OverviewInputs): ProjectOverview {
  const finished = isFinishedState(i.state);
  const spinePhases = i.spine?.phases ?? [];
  const phaseSet = new Set(spinePhases.map((p) => p.name));
  const cardPhase = new Map<string, string>();
  for (const c of i.spine?.cards ?? []) if (c.phase) cardPhase.set(c.id, c.phase);

  const docs = i.artifacts ? documentOutputs(i.artifacts, cardPhase, phaseSet, i.cardNames, finished) : [];
  const prs = i.pullRequests ? prOutputs(i.pullRequests, cardPhase) : [];
  const outputs = [...docs, ...prs].sort((x, y) => ms(y.at) - ms(x.at));

  // Cost by phase from billing's per-card rows (only exact card → phase).
  const costOf = new Map<string, OverviewCost>();
  let unassignedCost: OverviewCost | null = i.byCard ? { cost: 0, calls: 0 } : null;
  const add = (acc: OverviewCost, row: { cost: number | null; calls: number }) => {
    acc.calls += row.calls;
    acc.cost = acc.cost === null || row.cost === null ? null : acc.cost + row.cost;
  };
  if (i.byCard) {
    for (const ph of phaseSet) costOf.set(ph, { cost: 0, calls: 0 });
    for (const row of i.byCard.rows) {
      const ph = row.card_id ? cardPhase.get(row.card_id) : undefined;
      add(ph ? costOf.get(ph)! : unassignedCost!, row);
    }
  }

  const gateOf = new Map((i.spine?.gates ?? []).map((g) => [g.phase, g] as const));
  const phases: OverviewPhase[] = spinePhases.map((p, idx) => {
    const cards = (i.spine?.cards ?? []).filter((c) => c.phase === p.name);
    const byState = ZERO_STATES();
    for (const c of cards) byState[c.state] += 1;
    const mine = outputs.filter((o) => o.phase === p.name);
    const g = gateOf.get(p.name);
    const decisions = i.decisions.filter((d) => d.phase === p.name);
    return {
      name: p.name,
      label: p.label,
      position: idx + 1,
      state: p.state,
      entered_at: p.entered_at,
      left_at: p.left_at,
      duration_ms: p.duration_ms,
      cards: { total: cards.length, by_state: byState, items: cards.map((c) => ({ id: c.id, name: c.name, state: c.state })) },
      outputs: mine,
      delivered: mine.filter((o) => o.status === 'published' || o.status === 'merged'),
      decisions: decisions.length,
      open_asks: finished ? 0 : decisions.filter((d) => d.open).length,
      cost: costOf.get(p.name) ?? null,
      signoff:
        g && g.state === 'passed' && g.signed_by_kind
          ? { at: g.signed_at, by_kind: g.signed_by_kind, by_name: g.signed_by_name, subject: g.subject }
          : null,
    };
  });

  const current = finished
    ? (phases.filter((p) => p.state === 'done').at(-1) ?? null)
    : (phases.find((p) => p.state === 'active') ?? null);

  const unassignedOutputs = outputs.filter((o) => o.phase === null);
  const finalReport = docs.find((d) => d.is_final) ?? null;

  const problems: OverviewProblem[] = [];
  if (!finished) {
    for (const b of i.blockedCards) {
      const age = b.age_in_phase_ms !== null ? ` for ${durationShort(b.age_in_phase_ms)}` : '';
      problems.push({
        code: 'blocked_card',
        message: `“${b.name}” is blocked${age}${b.blocked_reason && b.blocked_reason !== 'blocked' ? `: ${b.blocked_reason}` : '.'}`,
        href: `/projects/${encodeURIComponent(i.projectId)}/board`,
      });
    }
    const n = i.flowFailures.length;
    if (n > 0) {
      const lastHour = i.flowFailures.filter((f) => i.now - ms(f.started_at) <= 3_600_000).length;
      problems.push({
        code: 'flow_failures',
        message:
          `${n} step${n === 1 ? '' : 's'} failed and ${n === 1 ? 'has' : 'have'} not succeeded since` +
          (lastHour > 0 && lastHour < n ? ` (${lastHour} in the last hour)` : lastHour === n ? ' (in the last hour)' : '') +
          ' — see Flow runs.',
        href: `/projects/${encodeURIComponent(i.projectId)}/flow-runs`,
      });
    }
  }

  return {
    phases,
    current_phase: current?.name ?? null,
    current_position: current?.position ?? null,
    phase_count: phases.length,
    unassigned: {
      cards: (i.spine?.cards ?? []).filter((c) => !c.phase).length,
      outputs: unassignedOutputs,
      decisions: i.decisions.filter((d) => d.phase === null).length,
      cost: unassignedCost,
    },
    outputs,
    outcome: finished
      ? {
          state: i.state === 'cancelled' ? 'cancelled' : 'completed',
          final_report: finalReport,
          summary: finalReport?.summary ?? null,
          pull_requests: prs,
        }
      : null,
    problems,
    cost_by_card_since: i.byCard?.since ?? null,
    currency: i.byCard?.currency ?? null,
  };
}
