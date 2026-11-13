// Plan 6 — GET /api/cards/:id
//
// Returns the Planka card + its 8 AA customFieldGroups (Metadata,
// Relations, Acceptance Criteria, Validation, Requirements, Principles,
// Decisions, Procedures) normalised into a single shape the
// fr-frontend /cards/[id] page (Wave A) can render in one round-trip.
//
// Two upstream calls:
//   1. GET /api/cards/:id  → CardDetail (item + included.customFieldValues + tasks)
//   2. GET /api/boards/:boardId → BoardDetail (used for the
//      customFieldId → (groupName, fieldName) mapping + the list-name
//      lookup so the UI can render "Phase: DOING" without a third hop).
//      ⚠️ This call is NOT per-request. It goes through the process-wide
//      `boardMetadataCache` (services/planka/board-metadata-cache.ts), which
//      keeps only the three small arrays this route reads and drops the
//      board's cards + customFieldValues bags. Making it per-request was the
//      2026-09-09 OOMKill: no Planka endpoint returns board metadata without
//      also returning every card and every customFieldValue on the board.
//
// Plus two local DB reads:
//   * `streams` keyed on `planka_board_id = card.boardId` — resolves the
//     card's owning tenant (cards have no native tenant scope; ownership
//     flows board → stream → tenant). Powers the response `tenant` +
//     `is_system` fields the Wave A header consumes.
//   * `approvals` + `approval_decisions` keyed on `card_id = :id` —
//     materialises per-PHILOSOPHY.md L79–82 "approval outcomes are
//     decisions" so the Wave A Decisions section can render approvals
//     and free-text decision_N slots in one chronological feed.
//
// `kag_seeker[]` was the W-1 stub. Wave D (2026-05-18) lands the
// upstream-writer half: the `card_seeker_links` table (migration 063)
// + POST /api/cards/:id/seeker-links route, plus the corresponding
// n8n `ActionWriteSeekerLinks` step in ready-prefetch.json. The
// response now reads those rows; an empty array means n8n's Seeker
// step has not (yet) run for this card.
//
// Tenant gate: authenticated AND tenant-authorized. The card is fetched
// with the ADMIN Planka agent (`.asAgent()`), which bypasses Planka's
// board-membership checks, so auth alone is NOT enough — `handleGetCard`
// resolves the card's owning tenant (board → project/stream) and 404s any
// card that belongs to a different regular tenant (fail-closed). Platform-
// tenant cards are readable by platform callers ONLY (fr row 14d-2); a
// customer never sees a system/improvement card.

import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  db as defaultDb,
  approvals,
  approvalDecisions,
  cardSeekerLinks,
} from '../../db/client';
import { validateAuth } from '../../middleware/auth';
import { isBlocked, phaseFromListName, type Phase } from '../../lib/phase';
import { ctxTenantId } from '../../middleware/request-context';
import { UnauthorizedError } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { PlankaClient } from '../../services/planka';
import {
  GROUP_FIELDS,
  GROUP_POSITIONS,
  type GroupName,
} from '../../services/improvement-cards/field-groups';
import { PlankaError } from '../../services/planka/errors';
import {
  boardMetadataCache,
  type BoardMetadata,
} from '../../services/planka/board-metadata-cache';
import { isInternalTenant } from '../../middleware/internal-tenant-only';
import { projectIdsReadableAsGetProject } from '../../lib/project-access';
import type { User } from '../../types/api';
import {
  resolveBoardTenant,
  resolveBoardProjectId,
  platformAwareTenantReadable,
} from '../../lib/board-tenant-access';
import { isPlatformTenant } from '../assets/_lib/system-union';
import { reportBoardTenantGateRefusal } from '../../lib/board-tenant-gate-metrics';
import {
  loadVersionStamp,
  type VersionStamp,
} from '../../services/improvement-cards/version-stamp';
import {
  loadScenarioEvidence,
  type StoredScenarioEvidence,
} from '../../services/scenario-evidence';

interface SeekerLinkRow {
  kag_entity_id: string;
  score: number | null;
  created_at: string;
}
/**
 * Approval-derived decision row, joined approvals + approval_decisions.
 * One approval can produce multiple rows (one per approver_decision) —
 * each appears in the merged decisions[] feed as its own entry, sorted
 * by decided_at.
 */
interface ApprovalDecisionRow {
  approval_id: string;
  decision_id: string;
  approval_status: string; // 'approved' | 'rejected' | 'pending'
  approval_description: string;
  approver_id: string;
  decision: string; // 'approved' | 'rejected'
  comment: string | null;
  decided_at: string; // ISO
  /**
   * ISO creation instant of the parent approval (`approvals.created_at`), so a
   * consumer (the ncn approval callback) can tell an older sign-off from a newer
   * one. null when the parent approval row is not in the card's approval set.
   */
  approval_created_at: string | null;
  /** Migration 211 (R-CK1): human | triage_agent | rule. */
  decided_by_kind?: string;
}

/**
 * Normalised decision row, discriminated by `source`. Planka rows come
 * from `groups.Decisions.decision_N` text slots (no timestamps —
 * frontend pins them after timestamped approval rows). Approval rows
 * carry a deep-link to /approvals/[approval_id] in the Wave A UI.
 */
type DecisionRow =
  | {
      source: 'planka';
      id: string; // 'decision_1' .. 'decision_5'
      text: string;
    }
  | {
      source: 'approval';
      id: string; // decision_id (approval_decisions row pk)
      approval_id: string;
      approval_status: string;
      approval_description: string;
      approver_id: string;
      outcome: string; // 'approved' | 'rejected'
      comment: string | null;
      decided_at: string;
      /** Parent approval's `created_at` (ISO); null when the approval row is missing. */
      approval_created_at: string | null;
      /** Migration 211: human | triage_agent | rule; null only for a row built without it. */
      decided_by_kind: string | null;
    };

