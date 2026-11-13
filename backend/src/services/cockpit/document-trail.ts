// src/services/cockpit/document-trail.ts
//
// R3 + DOC-3 of FR-PROJECT-HOME-REDESIGN-2026-10-26 (§3 Outputs, §7.1, §7.2, §8): the project's
// DOCUMENT TRAIL — what the project produced, per phase, newest first, with the final report on top.
//
// ⛔ DOC-4 is ruled (§8): ONLY what was produced. No expected document, nothing greyed out, and a
// phase that produced nothing is simply absent.
//
// What one row is. The conveyor uploads a card's report as `report.json` and, since DOC-2, a
// companion `document.md` beside it; a re-run of the card uploads both again. artifact_service
// keeps every upload as its own row at `version` 1, so fr groups them:
//
//   DOCUMENT  = the artifacts of ONE card with ONE document kind (`doc_type`, else the file's
//               kind: report/document files are one kind). An artifact with no card is a document
//               of its own — without a card nothing says two uploads are the same document.
//   VERSION   = within a document, the uploads made together: a `.json` and a `.md` uploaded within
//               PAIR_WINDOW_MS of each other are ONE version (the pairing rule). The `.md` is the
//               one read; the `.json` is the one reviewed (it carries the producer's review
//               callback). A second `.json` (or a second `.md`) starts the next version.
//
// Placement is exact, as in overview.ts: the card's phase; else the producer's own DOC-1 `phase`
// when it names one of the project's phases; else "not tied to a phase". Never a time window.
//
// Titles never show a file name or an id: DOC-1 `title`, else "<kind>: <card name>", else the kind.
//
// Pure: the route feeds it what it read.
import type { DeliveredPr } from '../conveyor-history/history';
import type { ArtifactOut } from '../../integrations/artifacts';
import { artifactCardId, humanType } from './overview';

/** A `.json` and a `.md` uploaded this close together are one version of one document. */
export const PAIR_WINDOW_MS = 15 * 60_000;

export type TrailStatus = 'published' | 'in_review' | 'draft';

/** One artifact as the trail reads it (artifact_service's row; DOC-1 fields optional). */
export type TrailArtifact = ArtifactOut & {
  content_type?: string | null;
  review_callback_url?: string | null;
};

export interface TrailVersion {
  /** 1-based, oldest first, within the document. */
  number: number;
  /** The artifact the reader renders (the `.md` when there is one). */
  artifact_id: string;
  /** The artifact a review is recorded on (the producer's `.json` when there is one). */
  review_artifact_id: string;
  status: TrailStatus | null;
  /** artifact_service's review status of `review_artifact_id` (pending / approved / rejected / needs_revision). */
  review_status: string | null;
  at: string | null;
  title: string;
  summary: string | null;
}

export interface TrailDocument {
  /** Stable key of the document (card + kind); not shown. */
  key: string;
  /** The shown version's reading artifact — the reader route's id. */
  artifact_id: string;
  review_artifact_id: string;
  title: string;
  /** "Analysis report", "Report" … — what kind of document it is. */
  type_label: string;
  status: TrailStatus | null;
  review_status: string | null;
  /** The shown version's number, and how many versions are listed. */
  version: number;
  version_count: number;
  at: string | null;
  summary: string | null;
  phase: string | null;
  card_id: string | null;
  card_name: string | null;
  is_final: boolean;
  /** A review is open on it and the project still runs: the reader offers Approve / Request changes. */
  reviewable: boolean;
  /** Newest first. Drafts left out once the project is finished. */
  versions: TrailVersion[];
}

export interface TrailPullRequest {
  url: string;
  title: string;
  state: DeliveredPr['state'];
  at: string | null;
  card_name: string | null;
  phase: string | null;
}

export interface TrailPhase {
  name: string;
  label: string;
  state: string;
  current: boolean;
  documents: TrailDocument[];
  pull_requests: TrailPullRequest[];
}

export interface DocumentTrail {
  finished: boolean;
  current_phase: string | null;
  final_report: TrailDocument | null;
  /** Phases that produced something: the current phase first, then the earlier ones, latest first. */
  phases: TrailPhase[];
  unassigned: { documents: TrailDocument[]; pull_requests: TrailPullRequest[] };
}

