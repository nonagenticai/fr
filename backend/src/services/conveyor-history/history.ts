// src/services/conveyor-history/history.ts
//
// What the conveyor DID on a project, for the project page (GET /api/projects/:id/conveyor-history):
//   * conversation — every conveyor ask / sign-off fr holds for the project (approvals, source n8n),
//     with the answer or decision, who decided and when, and which card it was about;
//   * cards        — every card on the project's board (DONE included) with its list, card type,
//     last move and its comments as a timeline (JSON blocks folded, see ./comment-parse.ts);
//   * delivered    — pull requests named in the card comments, with repo, branch and (when GitHub
//     answers) their state. The state is looked up ONLY for a PR in one of the project's own linked
//     repositories (project_repositories): a comment can name any URL, and fr never mints a GitHub
//     token or calls GitHub for a repository the project does not hold.
//
// Each part is a read-model Block: a source that fails degrades its own part (`available:false` with
// a reason), never the whole answer and never into an empty list. fr only re-presents: nothing here
// decides, and the decide path for an open ask stays the existing approve surface.

import { and, desc, eq, inArray } from 'drizzle-orm';

import { db } from '../../db/client';
import { approvals, approvalDecisions } from '../../db/schema';
import { availableBlock, block, unavailableBlock, type Block } from '../read-models/_lib';
import { plankaClient } from '../planka';
import type { BoardDetail, Comment } from '../planka/types';
import { config } from '../../config';
import { resolveActorNames } from '../../routes/dashboard';
import { requestCloneToken } from '../../integrations/coding-github/client';
import { loadProjectRepositories } from '../project-repositories';
import { parseGithubRepo } from '../repo-access';
import {
  branchFromBlocks,
  extractPullRequestUrls,
  headShaFromBlocks,
  parseConveyorComment,
  prKey,
  tidyConveyorProse,
  type CommentKind,
} from './comment-parse';

// ── Payload ─────────────────────────────────────────────────────────────────

export interface ConversationEntry {
  approval_id: string;
  /** 'question' | 'signoff' as the conveyor declared it; 'request' when it declared neither. */
  ask_kind: 'question' | 'signoff' | 'request';
  status: string;
  /** What the conveyor asked or asked to sign off. */
  question: string;
  /** Further context the conveyor gave with it (impact), when any. */
  context: string | null;
  /** The decision recorded ('approved' / 'rejected'); null while open. */
  decision: string | null;
  /** The answer / decision note as written; null while open or when none was written. */
  answer: string | null;
  /** Display name of who decided; null while open. */
  decided_by: string | null;
  decided_at: string | null;
  asked_at: string | null;
  card_id: string | null;
  card_name: string | null;
  card_type: string | null;
  /** The board list the card was in when asked. */
  list: string | null;
  /** True while the item can still be decided (it links to the approve surface). */
  open: boolean;
}

export interface CardTimelineEntry {
  id: string;
  created_at: string | null;
  author: string;
  kind: CommentKind;
  list: string | null;
  text: string;
  summary: string | null;
  /** The comment's JSON block, pretty-printed, for a folded "details" view; null when none. */
  data: string | null;
}

export interface HistoryCard {
  id: string;
  name: string;
  list_name: string | null;
  card_type: string | null;
  last_moved_at: string | null;
  comment_count: number;
  /** True when Planka had more comments than this read walked. */
  comments_truncated: boolean;
  /** Newest first. Null when this card's comments could not be read (`comments_error` says why). */
  comments: CardTimelineEntry[] | null;
  comments_error: string | null;
}

export interface CardsPayload {
  cards: HistoryCard[];
}

export interface DeliveredPr {
  url: string;
  repo: string;
  number: number;
  branch: string | null;
  head_sha: string | null;
  card_id: string;
  card_name: string;
  first_seen_at: string | null;
  /** 'open' | 'closed' | 'merged' from GitHub; null when it could not be read (see state_unavailable). */
  state: 'open' | 'closed' | 'merged' | null;
  title: string | null;
  state_unavailable: string | null;
}

export interface DeliveredPayload {
  pull_requests: DeliveredPr[];
}

export interface ConveyorHistory {
  conversation: Block<{ entries: ConversationEntry[] }>;
  cards: Block<CardsPayload>;
  delivered: Block<DeliveredPayload>;
}

/**
 * The endpoint's answer. A project RM holds no pm_project for (by origin_project_id) is not run by
 * the conveyor, so there is no history to read: that is said explicitly, never as three empty lists.
 */
