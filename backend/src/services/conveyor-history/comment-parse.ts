// src/services/conveyor-history/comment-parse.ts
//
// Pure readers over the conveyor's Planka card comments, for the project page's
// card timeline and its "Delivered" list (GET /api/projects/:id/conveyor-history).
//
// ⚠️ PROVENANCE: the comment shapes here are read from the conveyor flows that WRITE
// them (conveyor repo, workflows/ct.*.json + sub.card_action.json + sub.block_ask.json:
// `fenceJson(v) = '```json\n' + JSON.stringify(v, null, 2) + '\n```'`, a block carries
// `list` and a `kind` — handoff / signoff / question / rework / stall / unblock_proposal,
// or a measurement kind such as gap_values / qa_suite), NOT measured against live rows:
// the board could not be read when this was written. Everything is tolerant: a comment
// that matches no known shape renders as a plain comment, never as an error.
//
// fr is a facilitator: these functions only re-present what the conveyor wrote.

/** The kinds the conveyor flows write into a comment's JSON block. */
export const CONVEYOR_COMMENT_KINDS = [
  'handoff',
  'signoff',
  'question',
  'rework',
  'stall',
  'unblock_proposal',
] as const;
export type ConveyorCommentKind = (typeof CONVEYOR_COMMENT_KINDS)[number];

/**
 * `comment` = no JSON block (a person's or an agent's prose);
 * `record` = a block whose kind is not one of the known conveyor kinds
 * (a measurement block, or an agent's own JSON without a kind).
 */
export type CommentKind = ConveyorCommentKind | 'record' | 'comment';

export interface ParsedComment {
  kind: CommentKind;
  /** The list the block names (`DOING`, `QA`, …); null when no block names one. */
  list: string | null;
  /** The human text: the comment with every JSON fence removed and the prose tidied (tidyConveyorProse). May be ''. */
  text: string;
  /**
   * A one-line summary taken from the block when the human text is empty
   * (e.g. a rework block's `answer`); null when there is none.
   */
  summary: string | null;
  /** The first parseable JSON block, re-serialised (pretty) for a folded view; null when none. */
  data: string | null;
  /** Every parsed JSON object in the comment, in order (for PR/branch extraction). */
  blocks: Record<string, unknown>[];
}

const FENCE_RE = /```json\s*([\s\S]*?)```/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Block fields that hold readable prose, in the order they are preferred for a summary. */
const SUMMARY_KEYS = ['question', 'answer', 'proposal_text', 'reason', 'note', 'summary', 'comment'] as const;

function summaryOf(block: Record<string, unknown> | undefined): string | null {
  if (!block) return null;
  for (const k of SUMMARY_KEYS) {
    const v = block[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function parseConveyorComment(raw: string | null | undefined): ParsedComment {
  const source = typeof raw === 'string' ? raw : '';
  const blocks: Record<string, unknown>[] = [];
  let firstData: string | null = null;
  for (const m of source.matchAll(FENCE_RE)) {
    try {
      const j: unknown = JSON.parse(m[1] ?? '');
      if (isRecord(j)) {
        blocks.push(j);
        if (firstData === null) firstData = JSON.stringify(j, null, 2);
      }
    } catch {
      // An unparseable fence is left out of `blocks`; its text still leaves the prose below.
    }
  }
  // An unterminated fence (a truncated comment) is folded too: its tail is data, not prose.
  let text = source.replace(FENCE_RE, '');
  const open = text.indexOf('```json');
  if (open >= 0) text = text.slice(0, open);
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  const first = blocks[0];
  const rawKind = first && typeof first.kind === 'string' ? first.kind : null;
  let kind: CommentKind;
  if (!first) kind = 'comment';
  else if (rawKind && (CONVEYOR_COMMENT_KINDS as readonly string[]).includes(rawKind)) kind = rawKind as ConveyorCommentKind;
  else kind = 'record';

  return {
    kind,
    list: first && typeof first.list === 'string' && first.list.trim() ? first.list.trim() : null,
    // The shown prose, internal ids and rule numbers dropped; `data` keeps the raw record.
    text: tidyConveyorProse(text),
    summary: text ? null : (summaryOf(first) === null ? null : tidyConveyorProse(summaryOf(first))),
    data: firstData,
    blocks,
  };
}

// ── Pull requests ───────────────────────────────────────────────────────────

export interface PullRequestRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

// owner: GitHub's [A-Za-z0-9-]; repo: [A-Za-z0-9._-]. The trailing guard stops `/pull/2` matching `/pull/23`.
const PR_URL_RE = /https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?![0-9])/g;

/** Every GitHub pull-request URL in `text`, de-duplicated, in first-seen order. */
export function extractPullRequestUrls(text: string | null | undefined): PullRequestRef[] {
  const out: PullRequestRef[] = [];
  const seen = new Set<string>();
  for (const m of String(text ?? '').matchAll(PR_URL_RE)) {
    const owner = m[1]!;
    const repo = m[2]!.replace(/\.git$/, '');
    const number = Number(m[3]);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const key = prKey(owner, repo, number);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: `https://github.com/${owner}/${repo}/pull/${number}`, owner, repo, number });
  }
  return out;
}

export function prKey(owner: string, repo: string, number: number): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

const BRANCH_KEYS = ['branch', 'head_branch', 'branch_name', 'work_branch'] as const;
const HEAD_SHA_KEYS = ['head_sha', 'commit_sha'] as const;

function firstString(blocks: Record<string, unknown>[], keys: readonly string[]): string | null {
  // The LATEST block wins: a later hand-off restates the value the card ended with.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    for (const k of keys) {
      const v = b[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/** The branch a card's blocks name (latest wins); null when none does. */
export function branchFromBlocks(blocks: Record<string, unknown>[]): string | null {
  return firstString(blocks, BRANCH_KEYS);
}

/** The head commit a card's blocks name (latest wins); null when none does. */
export function headShaFromBlocks(blocks: Record<string, unknown>[]): string | null {
  const v = firstString(blocks, HEAD_SHA_KEYS);
  return v && /^[0-9a-f]{7,40}$/i.test(v) ? v : null;
}

// ── Prose tidying ───────────────────────────────────────────────────────────

const UUID_RE = /\s*\(?\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b\)?/gi;
// A Planka snowflake standing as its own word (never inside a branch name like conveyor/1893…).
const SNOWFLAKE_RE = /(^|[\s(])\d{16,20}(?=[\s).,;:]|$)/g;
// Rule references the conveyor cites for itself: "(R300)", "per R300", ", R195", "R213:".
const RULE_PAREN_RE = /\s*\((?:[^()]*?,\s*)?R\d{2,4}\)/g;
const RULE_REF_RE = /\s*(?:\bper\s+|,\s*)?\bR\d{2,4}\b:?/g;

/**
 * The conveyor's prose cites internal ids (artifact / approval uuids, card snowflakes) and its own
 * rule numbers. Neither means anything to the reader, so the shown text drops them; the raw record
 * stays available, unaltered, in the folded details. Measured on board 1893477746286265428: 82
 * comments, 4 rule references and 28 raw ids in the prose.
 */
export function tidyConveyorProse(text: string | null | undefined): string {
  let s = String(text ?? '');
  s = s.replace(RULE_PAREN_RE, '').replace(RULE_REF_RE, '');
  s = s.replace(UUID_RE, '').replace(SNOWFLAKE_RE, '$1');
  return s
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .trim();
}
