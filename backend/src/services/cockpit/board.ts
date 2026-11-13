// src/services/cockpit/board.ts
//
// R5 of FR-PROJECT-HOME-REDESIGN-2026-10-26 (§3 Board, cockpit C4): the project's board as the
// owner reads it — the board's own columns in Planka order, every card with how long it has been in
// its column, a blocked card with its reason, and the card's EXACT phase so the page can filter the
// board by phase (§2b: one Planka board per project; the phase is a FILTER on the card's `phase`
// field, Closure = card type `project_closure`, never a time window).
//
// What counts as blocked (R-CK4, the same causes the status chip reads):
//   lane        the card sits in the BLOCKED lane            reason: its `block_reason` field
//   label       a block/gate/hold label                       reason: its `block_reason`, else the label
//   flow_failed a flow run of the card failed and no later    reason: "<flow> failed at <step>"
//               success of that flow superseded it
// A card held by an open approval is NOT blocked: it waits on a person, and the page says so
// ("Waiting for a decision") with the approval to open.
//
// Pure: the cockpit feeds it what it already read (the board, the spine's exact phases, the
// approvals, the unresolved flow failures). fr reports; it decides nothing from it.
import { isDoneEquivalentListName } from '../../lib/done-equivalent';
import type { Phase } from './project-cockpit';

/** The raw board detail as the cockpit reads it (custom-field bags passed through). */
export interface BoardIn {
  included?: {
    lists?: Array<{ id: string; name?: string | null; position?: number | null; type?: string | null }>;
    cards?: Array<{
      id: string;
      name?: string | null;
      listId: string;
      position?: number | null;
      listChangedAt?: string | null;
      updatedAt?: string | null;
      createdAt?: string | null;
      commentsTotal?: number | null;
    }>;
    labels?: Array<{ id: string; name?: string | null }>;
    cardLabels?: Array<{ cardId: string; labelId: string }>;
    customFields?: Array<{ id: string; name?: string | null }>;
    customFieldValues?: Array<{ cardId: string; customFieldId: string; content?: unknown }>;
  };
}

export type BoardBlockKind = 'lane' | 'label' | 'flow_failed';

export interface BoardColumn {
  id: string;
  name: string;
  /** fr's canonical mantra phase of the list (READYING / DOING / INSPECTING / PUBLISHING / BLOCKED / OTHER). */
  kind: Phase;
}

export interface BoardCard {
  id: string;
  name: string;
  list_id: string;
  list_name: string | null;
  kind: Phase;
  /** When the card entered its column (Planka `listChangedAt`, else the card's creation). */
  in_column_since: string | null;
  /** 'moved' = Planka recorded the move; 'created' = it has not moved since it was made. */
  in_column_basis: 'moved' | 'created' | null;
  /** Exact phase (spine): the card's `phase` field, or Closure for a `project_closure` card; null = not tied to a phase. */
  phase: string | null;
  placed_by: 'card_phase' | 'card_type' | null;
  card_type: string | null;
  blocked: boolean;
  block_kind: BoardBlockKind | null;
  /** What the conveyor wrote, or the failed step; null when a blocked card carries no reason. */
  block_reason: string | null;
  /** The open approval holding the card (a person must decide), when one is open. */
  waiting_on: { approval_id: string; description: string; created_at: string | null } | null;
  /** Planka's comment count; null when the board read did not carry it. */
  comment_count: number | null;
  done: boolean;
  position: number | null;
}

export interface ProjectBoard {
  board_id: string | null;
  columns: BoardColumn[];
  cards: BoardCard[];
  /** Cards with no exact phase ("not tied to a phase"). */
  unplaced: number;
}

export interface BoardApprovalIn {
  id: string;
  status: string;
  card_id: string | null;
  description: string;
  created_at: string | null;
}

export interface BoardFlowFailureIn {
  card_id: string | null;
  workflow_name: string | null;
  workflow_id: string | null;
  failed_node: string | null;
}

const BLOCK_LABEL = /block|gate|hold/i;
const HIDDEN_LIST_TYPES = new Set(['archive', 'trash']);

function failureReason(f: BoardFlowFailureIn): string {
  const flow = f.workflow_name ?? f.workflow_id ?? 'A flow';
  return f.failed_node ? `${flow} failed at step "${f.failed_node}"` : `${flow} failed`;
}

/**
 * The board read model. `normalize` is the cockpit's list-name → mantra-phase mapping (passed in so
 * the board and the rail can never disagree); `phases` is the spine's exact placement per card.
 */