/**
 * A card's open (pending) approval. The merged `decisions[]` feed only
 * carries *decided* approvals (loadApprovalDecisionsByCardId excludes
 * pending), so the BLOCKED gate on the card page can't read the open
 * approval from there — it reads this list instead. Card approvals raised
 * by n8n (POST /api/webhooks/n8n/card-approval) carry no required-approver
 * rows; they are resolved out-of-band via the n8n `callback_path` /
 * `recipient`, so this is a *read-only* surface — there is no per-approver
 * inline approve path for them.
 */
interface OpenApprovalRow {
  approval_id: string;
  description: string;
  status: string;
  source: string | null;
  callback_path: string | null;
  recipient: string | null;
  created_at: string;
  expires_at: string | null;
}

/** Raw Planka card action (activity-log entry). */
export interface RawCardAction {
  id: string;
  type: string;
  data?: {
    list?: { id?: string; name?: string };
    fromList?: { id?: string; name?: string };
    toList?: { id?: string; name?: string };
    /** `updateCustomFieldValue` (planka-private#20): the field written and its new value. */
    customFieldName?: string;
    content?: string | null;
  };
  createdAt?: string | null;
}

/**
 * One list transition from the Planka card-action log, annotated with the
 * AA phase each list maps to. This is the decoupled, Planka-sourced phase
 * journey — fr never asks n8n. n8n drives the card through Planka lists;
 * fr reconstructs the journey from the list-move actions Planka records.
 */
interface PhaseTransitionRow {
  action_id: string;
  type: string; // 'createCard' | 'moveCard'
  from_list: string | null;
  to_list: string | null;
  from_phase: Phase | null;
  to_phase: Phase | null;
  at: string | null;
  /**
   * BLOCKED steps only, and only when Planka recorded a `block_reason` write for
   * THIS step (see buildPhaseJourney). Absent ⇒ no reason recorded — never the
   * card's current reason copied backwards.
   */
  block_reason?: string;
  block_reason_at?: string;
}

// The list-name → phase mapping is lib/phase.ts phaseFromListName (DONE decided by the shared
// lib/done-equivalent.ts predicate). It used to be a second inline copy of the map here.
function authErrorToResponse(e: unknown): Response {
  const code = (e as { code?: string }).code;
  const isJoseAuthError = typeof code === 'string' && code.startsWith('ERR_JWT_');
  if (e instanceof UnauthorizedError || isJoseAuthError) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  throw e;
}

const ALL_GROUPS = Object.keys(GROUP_POSITIONS) as GroupName[];

interface RawCustomFieldValue {
  cardId: string;
  customFieldGroupId: string;
  customFieldId: string;
  content: unknown;
}

interface RawCustomField {
  id: string;
  name: string;
  customFieldGroupId: string;
}

interface RawCustomFieldGroup {
  id: string;
  name: string;
}

/**
 * Build a name-keyed map from raw Planka customFieldValues. Returns one
 * entry per AA group (8 entries) — fields with no value default to the
 * empty string so the frontend can rely on key presence.
 */
function normaliseGroups(
  groups: RawCustomFieldGroup[],
  fields: RawCustomField[],
  values: RawCustomFieldValue[],
): Record<GroupName, Record<string, string>> {
  // groupId → groupName, customFieldId → (groupName, fieldName)
  const groupNameById = new Map(groups.map((g) => [g.id, g.name as GroupName]));
  const fieldKey = new Map<
    string,
    { groupName: GroupName; fieldName: string }
  >();
  for (const f of fields) {
    const groupName = groupNameById.get(f.customFieldGroupId);
    if (!groupName) continue;
    if (!ALL_GROUPS.includes(groupName)) continue;
    fieldKey.set(f.id, { groupName, fieldName: f.name });
  }

  // Initialise every known field to '' so callers see a stable shape.
  const out = {} as Record<GroupName, Record<string, string>>;
  for (const g of ALL_GROUPS) {
    out[g] = {};
    for (const fName of GROUP_FIELDS[g]) out[g][fName] = '';
  }

  for (const v of values) {
    const k = fieldKey.get(v.customFieldId);
    if (!k) continue;
    out[k.groupName][k.fieldName] = String(v.content ?? '');
  }
  // fr#1516: a relation stored as "null"/"undefined" is NO relation — blank it so
  // no consumer renders it as a card id ("Card null").
  for (const f of RELATION_ID_FIELDS) {
    const v = out.Relations?.[f];
    if (v && relationIds(v).length === 0) out.Relations[f] = '';
  }
  return out;
}

interface CardDetailWithExtras {
  item: {
    id: string;
    name: string;
    description: string | null;
    listId: string;
    boardId: string;
    type?: string;
    position?: number;
    dueDate?: string | null;
    isClosed?: boolean;
    createdAt?: string;
    updatedAt?: string;
  };
  included?: {
    customFieldValues?: RawCustomFieldValue[];
    tasks?: Array<{
      id: string;
      name: string;
      isCompleted: boolean;
      taskListId: string;
      position?: number;
    }>;
    taskLists?: Array<{ id: string; name: string; position?: number }>;
  };
}

interface BoardDetailWithExtras {
  item: { id: string; name: string };
  included?: {
    lists?: Array<{ id: string; name: string }>;
    customFieldGroups?: RawCustomFieldGroup[];
    customFields?: RawCustomField[];
  };
}

/**
 * Resolve a card's owning tenant from its Planka board. A board belongs to
 * either an fr **project** (project task boards) or an fr **stream**
 * (improvement / AA framework boards):
 *   - project: `projects.planka_board_id` → `departments.workspace_id`, or
 *     `project_data.keycloak_tenant_id` for dept-less projects (same chain as
 *     migration 080 / `resolveCardApprovalTenant`).
 *   - stream:  `streams.planka_board_id` → `streams.tenant_id`.
 * Returns null only for boards fr does not own (truly ad-hoc Planka boards).
 *
 * This powers BOTH the response `tenant`/`is_system` fields AND the
 * cross-tenant access gate in `handleGetCard` — a card must never resolve to a
 * regular tenant other than the caller's.
 */
