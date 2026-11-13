// Pure readers over a card's `groups['Runtime State']` (GET /api/cards/:id).
//
// Runtime State is the execution-time group the conveyor's n8n handlers fill
// (backend services/improvement-cards/field-groups.ts). Two things in it are
// what a user watching the conveyor needs to SEE: the PR it opened for the card
// (pr_url / pr_number / pr_repo_owner / pr_repo_name) and why the card is
// blocked or which exit it took (block_reason).

import { safePrUrl } from '$lib/components/verification/logic';

export type ParsedBlockReason =
  | { kind: 'reason' | 'wait'; cls: string; exit: string; detail: string }
  | { kind: 'unstructured'; raw: string };

// ⛔ The `<class>:<exit>:<detail>` format is OWNED by ncn
// (scripts/lib/block-reason.mjs); its class and exit vocabularies are closed
// lists generated there. fr only DISPLAYS the value — it never re-validates the
// vocabulary, so a new class/exit added in ncn renders without an fr change.
// Only the FIRST TWO ':' split: the detail routinely carries ':' itself
// (URLs, `path:line`), and splitting on every ':' would truncate it.
const STRUCTURED = /^([a-z][a-z0-9_]*):([a-z][a-z0-9_]*):([\s\S]*)$/;

/** null for a non-string or blank value; anything that is not the structured
 *  format (legacy free text) comes back verbatim as `unstructured`. */
export function parseBlockReason(raw: unknown): ParsedBlockReason | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const m = STRUCTURED.exec(raw);
  if (!m) return { kind: 'unstructured', raw };
  const [, cls, exit, detail] = m;
  return { kind: cls === 'parked' ? 'wait' : 'reason', cls, exit, detail };
}

function str(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** null when the card has no pr_url. `href` is set ONLY for a safe https
 *  github.com PR URL; anything else is shown as text, never as a link. */
export function prLink(
  rs: Record<string, unknown> | undefined | null,
): { href: string | null; label: string } | null {
  const url = str(rs?.pr_url);
  if (url === null) return null;
  const href = safePrUrl(url);
  const num = str(rs?.pr_number);
  const owner = str(rs?.pr_repo_owner);
  const repo = str(rs?.pr_repo_name);
  const label = num && owner && repo ? `#${num} ${owner}/${repo}` : url;
  return { href, label };
}