export type ConveyorHistoryResponse =
  | ({ applicable: true } & ConveyorHistory)
  | { applicable: false; reason: 'not_a_conveyor_project'; message: string };

export const NOT_A_CONVEYOR_PROJECT: Extract<ConveyorHistoryResponse, { applicable: false }> = {
  applicable: false,
  reason: 'not_a_conveyor_project',
  message: 'This project is not run by the conveyor, so there is no conveyor history.',
};

// ── Rows ────────────────────────────────────────────────────────────────────

export interface ApprovalRow {
  id: string;
  status: string;
  description: string;
  change_summary: string | null;
  impact_analysis: string | null;
  card_id: string | null;
  metadata: unknown;
  created_at: Date | string | null;
  completed_at: Date | string | null;
}

export interface DecisionRow {
  approval_id: string;
  approver_id: string;
  decision: string;
  comment: string | null;
  decided_at: Date | string | null;
}

interface PrStateResult {
  state: 'open' | 'closed' | 'merged';
  title: string | null;
  head_ref: string | null;
}

const CONVERSATION_LIMIT = 200;
const COMMENT_PAGES_MAX = 10;
const COMMENT_FETCH_CONCURRENCY = 4;
const PR_STATE_MAX = 10;
const GITHUB_API_BASE = 'https://api.github.com';

/** The project's n8n approvals in ONE tenant (exported for its DB test). */
export async function listConveyorApprovalsFromDb(projectId: string, tenantId: string) {
  const rows = await db
    .select({
      id: approvals.id,
      status: approvals.status,
      description: approvals.description,
      change_summary: approvals.change_summary,
      impact_analysis: approvals.impact_analysis,
      card_id: approvals.card_id,
      metadata: approvals.metadata,
      created_at: approvals.created_at,
      completed_at: approvals.completed_at,
    })
    .from(approvals)
    // Tenant-pinned exactly like the cockpit's approvals block (fr row 14d): the active tenant, never relaxed.
    .where(and(eq(approvals.project_id, projectId), eq(approvals.tenant_id, tenantId), eq(approvals.source, 'n8n')))
    .orderBy(desc(approvals.created_at))
    .limit(CONVERSATION_LIMIT);
  if (rows.length === 0) return { rows, decisions: [] };
  const decisions = await db
    .select({
      approval_id: approvalDecisions.approval_id,
      approver_id: approvalDecisions.approver_id,
      decision: approvalDecisions.decision,
      comment: approvalDecisions.comment,
      decided_at: approvalDecisions.decided_at,
    })
    .from(approvalDecisions)
    .where(inArray(approvalDecisions.approval_id, rows.map((r) => r.id)));
  return { rows, decisions };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The conveyor's `description` is `[ready-signoff] <card id>: <reason>` — the bracket tag and the card id
 * are plumbing, never user copy. Strip them; what is left is the conveyor's own sentence.
 */
export function stripAskPrefix(description: string): string {
  return description.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/^\d{6,}\s*:\s*/, '').trim();
}

/** The question text, the conveyor's own words, preferring the most specific field it wrote. */
export function askQuestion(row: Pick<ApprovalRow, 'description' | 'change_summary' | 'metadata'>): string {
  const md = isRecord(row.metadata) ? row.metadata : {};
  const oq = Array.isArray(md.open_questions)
    ? md.open_questions.filter((q): q is string => typeof q === 'string' && q.trim() !== '').map((q) => q.trim())
    : [];
  if (oq.length) return oq.join('\n\n');
  return str(row.change_summary) ?? str(md.reason) ?? stripAskPrefix(row.description ?? '');
}

/** `card_type` values are snake_case identifiers; shown as words. */
export function humanCardType(v: string | null | undefined): string | null {
  const s = str(v);
  return s ? s.replace(/[_.]+/g, ' ') : null;
}