export function composeBoard(input: {
  boardId: string | null;
  board: BoardIn;
  normalize: (listName: string | null | undefined) => Phase;
  phases: ReadonlyMap<string, { phase: string | null; placed_by: 'card_phase' | 'card_type' | null }>;
  approvals: readonly BoardApprovalIn[];
  flowFailures: readonly BoardFlowFailureIn[];
  /** Break-glass DONE cards: not done work. */
  humanOverrideCardIds?: ReadonlySet<string>;
}): ProjectBoard {
  const inc = input.board.included ?? {};
  const lists = (inc.lists ?? [])
    .filter((l) => !HIDDEN_LIST_TYPES.has((l.type ?? '').toLowerCase()))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const columns: BoardColumn[] = lists.map((l) => ({ id: l.id, name: l.name ?? '', kind: input.normalize(l.name) }));
  const listById = new Map(columns.map((c) => [c.id, c] as const));

  const fieldName = new Map<string, string>();
  for (const f of inc.customFields ?? []) if (f.name === 'block_reason' || f.name === 'card_type') fieldName.set(f.id, f.name);
  const reasonOf = new Map<string, string>();
  const typeOf = new Map<string, string>();
  for (const v of inc.customFieldValues ?? []) {
    const name = fieldName.get(v.customFieldId);
    const content = typeof v.content === 'string' ? v.content.trim() : '';
    if (!name || content === '') continue;
    if (name === 'block_reason') reasonOf.set(v.cardId, content);
    else typeOf.set(v.cardId, content);
  }
  const labelName = new Map((inc.labels ?? []).map((l) => [l.id, l.name ?? ''] as const));
  const blockLabelOf = new Map<string, string>();
  for (const cl of inc.cardLabels ?? []) {
    const n = labelName.get(cl.labelId) ?? '';
    if (BLOCK_LABEL.test(n) && !blockLabelOf.has(cl.cardId)) blockLabelOf.set(cl.cardId, n);
  }
  const waitingOn = new Map<string, BoardCard['waiting_on']>();
  for (const a of input.approvals) {
    if (a.status !== 'pending' || !a.card_id || waitingOn.has(a.card_id)) continue;
    waitingOn.set(a.card_id, { approval_id: a.id, description: a.description, created_at: a.created_at });
  }
  const failureOf = new Map<string, BoardFlowFailureIn>();
  for (const f of input.flowFailures) if (f.card_id && !failureOf.has(f.card_id)) failureOf.set(f.card_id, f);

  const cards: BoardCard[] = [];
  for (const c of inc.cards ?? []) {
    const col = listById.get(c.listId);
    if (!col) continue; // archived / trashed list, or a list the read did not carry
    const moved = c.listChangedAt ?? null;
    const since = moved ?? c.createdAt ?? null;
    const kind = col.kind === 'PUBLISHING' && input.humanOverrideCardIds?.has(c.id) ? 'OTHER' : col.kind;
    const placed = input.phases.get(c.id) ?? { phase: null, placed_by: null };
    const reason = reasonOf.get(c.id) ?? null;
    const label = blockLabelOf.get(c.id) ?? null;
    const failure = failureOf.get(c.id) ?? null;
    let block_kind: BoardBlockKind | null = null;
    let block_reason: string | null = null;
    if (kind === 'BLOCKED') {
      block_kind = 'lane';
      block_reason = reason;
    } else if (label) {
      block_kind = 'label';
      block_reason = reason ?? `Labelled "${label}"`;
    } else if (failure && kind !== 'PUBLISHING') {
      block_kind = 'flow_failed';
      block_reason = failureReason(failure);
    }
    cards.push({
      id: c.id,
      name: c.name ?? '',
      list_id: col.id,
      list_name: col.name || null,
      kind,
      in_column_since: since,
      in_column_basis: moved ? 'moved' : c.createdAt ? 'created' : null,
      phase: placed.phase,
      placed_by: placed.placed_by,
      card_type: typeOf.get(c.id) ?? null,
      blocked: block_kind !== null,
      block_kind,
      block_reason,
      waiting_on: waitingOn.get(c.id) ?? null,
      comment_count: typeof c.commentsTotal === 'number' && Number.isFinite(c.commentsTotal) ? c.commentsTotal : null,
      done: kind === 'PUBLISHING' && isDoneEquivalentListName(col.name),
      position: c.position ?? null,
    });
  }
  cards.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return { board_id: input.boardId, columns, cards, unplaced: cards.filter((c) => c.phase === null).length };
}
