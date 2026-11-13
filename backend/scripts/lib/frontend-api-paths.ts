// backend/scripts/lib/frontend-api-paths.ts
//
// fr-agui SPEC §3.7 rule 4 — the HTTP paths the frontend calls, read STATICALLY
// from `frontend/src/lib/api/**` (non-test `.ts`), which includes
// `unified-client.ts`.
//
// A path is any string or template literal whose text starts with `/api/`,
// outside comments. A template `${…}` that fills a whole segment becomes a probe
// segment; one glued to the END of the path (`/api/x${qs}`) is a query suffix
// and is dropped; anything else is kept verbatim and will not resolve, landing in
// the guard's pinned unresolved set rather than being guessed at. The query
// string (`?…`) is dropped.
//
// ⚠️ A path built by concatenation (`'/api/' + kind`) is NOT seen. This is a
// floor on what the frontend calls, not a census of it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const FRONTEND_API_DIR = 'frontend/src/lib/api';

export interface FrontendApiCall {
  /** Repo-relative file. */
  file: string;
  /** The literal text as written (template `${…}` kept). */
  raw: string;
  /** A concrete probe path, or null when the literal cannot be turned into one. */
  probe: string | null;
}

/** Every string/template literal body in `src`, comments skipped. Template nesting is tracked. */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  const readQuoted = (q: string): string => {
    let s = '';
    i += 1;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') {
        s += src[i]! + (src[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (src[i] === '\n') break;
      s += src[i];
      i += 1;
    }
    i += 1;
    return s;
  };
  const readTemplate = (): string => {
    let s = '';
    i += 1;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        s += src[i]! + (src[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        let depth = 1;
        let expr = '';
        i += 2;
        while (i < n && depth > 0) {
          if (src[i] === '`') {
            expr += `\`${readTemplate()}\``;
            continue;
          }
          if (src[i] === '{') depth += 1;
          else if (src[i] === '}') depth -= 1;
          if (depth > 0) expr += src[i];
          i += 1;
        }
        s += `\${${expr}}`;
        continue;
      }
      s += src[i];
      i += 1;
    }
    i += 1;
    return s;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      out.push(readQuoted(c));
      continue;
    }
    if (c === '`') {
      out.push(readTemplate());
      continue;
    }
    i += 1;
  }
  return out;
}

/** Split a template body into literal text and balanced `${…}` chunks. */
export function templateParts(raw: string): Array<{ text: string; expr: boolean }> {
  const parts: Array<{ text: string; expr: boolean }> = [];
  let buf = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      if (buf) parts.push({ text: buf, expr: false });
      buf = '';
      let depth = 1;
      let j = i + 2;
      while (j < raw.length && depth > 0) {
        if (raw[j] === '{') depth += 1;
        else if (raw[j] === '}') depth -= 1;
        j += 1;
      }
      parts.push({ text: raw.slice(i, j), expr: true });
      i = j;
      continue;
    }
    buf += raw[i];
    i += 1;
  }
  if (buf) parts.push({ text: buf, expr: false });
  return parts;
}

/** `/api/projects/${id}/x?y=1` → `/api/projects/probe-x/x`; null when it cannot be made concrete. */
export function probeFor(raw: string): string | null {
  const parts = templateParts(raw);
  let out = '';
  for (let k = 0; k < parts.length; k += 1) {
    const p = parts[k]!;
    if (!p.expr) {
      const q = p.text.indexOf('?');
      if (q >= 0) {
        out += p.text.slice(0, q);
        break;
      }
      out += p.text;
      continue;
    }
    const last = k === parts.length - 1;
    const next = parts[k + 1];
    const nextIsSuffix = next !== undefined && next.expr && k + 1 === parts.length - 1;
    const wholeSegment =
      out.endsWith('/') && (last || nextIsSuffix || (next !== undefined && !next.expr && /^[/?]/.test(next.text)));
    if (wholeSegment) {
      out += 'probe-x';
      continue;
    }
    // A `${…}` glued to the END of the path is a query/suffix builder.
    if (last) break;
    return null;
  }
  if (/[{}*<> ]/.test(out)) return null;
  return out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out;
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

export function collectFrontendApiCalls(repoRoot: string): FrontendApiCall[] {
  const out: FrontendApiCall[] = [];
  for (const full of listTs(join(repoRoot, FRONTEND_API_DIR)).sort()) {
    const file = relative(repoRoot, full);
    for (const raw of stringLiterals(readFileSync(full, 'utf8'))) {
      if (!raw.startsWith('/api/')) continue;
      out.push({ file, raw, probe: probeFor(raw) });
    }
  }
  return out;
}
