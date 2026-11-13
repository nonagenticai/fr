// Pure helpers used by the artifacts page. Extracted so they can be unit-tested
// without spinning up a Svelte component / DOM.

export type PreviewKey = 'image' | 'json' | 'csv' | 'markdown' | null;

/** Inline preview MIME → component family. PDF / Office / ZIP / unknown → null. */
export function pickPreviewKey(mime: string | undefined | null): PreviewKey {
  if (!mime) return null;
  if (mime === 'image/svg+xml' || mime.startsWith('image/')) return 'image';
  if (mime === 'application/json') return 'json';
  if (mime === 'text/csv') return 'csv';
  if (
    mime === 'text/markdown' ||
    mime === 'text/html' ||
    mime === 'text/plain' ||
    mime === 'application/xml'
  ) {
    return 'markdown';
  }
  return null;
}

/** Lightweight CSV parser used by CsvPreview. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Format a byte count like "123 B" / "1.2 KiB" / "3.4 MiB". */
export function fmtSize(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
