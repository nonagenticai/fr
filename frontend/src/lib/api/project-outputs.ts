// project-outputs.ts (api) — R3 / DOC-3 (FR-PROJECT-HOME-REDESIGN-2026-10-26 §7.1):
//   GET /api/projects/:id/outputs                              the document trail
//   GET /api/projects/:id/documents/:artifactId/render?format=  the rendered document (html | pdf)
// A failed read THROWS: the caller renders "could not be read", never an empty trail.
import { authFetch } from './auth-fetch';
import type { ProjectOutputs } from '$lib/types/outputs';

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

export class DocumentReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DocumentReadError';
  }
}

export async function fetchProjectOutputs(projectId: string): Promise<ProjectOutputs> {
  const r = await authFetch(`${base(projectId)}/outputs`);
  if (r.status === 404) throw new DocumentReadError('This project was not found.', 404);
  if (!r.ok) throw new DocumentReadError(`The outputs could not be read (${r.status}).`, r.status);
  const body = (await r.json()) as { data?: ProjectOutputs };
  if (!body.data) throw new DocumentReadError('The outputs answer was empty.', 502);
  return body.data;
}

function renderUrl(projectId: string, artifactId: string, format: 'html' | 'pdf'): string {
  return `${base(projectId)}/documents/${encodeURIComponent(artifactId)}/render?format=${format}`;
}

const RENDER_FAIL: Record<number, string> = {
  404: 'This document was not found in this project.',
  413: 'This document is too large to show here.',
  415: 'This file is not a document that can be shown here.',
};

/** The rendered HTML, UNSANITISED — pass it through `sanitizeDocumentHtml` before inserting it. */
export async function fetchDocumentHtml(projectId: string, artifactId: string): Promise<string> {
  const r = await authFetch(renderUrl(projectId, artifactId, 'html'));
  if (!r.ok) throw new DocumentReadError(RENDER_FAIL[r.status] ?? `The document could not be read (${r.status}).`, r.status);
  return await r.text();
}

/** Fetch the PDF through the same proxy and hand it to the browser as a download. */
export async function downloadDocumentPdf(projectId: string, artifactId: string, title: string): Promise<void> {
  const r = await authFetch(renderUrl(projectId, artifactId, 'pdf'));
  if (!r.ok) throw new DocumentReadError(RENDER_FAIL[r.status] ?? `The PDF could not be made (${r.status}).`, r.status);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pdfName(title)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** A safe file name from a document title ("Final report: stock valuation" → "Final-report-stock-valuation"). */
export function pdfName(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return s || 'document';
}