// Exported so the sibling WRITE route (POST /api/cards/:id/seeker-links)
// resolves a card's owning tenant via the EXACT same chain as this read
// gate — read and write must agree on which tenant owns a card.
export async function loadCardTenantByBoardId(
  boardId: string,
  db: typeof defaultDb = defaultDb,
): Promise<string | null> {
  // Single source of truth lives in lib/board-tenant-access so the kanban read
  // gate and this cards route agree on board→tenant ownership.
  return resolveBoardTenant(boardId, db);
}

/**
 * Load the merged approvals × approval_decisions feed for one card.
 * Each approver-decision row becomes a single entry. Pending approvals
 * (no decisions yet) are excluded — they belong on /approvals, not in
 * the cards Decisions feed.
 */
async function loadApprovalDecisionsByCardId(
  cardId: string,
  tenantId: string,
  db: typeof defaultDb = defaultDb,
): Promise<ApprovalDecisionRow[]> {
  const approvalRows = await db
    .select({
      id: approvals.id,
      status: approvals.status,
      description: approvals.description,
      created_at: approvals.created_at,
    })
    .from(approvals)
    // ⛔ Pinned to the ACTIVE tenant (fr row 14d). The card gate admits an
    // internal/system card to every caller, and an approval's tenant_id can
    // differ from its card's (webhooks card-approval lets a body tenant_id
    // win), so card_id alone would hand a customer system approval rows.
    .where(and(eq(approvals.card_id, cardId), eq(approvals.tenant_id, tenantId)));
  if (approvalRows.length === 0) return [];

  const approvalIds = approvalRows.map((r) => r.id);
  const decisionRows = await db
    .select({
      id: approvalDecisions.id,
      approval_id: approvalDecisions.approval_id,
      approver_id: approvalDecisions.approver_id,
      decision: approvalDecisions.decision,
      comment: approvalDecisions.comment,
      decided_at: approvalDecisions.decided_at,
      decided_by_kind: approvalDecisions.decided_by_kind,
    })
    .from(approvalDecisions)
    .where(inArray(approvalDecisions.approval_id, approvalIds));

  const approvalById = new Map(approvalRows.map((r) => [r.id, r]));
  return decisionRows.map((d) => {
    const a = approvalById.get(d.approval_id);
    return {
      approval_id: d.approval_id,
      decision_id: d.id,
      approval_status: a?.status ?? 'unknown',
      approval_description: a?.description ?? '',
      approver_id: d.approver_id,
      decision: d.decision,
      comment: d.comment,
      decided_at: d.decided_at.toISOString(),
      approval_created_at: a?.created_at?.toISOString() ?? null,
      decided_by_kind: d.decided_by_kind,
    };
  });
}

/**
 * Load the open (pending) approvals for one card. Feeds the BLOCKED-gate
 * surface on the card page. The `recipient` is lifted out of the
 * approval `metadata` (where the n8n card-approval webhook stores it).
 */
async function loadOpenApprovalsByCardId(
  cardId: string,
  tenantId: string,
  db: typeof defaultDb = defaultDb,
): Promise<OpenApprovalRow[]> {
  const rows = await db
    .select({
      id: approvals.id,
      status: approvals.status,
      description: approvals.description,
      source: approvals.source,
      callback_path: approvals.callback_path,
      metadata: approvals.metadata,
      created_at: approvals.created_at,
      expires_at: approvals.expires_at,
    })
    .from(approvals)
    // ⛔ Active tenant only — same reason as loadApprovalDecisionsByCardId.
    .where(
      and(
        eq(approvals.card_id, cardId),
        eq(approvals.tenant_id, tenantId),
        eq(approvals.status, 'pending'),
      ),
    )
    .orderBy(desc(approvals.created_at));
  return rows.map((r) => ({
    approval_id: r.id,
    description: r.description,
    status: r.status,
    source: r.source,
    callback_path: r.callback_path,
    recipient:
      (r.metadata as { recipient?: string } | null)?.recipient ?? null,
    created_at: r.created_at.toISOString(),
    // NULL = no deadline (migration 105). `.toISOString()` on it threw a 500 on exactly
    // the BLOCKED cards this route exists to show.
    expires_at: r.expires_at?.toISOString() ?? null,
  }));
}

/**
 * Planka's card-action page size: `Action.qm.getByCardId` is
 * `find({cardId, id < beforeId}).sort('id DESC').limit(LIMIT)` with `LIMIT = 50`
 * (planka server/api/hooks/query-methods/models/Action.js). A page SHORTER than
 * this is therefore the end of the card's history; a full page may not be.
 */
const PLANKA_CARD_ACTIONS_PAGE_SIZE = 50;

/**
 * How many action pages `readCardActionHistory` reads by default — the same bound
 * the deblock redelivery worker uses for its sign-off journey check.
 */
const CARD_ACTION_HISTORY_MAX_PAGES = 5;

/**
 * The card GET's own page bound (1000 actions). Higher than the default because
 * `phase_journey` now also carries every BLOCKED step's own reason, and a busy
 * card's early blocks sit far back. Pages 2+ are read only when page 1 was full.
 */
const CARD_GET_ACTION_HISTORY_MAX_PAGES = 20;

/**
 * Fetch ONE page of a card's Planka action log, newest first. `beforeId` is the
 * paging cursor (Planka: "ID to get actions before"). Throws when the response
 * carries no `items[]` — an unparseable answer is an unreadable log, not an empty
 * one.
 */
