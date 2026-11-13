// src/lib/projects/delivered-prs.ts
//
// UI review 2026-10-07: the project Artifacts page listed only MANUALLY bound
// artifacts, so a project whose cards had shipped a dozen pull requests read as
// having produced nothing. The approvals a card's DONE gate records carry
// `metadata.pr_url`; this turns a page of approved approvals into the distinct
// PRs, each with the first line of its approval's description.
//
// Pure. Only http(s) URLs become links — `metadata` is row data, not trusted
// markup. First occurrence of a URL wins (input order is the server's).

export interface DeliveredPr {
  url: string;
  /** First non-empty line of the approval description, or '' when none. */
  summary: string;
  approvalId: string;
}

interface ApprovalLike {
  id: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

const HTTP_URL = /^https?:\/\/\S+$/i;

export function firstLine(text: string | null | undefined): string {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

export function deliveredPrsFromApprovals(items: readonly ApprovalLike[]): DeliveredPr[] {
  const seen = new Set<string>();
  const out: DeliveredPr[] = [];
  for (const a of items) {
    const raw = a.metadata?.pr_url;
    if (typeof raw !== 'string') continue;
    const url = raw.trim();
    if (!HTTP_URL.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, summary: firstLine(a.description), approvalId: a.id });
  }
  return out;
}