function buildConversation(
  rows: ApprovalRow[],
  decisions: DecisionRow[],
  names: Map<string, string>,
  cardNames: Map<string, string>,
): ConversationEntry[] {
  const byApproval = new Map<string, DecisionRow[]>();
  for (const d of decisions) {
    const list = byApproval.get(d.approval_id) ?? [];
    list.push(d);
    byApproval.set(d.approval_id, list);
  }
  const entries = rows.map((r): ConversationEntry => {
    const md = isRecord(r.metadata) ? r.metadata : {};
    const askKind = md.ask_kind === 'question' || md.ask_kind === 'signoff' ? md.ask_kind : 'request';
    // The latest decision speaks for the item (multi-approver rows keep every decision in the DB).
    const ds = (byApproval.get(r.id) ?? []).sort(
      (a, b) => new Date(String(b.decided_at)).getTime() - new Date(String(a.decided_at)).getTime(),
    );
    const d = ds[0];
    const open = r.status === 'pending';
    // The conveyor's (and the decider's) words, with internal ids and rule numbers dropped.
    const question = tidyConveyorProse(askQuestion(r));
    const context = str(tidyConveyorProse(r.impact_analysis));
    return {
      approval_id: r.id,
      ask_kind: askKind,
      status: r.status,
      question,
      context: context && context !== question ? context : null,
      decision: d ? d.decision : null,
      answer: d ? str(tidyConveyorProse(d.comment)) : null,
      // An approver the directory cannot name is "a reviewer" — never a raw id in user copy.
      decided_by: d ? (names.get(d.approver_id) ?? 'a reviewer') : null,
      decided_at: d ? iso(d.decided_at) : iso(r.completed_at),
      asked_at: iso(r.created_at),
      card_id: r.card_id,
      card_name: r.card_id ? (cardNames.get(r.card_id) ?? null) : null,
      card_type: humanCardType(str(md.card_type)),
      list: str(md.board_list),
      open,
    };
  });
  return entries.sort((a, b) => new Date(b.asked_at ?? 0).getTime() - new Date(a.asked_at ?? 0).getTime());
}

/** Board-level custom field `card_type` per card (the conveyor stamps it on every card it mints). */
function cardTypesOf(board: BoardDetail): Map<string, string> {
  const inc = (board.included ?? {}) as Record<string, unknown>;
  const fields = Array.isArray(inc.customFields) ? (inc.customFields as Record<string, unknown>[]) : [];
  const values = Array.isArray(inc.customFieldValues) ? (inc.customFieldValues as Record<string, unknown>[]) : [];
  const typeFieldIds = new Set(fields.filter((f) => f.name === 'card_type').map((f) => String(f.id)));
  const out = new Map<string, string>();
  for (const v of values) {
    if (!typeFieldIds.has(String(v.customFieldId))) continue;
    const c = str(v.content);
    if (c) out.set(String(v.cardId), c);
  }
  return out;
}

/** Comment author for the timeline: the conveyor, a person fr attributed (`via @x:`), or the Planka user. */
function commentAuthor(c: Comment, conveyorUserId: string, plankaNames: Map<string, string>): string {
  const via = /^via @([^:\s]+):/.exec(String(c.text ?? ''));
  if (via) return via[1]!;
  if (conveyorUserId && c.userId && String(c.userId) === String(conveyorUserId)) return 'Conveyor';
  return (c.userId && plankaNames.get(String(c.userId))) || 'Board member';
}

function toTimeline(
  comments: Comment[],
  conveyorUserId: string,
  plankaNames: Map<string, string>,
): CardTimelineEntry[] {
  return comments
    .map((c) => {
      const p = parseConveyorComment(c.text);
      return {
        id: String(c.id),
        created_at: iso((c as { createdAt?: string | null }).createdAt ?? null),
        author: commentAuthor(c, conveyorUserId, plankaNames),
        kind: p.kind,
        list: p.list,
        text: p.text.replace(/^via @[^:\s]+:\s*/, ''),
        summary: p.summary,
        data: p.data,
      };
    })
    .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
}

async function readAllComments(cardId: string): Promise<{ items: Comment[]; truncated: boolean }> {
  const items: Comment[] = [];
  let before: string | undefined;
  for (let page = 0; page < COMMENT_PAGES_MAX; page++) {
    const batch = await plankaClient.asAgent().comments.listForCard(cardId, before ? { beforeId: before } : {});
    if (!batch.length) return { items, truncated: false };
    items.push(...batch);
    const last = batch[batch.length - 1]!;
    if (String(last.id) === before) return { items, truncated: false };
    before = String(last.id);
  }
  return { items, truncated: true };
}