export async function loadCardActionsViaPlanka(
  planka: PlankaClient,
  cardId: string,
  beforeId?: string,
): Promise<RawCardAction[]> {
  const res = (await planka.http.request(
    'GET',
    `/api/cards/${encodeURIComponent(cardId)}/actions`,
    beforeId ? { query: { beforeId } } : {},
  )) as { items?: RawCardAction[] } | RawCardAction[];
  const items = Array.isArray(res) ? res : res?.items;
  if (!Array.isArray(items)) throw new Error('card actions response carried no items[]');
  return items;
}

interface CardActionHistory {
  /** Every action read, across all pages, in the order Planka served them. */
  actions: RawCardAction[];
  /**
   * true ONLY when the card's WHOLE action history was read: a page shorter than
   * `PLANKA_CARD_ACTIONS_PAGE_SIZE` (incl. an empty LATER page) was served, or a
   * `createCard` action — the first action any card has — was seen. false when
   * the page budget ran out on a full page, paging could not advance, the caller
   * stopped early, or the FIRST page was empty (every card has a `createCard`, so
   * an empty first page is an outage, not a history).
   */
  complete: boolean;
  /** The raw `createdAt` of the oldest DATED action read; null if none. */
  oldest_at: string | null;
  /** Pages fetched (each one Planka read). */
  pages_read: number;
}

/**
 * Page a card's Planka action log backwards (newest first) for up to `maxPages`
 * pages. ONE paging implementation for the card GET's `phase_journey` and the
 * deblock redelivery worker's sign-off refusal, so the two cannot disagree about
 * how much of a card's history they have seen.
 *
 * The next page is requested ONLY when the current one is full, so a card with
 * fewer than 50 actions costs exactly one read. Cursor = the LAST item's id,
 * because Planka sorts `id DESC` and filters `id < beforeId`.
 *
 * `stopWhen(page)` lets a caller end the walk once it has what it needs (the
 * result is then `complete: false` unless that page also ended the history).
 * Errors from `fetchPage` propagate — the caller decides what unreadable means.
 */
export async function readCardActionHistory(
  fetchPage: (beforeId: string | undefined) => Promise<RawCardAction[]>,
  opts: { maxPages?: number; stopWhen?: (page: RawCardAction[]) => boolean } = {},
): Promise<CardActionHistory> {
  const maxPages = opts.maxPages ?? CARD_ACTION_HISTORY_MAX_PAGES;
  const actions: RawCardAction[] = [];
  let complete = false;
  let pages_read = 0;
  let beforeId: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const items = await fetchPage(beforeId);
    pages_read += 1;
    if (items.length === 0) {
      complete = page > 0;
      break;
    }
    actions.push(...items);
    if (items.some((a) => a.type === 'createCard') || items.length < PLANKA_CARD_ACTIONS_PAGE_SIZE) {
      complete = true;
      break;
    }
    if (opts.stopWhen?.(items)) break;
    const cursor = items[items.length - 1]?.id;
    // No-progress guard: a Planka ignoring `beforeId` would serve page 1 forever.
    if (!cursor || cursor === beforeId) break;
    beforeId = cursor;
  }
  let oldest_at: string | null = null;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const a of actions) {
    const ms = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
    if (!Number.isNaN(ms) && ms < oldestMs) {
      oldestMs = ms;
      oldest_at = a.createdAt ?? null;
    }
  }
  return { actions, complete, oldest_at, pages_read };
}

async function loadSeekerLinksByCardId(
  cardId: string,
  db: typeof defaultDb = defaultDb,
): Promise<SeekerLinkRow[]> {
  const rows = await db
    .select({
      kag_entity_id: cardSeekerLinks.kag_entity_id,
      score: cardSeekerLinks.score,
      created_at: cardSeekerLinks.created_at,
    })
    .from(cardSeekerLinks)
    .where(eq(cardSeekerLinks.card_id, cardId))
    .orderBy(desc(cardSeekerLinks.created_at));
  return rows.map((r) => ({
    kag_entity_id: r.kag_entity_id,
    score: r.score,
    created_at: r.created_at.toISOString(),
  }));
}

/** Relations fields whose values are card ids (RelationsSection.svelte renders the same four). */
const RELATION_ID_FIELDS = ['parent_card', 'child_cards', 'requires', 'required_by'] as const;

/** At most this many related cards are looked up per card read. */
const RELATED_TITLES_MAX = 10;

/** Per-call Planka timeout for a related-card lookup (single attempt, no retry). */
const RELATED_TITLE_TIMEOUT_MS = 2_000;

/**
 * Hard ceiling on the WHOLE related-titles step (Planka read + tenant lookup
 * per id). Anything not settled by then is omitted — the main response never
 * waits longer than this for titles.
 */
const RELATED_TITLES_DEADLINE_MS = 2_500;

/**
 * Split one Relations field value into card ids. Same tolerant parse as
 * frontend RelationsSection.svelte `ids()`: a JSON array string, or a
 * comma/whitespace-separated list. "null" / "undefined" tokens (any case) are
 * not ids (fr#1516 — a relation written as the string "null").
 */
const isRelationId = (s: string): boolean => s !== '' && !/^(null|undefined)$/i.test(s);
function relationIds(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  const raw = value.trim();
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.filter((x) => x != null).map((x) => String(x).trim()).filter(isRelationId);
    } catch {
      // fall through to delimiter split
    }
  }
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(isRelationId);
}

/**
 * UI review #7: titles for the card's related/parent/child cards, so the
 * standalone /cards/[id] page (no board loaded) does not render "Card …<tail>".
 *
 * BOUNDED: Planka has no multi-card read and the full board read is forbidden
 * (board-metadata-cache.ts — the 2026-09-09 OOMKill), so this is a per-id
 * `GET /api/cards/:id` — the SAME single-card read the handler uses for the
 * main card — for at most RELATED_TITLES_MAX deduped ids, in parallel, each
 * single-attempt with a RELATED_TITLE_TIMEOUT_MS Planka timeout, and the whole
 * step capped at RELATED_TITLES_DEADLINE_MS. Any failure/timeout ⇒ that id is
 * omitted; this never throws.
 *
 * ⛔ Tenant gate: the read uses the ADMIN agent, so each related card is
 * subjected to the SAME predicate as the main card (`platformAwareTenantReadable`
 * on its board's owning tenant). A related card on another tenant's board — or
 * whose tenant lookup fails — is omitted, never named.
 */
