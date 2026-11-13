// reader.ts — the document reader's pure helpers (R3 / DOC-3, FR-PROJECT-HOME-REDESIGN §7.1).
//
// ⛔ SECOND SANITISATION PASS. artifact_service already sanitises the rendered HTML (allowlist;
// http/https/mailto only), and fr does NOT trust that blindly: everything inserted with {@html}
// goes through `sanitizeDocumentHtml` first, in the browser, with DOMPurify. The pass keeps prose
// markup only — no script, style, form, frame, embed or SVG; no inline style or event handler; links
// only http(s) / mailto / in-page; images only inline data: images. It also takes the upstream
// page's own title and table of contents out (the reader shows its own) and namespaces every id
// (`doc-…`) so a document can never collide with — or clobber — an id of the app around it.
import DOMPurify from 'dompurify';

import type { ProjectOutputs, TrailDocument, TrailStatus, TrailVersion } from '$lib/types/outputs';

export interface TocEntry {
  level: 2 | 3;
  id: string;
  text: string;
}

export interface SanitizedDocument {
  html: string;
  toc: TocEntry[];
}

const FORBID_TAGS = [
  'script', 'style', 'link', 'meta', 'base', 'title', 'form', 'input', 'button', 'textarea', 'select', 'option',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'template', 'noscript', 'video', 'audio', 'source',
];
const FORBID_ATTR = ['style', 'srcset', 'formaction', 'action', 'background', 'ping'];
const SAFE_URI = /^(?:https?:|mailto:|#)/i;
const SAFE_IMG = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i;
const ID_PREFIX = 'doc-';

function slug(text: string, used: Set<string>): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
  let s = base;
  for (let n = 2; used.has(s); n += 1) s = `${base}-${n}`;
  used.add(s);
  return s;
}

/** Sanitise the upstream-rendered HTML and collect its table of contents. Browser (DOM) only. */
export function sanitizeDocumentHtml(raw: string): SanitizedDocument {
  const frag = DOMPurify.sanitize(raw, {
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP: SAFE_URI,
    ALLOW_DATA_ATTR: false,
    WHOLE_DOCUMENT: false,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;

  // The reader shows its own title and contents: drop the page's.
  frag.querySelectorAll('nav.toc').forEach((n) => n.remove());
  frag.querySelector('h1')?.remove();

  // Images: inline data images only (the renderer never references a remote resource).
  frag.querySelectorAll('img').forEach((img) => {
    if (!SAFE_IMG.test(img.getAttribute('src') ?? '')) img.remove();
  });

  // Namespace ids and the in-page links that point at them.
  const used = new Set<string>();
  frag.querySelectorAll('[id]').forEach((el) => {
    const id = el.getAttribute('id') ?? '';
    used.add(id);
    el.setAttribute('id', `${ID_PREFIX}${id}`);
  });
  frag.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      a.setAttribute('href', `#${ID_PREFIX}${href.slice(1)}`);
    } else if (SAFE_URI.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer nofollow');
    } else {
      a.removeAttribute('href');
    }
  });

  const toc: TocEntry[] = [];
  frag.querySelectorAll('h2, h3').forEach((h) => {
    const text = (h.textContent ?? '').trim();
    if (!text) return;
    if (!h.getAttribute('id')) h.setAttribute('id', `${ID_PREFIX}${slug(text, used)}`);
    toc.push({ level: h.tagName === 'H2' ? 2 : 3, id: h.getAttribute('id')!, text });
  });

  const box = document.createElement('div');
  box.appendChild(frag);
  return { html: box.innerHTML, toc };
}

// ── Words ──

// ⭐ TWO INDEPENDENT FIELDS, ONE STATUS. artifact_service keeps them apart on purpose
// (alembic 20260927_0001): `publish_status` (draft | published) is whether the producer RELEASED
// the version; `status` (pending | approved | rejected | needs_revision, default pending) is the
// last human REVIEW decision on it. A released version nobody has reviewed yet is therefore
// "Published · review pending" — not "released" in one place and "waiting for a review" in
// another. Every surface (Outputs badge, reader banner, version switcher) says it with these.

const REVIEW_WORD: Record<string, string> = {
  pending: 'review pending',
  needs_revision: 'changes requested',
  approved: 'approved',
  rejected: 'rejected',
};

/** The review states in which a review can still be recorded (the trail's REVIEW_OPEN). */
const REVIEW_OPEN = new Set(['pending', 'needs_revision']);

/** True when a review is really open on this version: an open review state on a running project. */
export function reviewOpen(v: Pick<TrailVersion, 'review_status'>, finished: boolean): boolean {
  return !finished && v.review_status !== null && REVIEW_OPEN.has(v.review_status);
}

/** The review half of the status; a finished project's unreviewed version says nothing (no review will come). */
export function reviewWord(reviewStatus: string | null, finished: boolean): string | null {
  if (!reviewStatus) return null;
  if (finished && reviewStatus === 'pending') return null;
  return REVIEW_WORD[reviewStatus] ?? null;
}

/** The release half: `in_review` is a draft with changes requested (the review half says so). */
function publishWord(s: TrailStatus | null): string | null {
  if (s === 'published') return 'Published';
  if (s === 'draft' || s === 'in_review') return 'Draft';
  return null;
}

/** ONE status, both fields: "Published · review pending", "Draft · changes requested", "Published". */
export function statusLine(v: Pick<TrailVersion, 'status' | 'review_status'>, finished: boolean): string | null {
  const parts = [publishWord(v.status), reviewWord(v.review_status, finished)].filter((x): x is string => !!x);
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The reader's status banner: the status line, then what it means, in one sentence. */
export function statusBanner(v: Pick<TrailVersion, 'status' | 'review_status'>, finished: boolean): string {
  const line = statusLine(v, finished) ?? 'Status unknown';
  const open = reviewOpen(v, finished);
  const changes = v.review_status === 'needs_revision';
  let meaning: string;
  if (v.status === 'published') {
    meaning = changes
      ? 'this version is released; changes were requested on it.'
      : open
        ? 'this version is released and nobody has reviewed it yet.'
        : 'this version is released.';
  } else if (finished) {
    meaning = 'this project has finished; this version was never published.';
  } else {
    meaning = changes ? 'not published; changes were requested on this version.' : 'not published yet.';
  }
  return `${line} — ${meaning}`;
}

/** The reader's route for one of the project's documents. */
export function documentHref(projectId: string, artifactId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(artifactId)}`;
}

export interface FoundDocument {
  doc: TrailDocument;
  version: TrailVersion;
}

/**
 * The document and version an artifact id opens: a version's reading artifact, or its reviewed one
 * (a `.json` whose `.md` companion is read instead). null = not in this project's trail.
 */
export function findDocument(outputs: ProjectOutputs, artifactId: string): FoundDocument | null {
  if (!outputs.available) return null;
  const all: TrailDocument[] = [
    ...(outputs.final_report ? [outputs.final_report] : []),
    ...outputs.phases.flatMap((p) => p.documents),
    ...outputs.unassigned.documents,
  ];
  for (const doc of all) {
    const version = doc.versions.find((v) => v.artifact_id === artifactId || v.review_artifact_id === artifactId);
    if (version) return { doc, version };
  }
  return null;
}