async function mapLimited<T, R>(xs: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

interface CardComments {
  cardId: string;
  comments: Comment[] | null;
  truncated: boolean;
  error: string | null;
}

/** Pull requests named anywhere in a card's comments (prose or JSON), with the branch / head the card's blocks name. */
function deliveredFrom(
  cards: { id: string; name: string; comments: Comment[] }[],
): Omit<DeliveredPr, 'state' | 'title' | 'state_unavailable'>[] {
  const out: Omit<DeliveredPr, 'state' | 'title' | 'state_unavailable'>[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const oldestFirst = [...card.comments].sort(
      (a, b) =>
        new Date(String((a as { createdAt?: string }).createdAt ?? 0)).getTime() -
        new Date(String((b as { createdAt?: string }).createdAt ?? 0)).getTime(),
    );
    const blocks = oldestFirst.flatMap((c) => parseConveyorComment(c.text).blocks);
    const branch = branchFromBlocks(blocks);
    const head = headShaFromBlocks(blocks);
    for (const c of oldestFirst) {
      for (const pr of extractPullRequestUrls(c.text)) {
        const key = prKey(pr.owner, pr.repo, pr.number);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          url: pr.url,
          repo: `${pr.owner}/${pr.repo}`,
          number: pr.number,
          branch,
          head_sha: head,
          card_id: card.id,
          card_name: card.name,
          first_seen_at: iso((c as { createdAt?: string | null }).createdAt ?? null),
        });
      }
    }
  }
  return out;
}

/** Plain-language reason a PR's state could not be read — never an upstream body. */
async function readPrState(
  repo: string,
  number: number,
  tenantId: string | null,
): Promise<{ ok: true; value: PrStateResult } | { ok: false; reason: string }> {
  let token: string | null = null;
  try {
    const t = await requestCloneToken(`https://github.com/${repo}`, { scope: 'pr-read', tenantId });
    token = t.token;
  } catch {
    return { ok: false, reason: 'repository access is not available to fr right now' };
  }
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'fr-project-history',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}/repos/${repo}/pulls/${number}`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { ok: false, reason: 'GitHub could not be reached' };
  }
  if (res.status === 404) return { ok: false, reason: 'GitHub did not show this pull request to fr' };
  if (res.status !== 200) return { ok: false, reason: `GitHub answered HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'GitHub returned an unreadable answer' };
  }
  if (!isRecord(body)) return { ok: false, reason: 'GitHub returned an unreadable answer' };
  const merged = body.merged === true || (typeof body.merged_at === 'string' && body.merged_at !== '');
  const state = merged ? 'merged' : body.state === 'open' ? 'open' : body.state === 'closed' ? 'closed' : null;
  if (!state) return { ok: false, reason: 'GitHub returned an unreadable answer' };
  const head = isRecord(body.head) ? str(body.head.ref) : null;
  return { ok: true, value: { state, title: str(body.title), head_ref: head } };
}

/** `owner/repo`, lower-cased, of every github.com repository linked to the project. */
function projectRepoKeys(urls: string[]): Set<string> {
  const out = new Set<string>();
  for (const u of urls) {
    const r = parseGithubRepo(u);
    if (r) out.add(`${r.owner}/${r.repo}`.toLowerCase());
  }
  return out;
}

const PR_NOT_PROJECT_REPO = 'state not checked: not a project repository';
const PR_REPOS_UNREADABLE = "state not checked: the project's repositories could not be read";

// ── Aggregate ───────────────────────────────────────────────────────────────

export interface HistoryProject {
  id: string;
  planka_board_id: string | null;
  /** The project's tenant tag (`project_data.keycloak_tenant_id`), for the GitHub token mint. */
  tenant_tag: string | null;
}