async function loadRelatedTitles(args: {
  planka: PlankaClient;
  relations: Record<string, string> | undefined;
  selfId: string;
  selfBoardId: string;
  callerTenant: string;
}): Promise<Record<string, string>> {
  const { planka, relations, selfId, selfBoardId, callerTenant } = args;
  const seen = new Set<string>();
  for (const f of RELATION_ID_FIELDS) {
    for (const id of relationIds(relations?.[f])) {
      if (id !== selfId) seen.add(id);
    }
  }
  const ids = [...seen].slice(0, RELATED_TITLES_MAX);
  if (ids.length === 0) return {};

  // One tenant lookup per distinct board. The main card's board already passed
  // the gate above, so it is not looked up again.
  const readableByBoard = new Map<string, Promise<boolean>>();
  readableByBoard.set(selfBoardId, Promise.resolve(true));
  const boardReadable = (bId: string): Promise<boolean> => {
    let p = readableByBoard.get(bId);
    if (!p) {
      p = loadCardTenantByBoardId(bId).then(
        (t) => platformAwareTenantReadable(t, callerTenant),
        () => false,
      );
      readableByBoard.set(bId, p);
    }
    return p;
  };

  const lookup = async (id: string): Promise<[string, string]> => {
    const res = (await planka.http.request(
      'GET',
      `/api/cards/${encodeURIComponent(id)}`,
      { timeoutMs: RELATED_TITLE_TIMEOUT_MS, singleAttempt: true },
    )) as CardDetailWithExtras | undefined;
    const name = res?.item?.name;
    const bId = res?.item?.boardId;
    if (typeof name !== 'string' || !name.trim() || typeof bId !== 'string') {
      throw new Error('related card carried no name/boardId');
    }
    if (!(await boardReadable(bId))) throw new Error('related card not readable by caller');
    return [id, name];
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('related titles deadline')), RELATED_TITLES_DEADLINE_MS);
  });
  try {
    const settled = await Promise.allSettled(ids.map((id) => Promise.race([lookup(id), deadline])));
    const out: Record<string, string> = {};
    for (const s of settled) if (s.status === 'fulfilled') out[s.value[0]] = s.value[1];
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleGetCard(
  req: Request,
  cardId: string,
): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }

  const planka = PlankaClient.fromConfig().asAgent();

  let card: CardDetailWithExtras;
  try {
    card = (await planka.http.request(
      'GET',
      `/api/cards/${encodeURIComponent(cardId)}`,
      {},
    )) as CardDetailWithExtras;
  } catch (e) {
    if (e instanceof PlankaError && e.status === 404) {
      return jsonResponse({ error: 'card_not_found', card_id: cardId }, 404);
    }
    throw e;
  }

  const boardId = card.item.boardId;

  // ── Cross-tenant access gate ──────────────────────────────────────────
  // The card was fetched with the ADMIN Planka agent, which bypasses Planka's
  // board-membership enforcement, so FR must gate by tenant itself. Resolve
  // the card's owning tenant (board → project/stream) and deny unless it is
  // the caller's tenant or an internal/system framework tenant. Fail-closed:
  // another regular tenant, an un-attributable board, or a lookup error all
  // 404 — identical to "card not found" so a foreign id leaks nothing.
  let tenant: string | null;
  try {
    tenant = await loadCardTenantByBoardId(boardId);
  } catch (e) {
    console.error('[GET /api/cards/:id] tenant gate lookup failed', e);
    return jsonResponse({ error: 'card_not_found', card_id: cardId }, 404);
  }
  const callerTenant = ctxTenantId(user.tenantId);
  // ⭐ fr row 14d-2: the SHARED read predicate (lib/board-tenant-access.ts).
  // A platform-tenant card is readable only by a platform caller; a customer
  // gets the same 404 as a card that does not exist — and therefore none of
  // its version_stamp / scenario_evidence / approvals either.
  // Before 14d-2 this was `tenant === callerTenant || isInternalTenant(tenant)`,
  // which admitted ANY caller to internal-tenant cards.
  if (!platformAwareTenantReadable(tenant, callerTenant)) {
    // Count ONLY the population 14d-2 closed (platform card, non-platform
    // caller); the ordinary foreign-tenant 404 was never counted here.
    if (isPlatformTenant(tenant)) {
      reportBoardTenantGateRefusal({
        gate: 'card_read',
        reason: 'platform_board_foreign_read',
        boardId,
        cardId,
        owningTenant: tenant,
        activeTenant: callerTenant,
        userId: user.id,
      });
    }
    return jsonResponse({ error: 'card_not_found', card_id: cardId }, 404);
  }
  const is_system = isInternalTenant(tenant ?? undefined);
  // ⭐ `tenant_is_platform` — computed from the SAME `tenant` the gate above just
  // authorised this read on (board → project/stream, `loadCardTenantByBoardId`),
  // and from fr's ONE platform list (`PLATFORM_TENANT_IDS` via `isPlatformTenant`).
  // No second list, no second tenant source. The ncn signoff callback reads it to
  // refuse acting on a customer card (strict tenant separation).
  // ⛔ Fail-closed: an unresolved tenant (`null`) is `false`, never `true` —
  // `isPlatformTenant(null)` is false by construction.
  const tenant_is_platform = isPlatformTenant(tenant);

  // ── card → board → fr project (fr-agui SPEC §7.5) ─────────────────────────
  // The frontend moves `/cards/[id]` into the project shell
  // (`/projects/P/cards/[id]`) on this value, so it is resolved HERE, after the
  // tenant gate, from the board (`projects.planka_board_id`) — never from the
  // card's own editable Metadata. `null` = not a project board. A FAILED lookup
  // omits the field (unknown) rather than answering null, which would assert
  // "this card has no project" — the frontend then stays put.
  const loadProject =
    ((id: string) => resolveBoardProjectId(id));
  // ⛔ The card gate above is TENANT-wide (and platform-aware), but the project
  // read is not: an ordinary user reads only projects they own. A same-tenant
  // peer — or a platform caller on another platform tenant's card — must not be
  // handed an id that 404s in the project shell, so a project the caller cannot
  // GET is answered as `null` (stay on the tenant card view), never the id.
  const isReadable =
    (async (u: User, pid: string) => (await projectIdsReadableAsGetProject(u, [pid])).has(pid));
  let fr_project_id: string | null | undefined;
  try {
    const resolved = await loadProject(boardId);
    fr_project_id = resolved && (await isReadable(user, resolved)) ? resolved : null;
  } catch (e) {
    console.error('[GET /api/cards/:id] card project lookup failed', e);
    reportSwallowedFailure(e, {
      service: 'fr-db',
      degradedTo: 'fr_project_id omitted (unknown, NOT "no project"); the card view stays on /cards/[id]',
    });
    fr_project_id = undefined;
  }

  // ── Board metadata (list names + the customFieldId → field mapping) ───────
  // This read used to be an unconditional `GET /api/boards/:id` on EVERY card
  // request. Planka's board detail has no projection parameter, so `included`
  // also carries every card on the board and every customFieldValue of every
  // card — 3,943 cards / 44,092 values ≈ 17 MB raw on the largest live board,
  // ~100–300 MB of transient heap per request. Two concurrent card reads
  // exhausted the 1 GiB container limit and OOMKilled fr-backend twice on
  // 2026-09-09 under a sustained ~25/min `GET /api/cards/{id}` sweep.
  //
  // The handler only ever wanted three small arrays out of that payload:
  // `lists` (for ONE list's name), `customFieldGroups` and `customFields` (for
  // the field mapping). `board.item` was never read. Everything card-specific
  // — including which list the card is in and all of its field VALUES — comes
  // from the fresh `GET /api/cards/:id` above and is NOT cached.
  //
  // See services/planka/board-metadata-cache.ts for why no narrower Planka
  // endpoint exists, the cache bound, and the accepted staleness window.
  let boardMeta: BoardMetadata;
  try {
    boardMeta = await boardMetadataCache.get({
      boardId,
      fetchBoard: () =>
        planka.http.request(
          'GET',
          `/api/boards/${encodeURIComponent(boardId)}`,
          {},
        ) as Promise<BoardDetailWithExtras>,
      // Staleness probes: ids the FRESH card references. An id the cached entry
      // has never seen proves the entry predates a schema addition, so it is
      // discarded and refetched rather than silently dropping the field/name.
      probeListId: card.item.listId,
      probeFieldIds: (card.included?.customFieldValues ?? []).map(
        (v) => v.customFieldId,
      ),
    });
  } catch (e) {
    if (e instanceof PlankaError && e.status === 404) {
      return jsonResponse({ error: 'board_not_found', board_id: boardId }, 404);
    }
    throw e;
  }

  const lists = boardMeta.lists;
  const list = lists.find((l) => l.id === card.item.listId);
  const list_name = list?.name ?? null;

  const groups = normaliseGroups(
    boardMeta.customFieldGroups,
    boardMeta.customFields,
    card.included?.customFieldValues ?? [],
  );

  // Started now so it overlaps the DB reads below; awaited just before the
  // response. Bounded by RELATED_TITLES_DEADLINE_MS and never rejects.
  const relatedTitlesP = loadRelatedTitles({
    planka,
    relations: groups.Relations,
    selfId: card.item.id,
    selfBoardId: boardId,
    callerTenant,
  });

  // Build a flat tasks[] keyed to each taskList — the Wave A page
  // renders these under acceptance_criteria, but they're available for
  // generic consumption too.
  const taskListNameById = new Map(
    (card.included?.taskLists ?? []).map((tl) => [tl.id, tl.name]),
  );
  const tasks = (card.included?.tasks ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    is_completed: t.isCompleted,
    task_list_id: t.taskListId,
    task_list_name: taskListNameById.get(t.taskListId) ?? null,
    position: t.position ?? null,
  }));

  // Approvals-as-decisions merge — non-fatal: degraded DB returns []
  // and the Decisions section falls back to the Planka free-text slots
  // alone.
  const loadApprovals =
    ((id: string, t: string) => loadApprovalDecisionsByCardId(id, t));
  // ⚠️ null on failure, not []: an empty decision list renders as a complete
  // history that happens to be short, which is a different claim from "we could
  // not read the history".
  let approvalDecisionRows: ApprovalDecisionRow[] | null = null;
  try {
    approvalDecisionRows = await loadApprovals(cardId, callerTenant);
  } catch (e) {
    console.error('[GET /api/cards/:id] approval-decision lookup failed', e);
    reportSwallowedFailure(e, {
      service: 'fr-db',
      degradedTo: 'decisions=null (unknown, NOT "no decisions")',
    });
    approvalDecisionRows = null;
  }

  // `null` means the approvals read FAILED; the feed then carries only the
  // Planka free-text slots. `decisions_available` tells the renderer which of
  // the two it is looking at — a short feed and an unreadable one are different.
  const decisions_available = approvalDecisionRows !== null;
  const decisions = buildDecisionsFeed(groups.Decisions, approvalDecisionRows ?? []);

  // kag_seeker — non-fatal, but NOT `[]` on failure. The old comment here said
  // a degraded DB "returns [] so the Seeker sub-pane just shows the empty-state
  // line" — that empty state reads "no memory links", which is an answer. null
  // is the honest value; the renderer shows unknown.
  const loadSeeker =
    ((id: string) => loadSeekerLinksByCardId(id));
  // ⚠️ null on failure, not []: the seeker pane's empty state says "no memory
  // links", which is an answer, not an absence of one.
  let kag_seeker: SeekerLinkRow[] | null = null;
  try {
    kag_seeker = await loadSeeker(cardId);
  } catch (e) {
    console.error('[GET /api/cards/:id] seeker_links lookup failed', e);
    reportSwallowedFailure(e, {
      service: 'fr-db',
      degradedTo: 'kag_seeker=null (unknown, NOT "no memory links")',
    });
    kag_seeker = null;
  }

  // open_approvals — non-fatal: the pending-approval gate is read-only,
  // so a degraded DB just hides it.
  const loadOpen =
    ((id: string, t: string) => loadOpenApprovalsByCardId(id, t));
  //
  // ⚠️ On failure this is `null`, NOT `[]` — same rule as `phase_journey` below,
  // and here the cost of getting it wrong is spelled out in the UI. With `[]`,
  // `frontend/src/lib/cards/sections/BlockedGateSection.svelte` prints, for a
  // card sitting on a BLOCKED list:
  //   "This card is on a BLOCKED list but has no recorded open approval.
  //    It may be waiting on a dependency or a manual gate."
  // That is an AFFIRMATIVE claim about the card, produced by a DB read that
  // simply failed. "We could not read its approvals" and "it has none" are
  // different statements and must not share a representation.
  let open_approvals: OpenApprovalRow[] | null = null;
  try {
    open_approvals = await loadOpen(cardId, callerTenant);
  } catch (e) {
    console.error('[GET /api/cards/:id] open-approvals lookup failed', e);
    reportSwallowedFailure(e, {
      service: 'fr-db',
      degradedTo: 'open_approvals=null (unknown, NOT "no open approvals")',
    });
    open_approvals = null;
  }

  // phase_journey — non-fatal: the Planka action log is best-effort, and one
  // unreadable journey must not fail a card detail that is otherwise complete.
  // fr never asks n8n for this — it reconstructs the journey from Planka's own
  // list-move actions.
  //
  // On failure this is `null`, NOT `[]`. Every card that exists has at least a
  // `createCard` action, so an empty journey is not a state Planka can report;
  // returning `[]` claimed "this card has no history", which is a different and
  // false statement from "we could not read its history". Renderers must show
  // null as unknown rather than as an empty timeline.
  //
  // ⭐ `phase_journey_complete` / `phase_journey_oldest_at` say HOW MUCH of the
  // history the journey covers. Planka pages the log (50 per page, newest first),
  // so a long-lived card's early moves sit beyond page 1. A consumer asking "did
  // this card leave BLOCKED after T" (ncn's approved-signoff callback) may read the
  // journey as covering T only when `phase_journey_complete` is true or
  // `phase_journey_oldest_at <= T`; otherwise the answer is UNKNOWN and it must
  // fail closed. Up to CARD_GET_ACTION_HISTORY_MAX_PAGES reads, and the 2nd+ only
  // when the previous page was full.
  const loadActionsPage =
    ((id: string, beforeId?: string) => loadCardActionsViaPlanka(planka, id, beforeId));
  let phase_journey: PhaseTransitionRow[] | null = null;
  let phase_journey_complete = false;
  let phase_journey_oldest_at: string | null = null;
  try {
    const history = await readCardActionHistory((beforeId) => loadActionsPage(cardId, beforeId), {
      maxPages: CARD_GET_ACTION_HISTORY_MAX_PAGES,
    });
    phase_journey = buildPhaseJourney(history.actions);
    phase_journey_complete = history.complete;
    phase_journey_oldest_at = history.oldest_at;
  } catch (e) {
    console.error('[GET /api/cards/:id] card-actions lookup failed', e);
    phase_journey = null;
    phase_journey_complete = false;
    phase_journey_oldest_at = null;
  }

  // version_stamp (C1-46, migration 140) — the FULL stamp behind the card's
  // `Metadata.version_stamp` pointer, read from fr's `card_version_stamps`.
  // `null` when the card has none. Non-fatal like the reads above, but a failed
  // read is NOT reported as "no stamp": `version_stamp_available` is false then,
  // so "unstamped" and "could not read" stay distinguishable.
  const loadStamp =
    ((id: string) => loadVersionStamp(id));
  let version_stamp: VersionStamp | null = null;
  let version_stamp_available = true;
  try {
    version_stamp = await loadStamp(cardId);
  } catch (e) {
    console.error('[GET /api/cards/:id] version_stamp lookup failed', e);
    reportSwallowedFailure(e, {
      service: 'fr-db',
      degradedTo: 'version_stamp=null with version_stamp_available=false (unknown, NOT "unstamped")',
    });
    version_stamp = null;
    version_stamp_available = false;
  }

  // scenario_evidence (fr#1338, migration 154) — the bug-path repro evidence
  // POST /api/cards/project kept OUT of Planka: one row per gherkin_scenarios
  // entry that carried `test_file_content`, the FULL entry as written (the
  // card's description holds the same entry minus `test_file_content`, with
  // `test_file_sha256` as the pointer). `[]` = none stored. A failed read is
  // `null` + `scenario_evidence_available: false` — never `[]`, which would
  // read as "this card has no repro file".
  const loadEvidence =
    ((id: string) => loadScenarioEvidence(id));
  let scenario_evidence: StoredScenarioEvidence[] | null = null;
  let scenario_evidence_available = true;
  try {
    scenario_evidence = await loadEvidence(cardId);
  } catch (e) {
    console.error('[GET /api/cards/:id] scenario_evidence lookup failed', e);
    reportSwallowedFailure(e, {
      service: 'fr-db',
      degradedTo: 'scenario_evidence=null with scenario_evidence_available=false (unknown, NOT "none")',
    });
    scenario_evidence = null;
    scenario_evidence_available = false;
  }

  const related_titles = await relatedTitlesP;

  return jsonResponse({
    id: card.item.id,
    name: card.item.name,
    description: card.item.description,
    list_id: card.item.listId,
    list_name,
    board_id: card.item.boardId,
    // Omitted (undefined) when the lookup failed — see above.
    fr_project_id,
    type: card.item.type ?? null,
    position: card.item.position ?? null,
    due_date: card.item.dueDate ?? null,
    is_closed: card.item.isClosed ?? false,
    created_at: card.item.createdAt ?? null,
    updated_at: card.item.updatedAt ?? null,
    tenant,
    is_system,
    tenant_is_platform,
    groups,
    tasks,
    decisions,
    // ⚠️ `decisions` is always an array (the Planka slots are always readable),
    // so it alone cannot say the approvals half failed. This flag is the only
    // way a renderer can tell a SHORT feed from an UNREADABLE one.
    decisions_available,
    // null ⇒ the read failed. `[]` would assert "no memory links" / "no open
    // approvals", which is an answer we do not have.
    kag_seeker,
    open_approvals,
    phase_journey,
    phase_journey_complete,
    phase_journey_oldest_at,
    version_stamp,
    version_stamp_available,
    scenario_evidence,
    scenario_evidence_available,
    // id → title for related/parent/child cards (≤ RELATED_TITLES_MAX, tenant-
    // gated, best-effort). An id absent here ⇒ unknown title, not "no card".
    related_titles,
  });
}