export interface TrailInputs {
  artifacts: readonly TrailArtifact[];
  phases: readonly { name: string; label: string; state: string }[];
  /** The phase the project is in now (null = not started / not read). */
  currentPhase: string | null;
  cardPhase: ReadonlyMap<string, string>;
  cardNames: ReadonlyMap<string, string>;
  pullRequests: readonly DeliveredPr[] | null;
  finished: boolean;
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

type Format = 'json' | 'md' | 'other';

function formatOf(a: TrailArtifact): Format {
  const name = (a.filename ?? '').toLowerCase();
  const ct = (a.content_type ?? '').toLowerCase();
  if (name.endsWith('.md') || ct.startsWith('text/markdown')) return 'md';
  if (name.endsWith('.json') || ct.startsWith('application/json')) return 'json';
  return 'other';
}

const REPORT_FILES = new Set(['report.json', 'report.md']);
const DOCUMENT_FILES = new Set(['document.json', 'document.md']);

/** What a label is read from (any artifact row — the trail's, or the cockpit's narrower one). */
type LabelSource = { doc_type?: string | null; filename?: string | null; kind?: string | null };

/** What kind of document an artifact is, in words — never its file name. */
export function kindLabel(a: LabelSource): string {
  const t = humanType(a.doc_type);
  if (t) return t;
  const name = (a.filename ?? '').toLowerCase();
  if (REPORT_FILES.has(name)) return 'Report';
  if (DOCUMENT_FILES.has(name) || name.endsWith('.md')) return 'Document';
  switch (a.kind) {
    case 'presentation':
      return 'Presentation';
    case 'image':
      return 'Image';
    case 'dataset':
      return 'Dataset';
    case 'graph':
      return 'Graph';
    case 'json':
      return 'Report';
    default:
      return 'Document';
  }
}

/** The grouping kind: report/document files are one kind (the `.json` and its `.md`). */
function groupKind(a: TrailArtifact): string {
  const t = (a.doc_type ?? '').trim().toLowerCase();
  if (t) return `type:${t}`;
  const name = (a.filename ?? '').toLowerCase();
  if (REPORT_FILES.has(name) || DOCUMENT_FILES.has(name) || formatOf(a) !== 'other') return 'doc';
  return `file:${name}`;
}

/** The readable label of a document with no producer title. */
export function fallbackTitle(a: LabelSource, cardName: string | null): string {
  const kind = kindLabel(a);
  return cardName ? `${kind}: ${cardName}` : kind;
}

function statusOf(a: TrailArtifact): TrailStatus | null {
  if (a.publish_status === 'published') return 'published';
  if (a.status === 'needs_revision') return 'in_review';
  if (a.publish_status === 'draft') return 'draft';
  return null;
}

const STATUS_RANK: Record<TrailStatus, number> = { published: 3, in_review: 2, draft: 1 };

interface Bucket {
  members: Partial<Record<Format, TrailArtifact>>;
  first: number;
}

/** The pairing rule: consecutive uploads join one version until a format repeats or the window passes. */
export function pairVersions(rows: readonly TrailArtifact[]): Bucket[] {
  const sorted = [...rows].sort((x, y) => ms(x.created_at) - ms(y.created_at) || x.id.localeCompare(y.id));
  const out: Bucket[] = [];
  for (const a of sorted) {
    const f = formatOf(a);
    const t = ms(a.created_at);
    const open = out.at(-1);
    if (open && !open.members[f] && f !== 'other' && !open.members.other && Math.abs(t - open.first) <= PAIR_WINDOW_MS) {
      open.members[f] = a;
    } else {
      out.push({ members: { [f]: a }, first: t });
    }
  }
  return out;
}

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t ? t : null;
};

function toVersion(b: Bucket, n: number, cardName: string | null): TrailVersion {
  const { md, json, other } = b.members;
  const reading = (md ?? json ?? other)!;
  const review = [json, md, other].find((m) => m && clean(m.review_callback_url)) ?? json ?? reading;
  const members = [md, json, other].filter((m): m is TrailArtifact => m !== undefined);
  let status: TrailStatus | null = null;
  for (const m of members) {
    const s = statusOf(m);
    if (s && (status === null || STATUS_RANK[s] > STATUS_RANK[status])) status = s;
  }
  const at = members.map((m) => m.created_at ?? null).filter((x): x is string => !!x).sort((x, y) => ms(y) - ms(x))[0] ?? null;
  return {
    number: n,
    artifact_id: reading.id,
    review_artifact_id: review.id,
    status,
    review_status: review.status ?? null,
    at,
    title: clean(md?.title) ?? clean(json?.title) ?? clean(other?.title) ?? fallbackTitle(reading, cardName),
    summary: clean(md?.summary) ?? clean(json?.summary) ?? clean(other?.summary),
  };
}

/** The open-review states (the same set the Needs-you queue offers a review for). */
const REVIEW_OPEN = new Set(['pending', 'needs_revision']);

/** The trail's documents: one card's artifacts of one kind (an artifact with no card stands alone). */
function groupDocuments(artifacts: readonly TrailArtifact[]): Map<string, TrailArtifact[]> {
  const groups = new Map<string, TrailArtifact[]>();
  for (const a of artifacts) {
    const card = artifactCardId(a);
    const key = card ? `card:${card}|${groupKind(a)}` : `artifact:${a.id}`;
    const g = groups.get(key);
    if (g) g.push(a);
    else groups.set(key, [a]);
  }
  return groups;
}

/** How the trail names one artifact: its version's title, and the card it belongs to. */
export interface DocumentLabel {
  title: string;
  card_id: string | null;
  card_name: string | null;
}