export async function buildConveyorHistory(
  project: HistoryProject,
  tenantId: string,
  /** The board, when the caller already read it (the cockpit): not read a second time. */
  opts: { board?: BoardDetail } = {},
): Promise<ConveyorHistory> {
  const boardId = project.planka_board_id;
  const boardBlock: Block<BoardDetail> = opts.board
    ? availableBlock('planka', opts.board)
    : boardId
      ? await block('planka', () => plankaClient.asAgent().boards.get(boardId))
      : unavailableBlock<BoardDetail>('planka', 'this project has no board', 'no_data');
  const board = boardBlock.meta.available ? boardBlock.data : null;
  const boardCards = board?.included.cards ?? [];
  const cardNames = new Map(boardCards.map((c) => [String(c.id), c.name]));

  // ── conversation ──
  const conversation = await block('fr-db', async () => {
    const { rows, decisions } = await listConveyorApprovalsFromDb(project.id, tenantId);
    const ids = new Set(decisions.map((d) => d.approver_id));
    const names = ids.size ? await resolveActorNames(ids) : new Map<string, string>();
    return { entries: buildConversation(rows, decisions, names, cardNames) };
  });

  // ── cards + delivered (both need the board) ──
  if (!board) {
    const reason = boardBlock.meta.error ?? 'the board could not be read';
    const kind = boardBlock.meta.unavailable_kind ?? 'error';
    return {
      conversation,
      cards: unavailableBlock<CardsPayload>('planka', reason, kind),
      delivered: unavailableBlock<DeliveredPayload>('planka', reason, kind),
    };
  }

  const listName = new Map((board.included.lists ?? []).map((l) => [String(l.id), l.name ?? null]));
  const types = cardTypesOf(board);
  const plankaNames = new Map(
    (board.included.users ?? []).map((u) => [String(u.id), String((u as { name?: string }).name ?? '')] as const).filter(([, n]) => n),
  );
  const conveyorUser = config.services.planka.conveyorUserId;

  const perCard: CardComments[] = await mapLimited(boardCards, COMMENT_FETCH_CONCURRENCY, async (c) => {
    try {
      const { items, truncated } = await readAllComments(String(c.id));
      return { cardId: String(c.id), comments: items, truncated, error: null };
    } catch {
      return { cardId: String(c.id), comments: null, truncated: false, error: 'the comments could not be read from the board' };
    }
  });
  const commentsOf = new Map(perCard.map((p) => [p.cardId, p]));

  const cards: HistoryCard[] = boardCards
    .map((c): HistoryCard => {
      const cc = commentsOf.get(String(c.id));
      const comments = cc?.comments ? toTimeline(cc.comments, conveyorUser, plankaNames) : null;
      return {
        id: String(c.id),
        name: c.name,
        list_name: listName.get(String(c.listId)) ?? null,
        card_type: humanCardType(types.get(String(c.id)) ?? null),
        last_moved_at: iso(c.listChangedAt ?? c.updatedAt ?? c.createdAt ?? null),
        comment_count: comments?.length ?? 0,
        comments_truncated: cc?.truncated ?? false,
        comments,
        comments_error: cc?.error ?? null,
      };
    })
    .sort((a, b) => new Date(b.last_moved_at ?? 0).getTime() - new Date(a.last_moved_at ?? 0).getTime());

  const failedCards = perCard.filter((p) => p.comments === null).length;
  const cardsBlock = availableBlock<CardsPayload>('planka', { cards });
  if (failedCards > 0) {
    cardsBlock.meta.note = `the comments of ${failedCards} ${failedCards === 1 ? 'card' : 'cards'} could not be read`;
  }

  const found = deliveredFrom(
    boardCards
      .map((c) => ({ id: String(c.id), name: c.name, comments: commentsOf.get(String(c.id))?.comments ?? [] }))
      .filter((c) => c.comments.length > 0),
  );
  // Only the project's own repositories are looked up; a failed read fails CLOSED (no lookup at all).
  let ownRepos: Set<string> | null = null;
  if (found.length > 0) {
    try {
      ownRepos = projectRepoKeys((await loadProjectRepositories(project.id)).repositories.map((r) => r.url));
    } catch {
      ownRepos = null;
    }
  }
  const lookups = found.filter((pr) => ownRepos?.has(pr.repo.toLowerCase()));
  const lookupRank = new Map(lookups.map((pr, i) => [pr, i]));
  const pull_requests: DeliveredPr[] = await mapLimited(found, 3, async (pr) => {
    if (ownRepos === null) return { ...pr, state: null, title: null, state_unavailable: PR_REPOS_UNREADABLE };
    const rank = lookupRank.get(pr);
    if (rank === undefined) return { ...pr, state: null, title: null, state_unavailable: PR_NOT_PROJECT_REPO };
    if (rank >= PR_STATE_MAX) return { ...pr, state: null, title: null, state_unavailable: 'not looked up (too many pull requests)' };
    const r = await readPrState(pr.repo, pr.number, project.tenant_tag);
    if (!r.ok) return { ...pr, state: null, title: null, state_unavailable: r.reason };
    return { ...pr, branch: pr.branch ?? r.value.head_ref, state: r.value.state, title: r.value.title, state_unavailable: null };
  });
  const deliveredBlock = availableBlock<DeliveredPayload>('planka', { pull_requests });
  if (failedCards > 0) {
    deliveredBlock.meta.note = `the comments of ${failedCards} ${failedCards === 1 ? 'card' : 'cards'} could not be read, so a pull request may be missing`;
  }

  return { conversation, cards: cardsBlock, delivered: deliveredBlock };
}