/**
 * Reduce a card's Planka action log into an ordered phase journey. Only
 * list-affecting actions (createCard / moveCard) contribute; each becomes
 * a transition annotated with the AA phase its lists map to. Ordered
 * oldest-first by `createdAt`. The frontend collapses consecutive
 * same-phase transitions into phase bands.
 *
 * A step INTO a BLOCKED list also carries its own `block_reason`: the LATEST
 * `updateCustomFieldValue` action on the `block_reason` field (planka-private#20)
 * whose createdAt is in [step.at − BLOCK_REASON_LEAD_MS, nextStep.at) — open end
 * for the last step. The lead is because the conveyor PATCHes the move before the
 * field. No such action ⇒ the keys are absent; nothing is inferred.
 */
// Exported so workers/deblock-callback-redelivery.ts derives "did this card leave
// BLOCKED since the approval" from the SAME journey this route serves — one
// reducer, not two that can disagree about one card.
export function buildPhaseJourney(actions: RawCardAction[]): PhaseTransitionRow[] {
  const relevant = actions.filter(
    (a) => a.type === 'createCard' || a.type === 'moveCard',
  );
  relevant.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  const reasons = actions
    .filter(
      (a) =>
        a.type === 'updateCustomFieldValue' &&
        a.data?.customFieldName === 'block_reason' &&
        typeof a.data?.content === 'string' &&
        a.data.content.trim() !== '' &&
        !Number.isNaN(Date.parse(a.createdAt ?? '')),
    )
    .map((a) => ({ content: a.data!.content as string, at: a.createdAt as string, ms: Date.parse(a.createdAt!) }));
  return relevant.map((a, i) => {
    const fromList = a.type === 'moveCard' ? (a.data?.fromList?.name ?? null) : null;
    const toList =
      a.type === 'moveCard'
        ? (a.data?.toList?.name ?? null)
        : (a.data?.list?.name ?? null);
    const row: PhaseTransitionRow = {
      action_id: a.id,
      type: a.type,
      from_list: fromList,
      to_list: toList,
      from_phase: phaseFromListName(fromList),
      to_phase: phaseFromListName(toList),
      at: a.createdAt ?? null,
    };
    const stepMs = Date.parse(a.createdAt ?? '');
    if (isBlocked(toList) && reasons.length > 0 && !Number.isNaN(stepMs)) {
      const nextMs = Date.parse(relevant[i + 1]?.createdAt ?? '');
      const end = Number.isNaN(nextMs) ? Number.POSITIVE_INFINITY : nextMs;
      let latest: (typeof reasons)[number] | null = null;
      for (const r of reasons) {
        if (r.ms >= stepMs - BLOCK_REASON_LEAD_MS && r.ms < end && (!latest || r.ms > latest.ms)) latest = r; // tie ⇒ first seen = newest (Planka serves id DESC)
      }
      if (latest) {
        row.block_reason = latest.content;
        row.block_reason_at = latest.at;
      }
    }
    return row;
  });
}