/**
 * The trail's label of EVERY artifact it groups — each member of a version (the `.md` that is read
 * and the `.json` that is reviewed) carries that version's title. Any other surface that names a
 * project document (the Needs you list, the Overview strip) takes its title from here, so all of
 * them read exactly as the Outputs page does: DOC-1 title, else "<kind>: <card name>", else the
 * kind — never a file name. Drafts are labelled too (a finished project hides them, but a label
 * is not a listing).
 */
export function documentLabels(
  artifacts: readonly TrailArtifact[],
  cardNames: ReadonlyMap<string, string>,
): Map<string, DocumentLabel> {
  const out = new Map<string, DocumentLabel>();
  for (const rows of groupDocuments(artifacts).values()) {
    const cardId = artifactCardId(rows[0]!);
    const cardName = cardId ? (cardNames.get(cardId) ?? null) : null;
    for (const b of pairVersions(rows)) {
      const { title } = toVersion(b, 0, cardName);
      for (const m of Object.values(b.members)) {
        if (m) out.set(m.id, { title, card_id: cardId, card_name: cardName });
      }
    }
  }
  return out;
}

export function composeDocumentTrail(i: TrailInputs): DocumentTrail {
  const phaseNames = new Set(i.phases.map((p) => p.name));
  const groups = groupDocuments(i.artifacts);

  const docs: TrailDocument[] = [];
  for (const [key, rows] of groups) {
    const first = rows[0]!;
    const cardId = artifactCardId(first);
    const cardName = cardId ? (i.cardNames.get(cardId) ?? null) : null;
    const all = pairVersions(rows).map((b, idx) => toVersion(b, idx + 1, cardName));
    // ⛔ D6: drafts are hidden once the project is finished — in the trail AND the version list.
    const shown = (i.finished ? all.filter((v) => v.status === 'published') : all).reverse();
    const head = shown[0];
    if (!head) continue;
    const ownPhase = (rows.map((r) => clean(r.phase)).find((p) => p !== null) ?? '').toLowerCase();
    const phase = (cardId ? i.cardPhase.get(cardId) : undefined) ?? (ownPhase && phaseNames.has(ownPhase) ? ownPhase : null);
    const reading = rows.find((r) => r.id === head.artifact_id) ?? first;
    docs.push({
      key,
      artifact_id: head.artifact_id,
      review_artifact_id: head.review_artifact_id,
      title: head.title,
      type_label: kindLabel(reading),
      status: head.status,
      review_status: head.review_status,
      version: head.number,
      version_count: shown.length,
      at: head.at,
      summary: head.summary,
      phase,
      card_id: cardId,
      card_name: cardName,
      is_final: false,
      reviewable: !i.finished && head.review_status !== null && REVIEW_OPEN.has(head.review_status),
      versions: shown,
    });
  }
  docs.sort((x, y) => ms(y.at) - ms(x.at));

  // The final report: the newest published Closure document; once finished, else the newest published one.
  const published = docs.filter((d) => d.status === 'published');
  const finalReport = published.find((d) => d.phase === 'closure') ?? (i.finished ? (published[0] ?? null) : null);
  if (finalReport) finalReport.is_final = true;

  const prs: TrailPullRequest[] = (i.pullRequests ?? [])
    .map((p) => ({
      url: p.url,
      title: `PR #${p.number}${p.title ? ` · ${p.title}` : ''}`,
      state: p.state,
      at: p.first_seen_at,
      card_name: p.card_name || null,
      phase: i.cardPhase.get(p.card_id) ?? null,
    }))
    .sort((x, y) => ms(y.at) - ms(x.at));

  const rest = docs.filter((d) => d !== finalReport);
  // Current phase first, then the earlier ones, latest first (the chain reversed from the current one).
  const order = [...i.phases];
  const curIdx = i.currentPhase ? order.findIndex((p) => p.name === i.currentPhase) : -1;
  const chain = curIdx >= 0 ? order.slice(0, curIdx + 1).reverse().concat(order.slice(curIdx + 1)) : [...order].reverse();
  const phases: TrailPhase[] = [];
  for (const p of chain) {
    const documents = rest.filter((d) => d.phase === p.name);
    const pull_requests = prs.filter((r) => r.phase === p.name);
    if (documents.length === 0 && pull_requests.length === 0) continue; // §8: only what was produced
    phases.push({ name: p.name, label: p.label, state: p.state, current: p.name === i.currentPhase, documents, pull_requests });
  }

  return {
    finished: i.finished,
    current_phase: i.currentPhase,
    final_report: finalReport,
    phases,
    unassigned: { documents: rest.filter((d) => d.phase === null), pull_requests: prs.filter((r) => r.phase === null) },
  };
}

/** Every artifact id the trail lists (the reader's version switcher may open any of them). */
export function trailArtifactIds(t: DocumentTrail): Set<string> {
  const ids = new Set<string>();
  const add = (d: TrailDocument) => {
    for (const v of d.versions) ids.add(v.artifact_id);
  };
  if (t.final_report) add(t.final_report);
  for (const p of t.phases) p.documents.forEach(add);
  t.unassigned.documents.forEach(add);
  return ids;
}
