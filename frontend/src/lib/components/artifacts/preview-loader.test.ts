import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  pickPreviewKey,
  parseCsv,
  fmtSize,
} from './preview-loader';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('pickPreviewKey', () => {
  it('routes inline-supported MIMEs', () => {
    expect(pickPreviewKey('image/png')).toBe('image');
    expect(pickPreviewKey('image/jpeg')).toBe('image');
    expect(pickPreviewKey('image/svg+xml')).toBe('image');
    expect(pickPreviewKey('application/json')).toBe('json');
    expect(pickPreviewKey('text/csv')).toBe('csv');
    expect(pickPreviewKey('text/markdown')).toBe('markdown');
    expect(pickPreviewKey('text/html')).toBe('markdown');
    expect(pickPreviewKey('text/plain')).toBe('markdown');
    expect(pickPreviewKey('application/xml')).toBe('markdown');
  });

  it('returns null for download-only MIMEs (PDF, Office, ZIP, gzip, unknown)', () => {
    expect(pickPreviewKey('application/pdf')).toBeNull();
    expect(pickPreviewKey('application/zip')).toBeNull();
    expect(pickPreviewKey('application/gzip')).toBeNull();
    expect(pickPreviewKey('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBeNull();
    expect(pickPreviewKey('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBeNull();
    expect(pickPreviewKey('application/octet-stream')).toBeNull();
    expect(pickPreviewKey('')).toBeNull();
    expect(pickPreviewKey(undefined)).toBeNull();
    expect(pickPreviewKey(null)).toBeNull();
  });
});

describe('parseCsv', () => {
  it('parses a simple grid', () => {
    expect(parseCsv('a,b,c\n1,2,3\n4,5,6\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('handles quoted fields with commas, quotes, and newlines', () => {
    expect(parseCsv('"a,b","he said ""hi""","line1\nline2"\n')).toEqual([
      ['a,b', 'he said "hi"', 'line1\nline2'],
    ]);
  });

  it('tolerates a missing trailing newline', () => {
    expect(parseCsv('x,y\n1,2')).toEqual([
      ['x', 'y'],
      ['1', '2'],
    ]);
  });

  it('strips bare CRs', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('fmtSize', () => {
  it('formats across magnitudes', () => {
    expect(fmtSize(undefined)).toBe('—');
    expect(fmtSize(null)).toBe('—');
    expect(fmtSize(0)).toBe('0 B');
    expect(fmtSize(512)).toBe('512 B');
    expect(fmtSize(2048)).toBe('2.0 KiB');
    expect(fmtSize(5 * 1024 * 1024)).toBe('5.0 MiB');
    expect(fmtSize(3 * 1024 * 1024 * 1024)).toBe('3.00 GiB');
  });
});

// ---------------------------------------------------------------------------
// Source-level smoke tests for security-critical attributes that aren't
// expressible in the pure-helpers above. We assert on the actual file bytes
// so a regression that drops `sandbox=""` or adds `allow-scripts` fails CI.
// ---------------------------------------------------------------------------

function readSibling(name: string): string {
  return readFileSync(resolve(__dirname, name), 'utf8');
}

describe('ImagePreview source contract', () => {
  const src = readSibling('ImagePreview.svelte');

  it('renders SVG inside an iframe', () => {
    expect(src).toMatch(/<iframe/);
  });

  it('uses an empty sandbox attribute (no allow-scripts, no allow-same-origin)', () => {
    expect(src).toMatch(/sandbox=""/);
    expect(src).not.toMatch(/sandbox=["'][^"']*allow-scripts/);
    expect(src).not.toMatch(/sandbox=["'][^"']*allow-same-origin/);
  });

  it('has a non-iframe path for raster MIMEs', () => {
    expect(src).toMatch(/<img\b/);
  });
});

describe('MarkdownPreview source contract', () => {
  const src = readSibling('MarkdownPreview.svelte');

  it('only injects HTML when the upstream MIME is html-shaped and in the browser', () => {
    expect(src).toMatch(/isHtml/);
    expect(src).toMatch(/isHtml && browser/);
  });

  it('sanitizes the html branch with DOMPurify (backend does not sanitize)', () => {
    expect(src).toMatch(/import DOMPurify from 'dompurify'/);
    expect(src).toMatch(/DOMPurify\.sanitize\(body\)/);
    expect(src).toMatch(/\{@html safeHtml\}/);
    // The raw, unsanitized sink must be gone.
    expect(src).not.toMatch(/\{@html body\}/);
  });

  it('falls back to escaped <pre> for non-html bodies', () => {
    expect(src).toMatch(/<pre[^>]*>\{body\}<\/pre>/);
  });
});

describe('JsonPreview source contract', () => {
  const src = readSibling('JsonPreview.svelte');

  it('parses and pretty-prints JSON', () => {
    expect(src).toMatch(/JSON\.parse\(body\)/);
    expect(src).toMatch(/JSON\.stringify\(parsed, null, 2\)/);
  });

  it('surfaces a parse-error banner instead of crashing', () => {
    expect(src).toMatch(/parseError/);
  });
});

describe('CsvPreview source contract', () => {
  const src = readSibling('CsvPreview.svelte');

  it('uses @tanstack/svelte-virtual for virtualization', () => {
    expect(src).toMatch(/from '@tanstack\/svelte-virtual'/);
    expect(src).toMatch(/createVirtualizer/);
  });

  it('imports the shared parser instead of duplicating it', () => {
    expect(src).toMatch(/import \{ parseCsv \} from '\.\/preview-loader'/);
  });
});

// The "Artifacts page source contract" describe block that previously
// lived here asserted shape against the old browse/download surface at
// /library/artifacts. PR #287 replaced that page with the review
// surface — filter-bar/results-table/detail-pane and the dynamic
// preview imports no longer exist there. The preview components remain
// in src/lib/components/artifacts/ for re-use by a future surface; the
// parser + virtualization assertions above stay valid.