/** How far BEFORE a move into BLOCKED its `block_reason` write may land (clock skew / ordering slack). */
const BLOCK_REASON_LEAD_MS = 5_000;

/**
 * Merge Planka free-text decision slots (`decision_1..5`) and
 * approval-derived rows into a single chronological feed. Approval
 * rows are sorted by `decided_at` desc; planka rows have no timestamp
 * and append after — the Wave A UI renders them with a "(unscheduled)"
 * tag if it cares about ordering.
 */
function buildDecisionsFeed(
  plankaDecisions: Record<string, string>,
  approvalRows: ApprovalDecisionRow[],
): DecisionRow[] {
  const out: DecisionRow[] = [];
  for (const r of approvalRows) {
    out.push({
      source: 'approval',
      id: r.decision_id,
      approval_id: r.approval_id,
      approval_status: r.approval_status,
      approval_description: r.approval_description,
      approver_id: r.approver_id,
      outcome: r.decision,
      comment: r.comment,
      decided_at: r.decided_at,
      approval_created_at: r.approval_created_at ?? null,
      decided_by_kind: r.decided_by_kind ?? null,
    });
  }
  out.sort((a, b) => {
    if (a.source === 'approval' && b.source === 'approval') {
      return b.decided_at.localeCompare(a.decided_at);
    }
    return 0;
  });
  for (const [slot, text] of Object.entries(plankaDecisions)) {
    if (!text || !text.trim()) continue;
    out.push({ source: 'planka', id: slot, text });
  }
  return out;
}
