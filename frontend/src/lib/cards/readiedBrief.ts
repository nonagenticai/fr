// Band ① — parse the `readied_brief` that READY materialises into the
// card description. Per AA_IMPLEMENTATION/READYING_REDESIGN §2.2 + §2.5 the
// brief is persisted as an idempotent fenced ` ```json readied_brief `
// block in the card description (not a custom field — no fleet-wide
// provisioning needed). DOING reads it as its context source; this parser
// lets the card page render the same carry.
//
// The shape is LLM-authored, so every field is optional and the parser is
// tolerant: a card with no brief (pre-READY), a malformed block, or a block
// that isn't an object all return null and the section shows its
// empty-state. This is pure logic — unit-tested in readiedBrief.test.ts.

export interface BriefAssetRef {
  id?: string;
  title?: string;
}

export interface BriefDecisionRef {
  id?: string;
  summary?: string;
}

export interface BriefSplitRecommendation {
  needed?: boolean;
  rationale?: string;
  proposed_children?: Array<{
    title?: string;
    scope?: string;
    requires?: string[];
  }>;
}

export interface BriefProvenance {
  seeker_counts?: Record<string, unknown>;
  sparse_dimensions?: string[];
  assets_authored?: string[];
}

export interface ReadiedBrief {
  objective?: string;
  context?: string;
  principles_applied?: BriefAssetRef[];
  requirements_in_scope?: BriefAssetRef[];
  decisions?: BriefDecisionRef[];
  acceptance_criteria?: string[];
  key_context?: string;
  open_questions?: string[];
  split_recommendation?: BriefSplitRecommendation | null;
  approval_ref?: string | null;
  provenance?: BriefProvenance;
}

// Match a fenced code block whose info string mentions `readied_brief`
// (e.g. ```json readied_brief). Captures the block body up to the next
// closing fence. `[^\n]*` keeps the match on the single opening line so a
// stray "readied_brief" word inside prose can't widen the capture.
const LABELLED_FENCE = /```[^\n]*readied_brief[^\n]*\n([\s\S]*?)```/;

// The READY writer wraps the brief in HTML-comment sentinels
// (`<!-- aa:readied_brief:start --> … <!-- aa:readied_brief:end -->`) around
// the fenced block. Strip the WHOLE sentinel region — otherwise removing only
// the inner fence (LABELLED_FENCE) leaks the empty `start`/`end` markers into
// the rendered Description. Non-greedy so back-to-back briefs don't merge.
const SENTINEL_BLOCK =
  /<!--\s*aa:readied_brief:start\s*-->[\s\S]*?<!--\s*aa:readied_brief:end\s*-->/g;

// UI review 2026-10-07: the conveyor writes OTHER sentinels into the
// description too (`<!-- aa:doing_output -->` … `<!-- /aa:doing_output -->`),
// and only the readied_brief pair was stripped, so the raw markers leaked into
// the rendered Description. Strip every `aa:` comment MARKER (any name, opening
// or closing form) — the prose between a non-brief pair is the user-facing
// content and stays.
const AA_MARKER = /<!--\s*\/?aa:[\w-]+.*?-->/g;

/**
 * Extract and parse the readied_brief block from a card description.
 * Returns null when the description is empty, has no such block, or the
 * block does not parse into a JSON object.
 */
export function parseReadiedBrief(
  description: string | null | undefined,
): ReadiedBrief | null {
  if (!description) return null;

  const match = LABELLED_FENCE.exec(description);
  if (!match) return null;

  const raw = match[1]?.trim();
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as ReadiedBrief;
}

/**
 * Remove the readied_brief fenced block from a description, leaving the
 * human prose. The card page renders the structured brief in band ①, so the
 * raw Description should not also dump the JSON. Returns the trimmed
 * remainder (or '' when nothing is left).
 */
export function stripReadiedBrief(
  description: string | null | undefined,
): string {
  if (!description) return '';
  return description
    .replace(SENTINEL_BLOCK, '')
    .replace(LABELLED_FENCE, '')
    .replace(AA_MARKER, '')
    .trim();
}

export interface DescriptionSegment {
  type: 'text' | 'code';
  /** Info string of a fenced block (e.g. `json`), when present. */
  lang?: string;
  content: string;
}

// Split a (readied-brief-stripped) description into prose + fenced-code
// segments so the card view renders ```json/```… blocks as monospace,
// horizontally-scrollable code instead of a wrapped, unreadable wall of text
// (the AA intake card's Description is a fenced project_start_request JSON).
// Tolerant: an unterminated fence is treated as code to the end.
const CODE_FENCE = /```([^\n`]*)\n?([\s\S]*?)```/g;

export function descriptionSegments(
  prose: string | null | undefined,
): DescriptionSegment[] {
  if (!prose) return [];
  const segments: DescriptionSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CODE_FENCE.lastIndex = 0;
  while ((m = CODE_FENCE.exec(prose)) !== null) {
    const before = prose.slice(last, m.index).trim();
    if (before) segments.push({ type: 'text', content: before });
    segments.push({
      type: 'code',
      lang: (m[1] ?? '').trim() || undefined,
      content: (m[2] ?? '').replace(/\n+$/, ''),
    });
    last = CODE_FENCE.lastIndex;
  }
  const tail = prose.slice(last).trim();
  if (tail) segments.push({ type: 'text', content: tail });
  return segments;
}

/**
 * Does the brief carry any renderable content? Used to decide between the
 * brief view and the empty-state. A parsed-but-empty `{}` counts as absent.
 */
export function hasBriefContent(brief: ReadiedBrief | null): boolean {
  if (!brief) return false;
  return Object.values(brief).some((v) => {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.trim().length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  });
}
