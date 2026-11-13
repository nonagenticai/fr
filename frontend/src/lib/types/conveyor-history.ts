// GET /api/projects/:id/conveyor-history — mirrors backend
// src/services/conveyor-history/history.ts (ConveyorHistory).
import type { Block } from './read-model';

export interface ConversationEntry {
  approval_id: string;
  ask_kind: 'question' | 'signoff' | 'request';
  status: string;
  question: string;
  context: string | null;
  decision: string | null;
  answer: string | null;
  decided_by: string | null;
  decided_at: string | null;
  asked_at: string | null;
  card_id: string | null;
  card_name: string | null;
  card_type: string | null;
  list: string | null;
  open: boolean;
}

export type CommentKind =
  | 'handoff'
  | 'signoff'
  | 'question'
  | 'rework'
  | 'stall'
  | 'unblock_proposal'
  | 'record'
  | 'comment';

export interface CardTimelineEntry {
  id: string;
  created_at: string | null;
  author: string;
  kind: CommentKind;
  list: string | null;
  text: string;
  summary: string | null;
  data: string | null;
}

export interface HistoryCard {
  id: string;
  name: string;
  list_name: string | null;
  card_type: string | null;
  last_moved_at: string | null;
  comment_count: number;
  comments_truncated: boolean;
  comments: CardTimelineEntry[] | null;
  comments_error: string | null;
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
  state: 'open' | 'closed' | 'merged' | null;
  title: string | null;
  state_unavailable: string | null;
}

export interface ConveyorHistory {
  conversation: Block<{ entries: ConversationEntry[] }>;
  cards: Block<{ cards: HistoryCard[] }>;
  delivered: Block<{ pull_requests: DeliveredPr[] }>;
}

/** The endpoint's `data`: a project with no RM link is explicitly not a conveyor project. */
export type ConveyorHistoryResponse =
  | ({ applicable: true } & ConveyorHistory)
  | { applicable: false; reason: 'not_a_conveyor_project'; message: string };
