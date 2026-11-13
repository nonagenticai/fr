// tests/unit/services/planka/description-chokepoint-coverage.test.ts
//
// Keep-out census for the Planka card-description chokepoint
// (src/services/planka/description-guard.ts). The chokepoint only protects
// what goes THROUGH it, so this pins that nothing else can put a body on the
// wire to Planka.
//
// ⛔ IMPORT-LEVEL, NOT PATH-LEVEL. The previous census classified every
// `http.request(METHOD, PATH)` by matching the PATH string, and was evadable two
// ways (audit NO, 2026-10-02): a computed path (`'/api/cards/' + id`) is not a
// literal so it was never classified as a card write, and a transport held in a
// variable not named `http` was never seen at all. This census asks a question
// neither trick can dodge — WHO may write through the Planka client at all:
//
//   1. A module that references the Planka client (its symbols, or any import
//      specifier naming a planka module) may use the raw transport's `request`
//      method ONLY as `.request('GET', …)`. Any other use of the member —
//      a non-GET literal, a variable method, `.request.bind/call/apply`,
//      `['request']`, a destructured `{ request }` — is an offender, whatever
//      the path string or the variable holding the client is called. Writes
//      belong to the reviewed transport layer (TRANSPORT_LAYER below).
//   2. The PlankaHttp transport runs the guard on EVERY non-GET body before it
//      builds the URL or fetches (structural check here; the behavioural suite was
//      deleted 2026-10-29) — so even a TRANSPORT_LAYER resource,
//      or a module that got the client untyped and so escapes (1), cannot put
//      evidence on the wire.
//   3. No second transport: PlankaHttp is constructed only in
//      services/planka/index.ts; the Planka/kanban base URLs are read only by
//      the two clients; the kanban HttpClient is not exported; the generated
//      create/update card URL builders are used only by integrations/kanban.ts.
//   2b. The kanban transport (integrations/kanban.ts) is the twin: its single
//      low-level `http()` returns KANBAN_TRANSPORT, whose `json` runs the guard
//      on every non-GET body before the raw client — so createProject /
//      updateProject (unguarded before 2026-10-02) and any future writer there
//      are covered without remembering to call it.
//   4. Inside the two clients, every function that writes a card body calls the
//      guard BEFORE its request.
//
// The census is a pure function over {rel, text} so the "goes red" half is
// proven on synthetic modules below, not just asserted.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { plankaBodyEvidenceRefusal } from '../../../../src/services/planka/description-guard';

const SRC = join(import.meta.dir, '../../../../src');
const CARDS = 'services/planka/cards.ts';
const KANBAN = 'integrations/kanban.ts';
const HTTP = 'services/planka/http.ts';
const GUARD_MODULE = 'services/planka/description-guard.ts';
const GUARD = 'assertPlankaCardBodyCarriesNoEvidence(';

interface SrcFile {
  rel: string;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      walk(p, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

const FILES: SrcFile[] = walk(SRC).map((abs) => ({ rel: relative(SRC, abs), text: readFileSync(abs, 'utf8') }));

/**
 * Strip line + block comments so prose cannot satisfy or trip a scan.
 *
 * ⛔ LINE COMMENTS FIRST (fr#1359). Block-first let a line comment quoting a glob
 * such as `/api/*` open a "block" that ran to the next `*\/` in the file and
 * swallowed every line of real code in between — a write hidden there was
 * invisible to rule 1. The kanban rule already stripped line-first for the same
 * reason; every rule now shares this one order.
 */
function code(text: string): string {
  return text.replace(/(^|[^:'"`])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Blank the CONTENT of '…', "…" and `…` literals, length-preserving, so the
 * word "request" in a string (SQL in a template, an import path) is not a
 * token. A template's `${…}` expressions stay CODE: a write hidden in one is
 * still seen.
 */
function blankStrings(src: string): string {
  const out = src.split('');
  let i = 0;
  const blankQuoted = (q: string) => {
    for (i++; i < src.length && src[i] !== q && src[i] !== '\n'; i++) {
      if (src[i] === '\\') out[i++] = ' ';
      out[i] = ' ';
    }
    i++;
  };
  const blankTemplate = () => {
    for (i++; i < src.length && src[i] !== '`'; i++) {
      if (src[i] === '\\') {
        out[i++] = ' ';
        out[i] = ' ';
      } else if (src[i] === '$' && src[i + 1] === '{') {
        let depth = 1;
        for (i += 2; i < src.length && depth > 0; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          else if (src[i] === "'" || src[i] === '"') {
            blankQuoted(src[i]!);
            i--;
          } else if (src[i] === '`') {
            blankTemplate();
          }
        }
        i--;
      } else {
        out[i] = ' ';
      }
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') blankQuoted(c);
    else if (c === '`') {
      blankTemplate();
      i++;
    } else i++;
  }
  return out.join('');
}

/**
 * The reviewed transport layer: the ONLY modules that may use the raw
 * `request` member for anything but a GET. Enumerated file by file (not a
 * directory prefix), so a new module — even one under services/planka/ —
 * fails until it is reviewed here. Every one of them reaches Planka through
 * PlankaHttp.request, which runs the guard on every non-GET body (rule 2).
 */
const TRANSPORT_LAYER: Record<string, string> = {
  [HTTP]: 'defines PlankaHttp.request; runs the evidence guard on every non-GET body',
  [CARDS]: 'CardsResource; create/update also run the guard themselves (rule 4)',
  'services/planka/boards.ts': 'BoardsResource — board bodies, via the guarded transport',
  'services/planka/comments.ts': 'CommentsResource — comment text, via the guarded transport',
  'services/planka/custom-fields.ts': 'CustomFieldsResource — field values, via the guarded transport',
  'services/planka/labels.ts': 'LabelsResource — via the guarded transport',
  'services/planka/lists.ts': 'ListsResource — via the guarded transport',
  'services/planka/members.ts': 'MembersResource — via the guarded transport',
  'services/planka/projects.ts': 'ProjectsResource — via the guarded transport',
  'services/planka/task-lists.ts': 'TaskListsResource — via the guarded transport',
  'services/planka/tasks.ts': 'TasksResource — via the guarded transport',
  'services/planka/webhooks.ts': 'WebhooksResource — board subscriptions (no card text), via the guarded transport',
};

/** Does the module reference the Planka client: a client symbol, or an import specifier naming a planka module? */
function referencesPlankaClient(f: SrcFile): boolean {
  if (f.rel.startsWith('services/planka/')) return true;
  const src = code(f.text);
  if (/\b(?:PlankaHttp|PlankaClient|plankaClient|plankaAs[A-Za-z]*)\b/.test(src)) return true;
  // static import / export-from, dynamic import(), require()
  return /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"`][^'"`]*planka[^'"`]*['"`]/i.test(src);
}

/** Every use of the raw `request` member in `f` that is not `.request('GET', …)`. */
function nonGetRequestUses(f: SrcFile): string[] {
  const src = code(f.text);
  const blanked = blankStrings(src);
  const out: string[] = [];
  // element access by name: `x['request']`, `x["request"]`, `x[`request`]`
  for (const m of src.matchAll(/\[\s*['"`]request['"`]\s*\]/g)) out.push(`${f.rel}: ${m[0]}`);
  for (const m of blanked.matchAll(/\brequest\b/g)) {
    const at = m.index!;
    const before = blanked.slice(0, at).trimEnd();
    const after = src.slice(at + 'request'.length);
    const isGetCall = before.endsWith('.') && /^\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\s*\(\s*'GET'\s*,/.test(after);
    if (!isGetCall) out.push(`${f.rel}: …${src.slice(Math.max(0, at - 30), at + 40).replace(/\s+/g, ' ')}…`);
  }
  return out;
}

/** Rule 1: offenders across `files`. */
function plankaWriteOffenders(files: SrcFile[]): string[] {
  return files
    .filter((f) => !(f.rel in TRANSPORT_LAYER) && f.rel !== KANBAN && referencesPlankaClient(f))
    .flatMap(nonGetRequestUses);
}

describe('Planka card-description chokepoint coverage (import-level census)', () => {
  test('the census sees the client at all (non-vacuous)', () => {
    const refs = FILES.filter(referencesPlankaClient).map((f) => f.rel);
    // Non-vacuity: the matcher must see the client at all. No count — the named
    // modules below are the controls.
    expect(refs).toContain('routes/kanban/reads.ts');
    expect(refs).toContain('routes/cards/get.ts');
    // G-26 gap A: the existing-card evidence writer PATCHes a description, so the census must see it.
    expect(refs).toContain('routes/cards/scenario-evidence.ts');
    // and the GET form it allows is really there (11 modules read through `planka.http.request('GET', …)`)
    const getReaders = FILES.filter(
      (f) => !(f.rel in TRANSPORT_LAYER) && referencesPlankaClient(f) && /\.request\b/.test(code(f.text)),
    );
    expect(getReaders.length).toBeGreaterThan(0);
  });

  test('rule 1: outside the transport layer, the Planka client is used only for GETs', () => {
    expect(plankaWriteOffenders(FILES)).toEqual([]);
  });

  test('rule 1 goes RED for the evasions the path census missed (synthetic modules)', () => {
    const imp = "import { plankaClient } from '../services/planka';\n";
    const cases: Record<string, string> = {
      'computed card path': imp + "await plankaClient.http.request('PATCH', '/api/cards/' + id, { body: { description } });",
      'client in a differently named variable':
        imp + "const wire = plankaClient.asAgent().http;\nawait wire.request('POST', p, { body });",
      'variable method': imp + 'await plankaClient.http.request(method, path, { body });',
      'generic + template path':
        imp + "await plankaClient.http.request<Card>('PATCH', `/api/cards/${id}`, { body });",
      'bound method': imp + 'const send = plankaClient.http.request.bind(plankaClient.http);',
      'element access': imp + "await plankaClient.http['request']('PATCH', p, { body });",
      'destructured member': imp + 'const { request } = plankaClient.http;',
      'type-only import, client passed in':
        "import type { PlankaClient } from '../services/planka';\nexport const f = (c: PlankaClient) => c.http.request('PATCH', x, {});",
      'dynamic import': "const { plankaClient: p } = await import('../services/planka');\nawait p.http.request('PATCH', x, {});",
      'new file inside services/planka': "this.http.request('PATCH', '/api/cards/' + id, { body });",
    };
    for (const [name, text] of Object.entries(cases)) {
      const rel = name === 'new file inside services/planka' ? 'services/planka/sneaky.ts' : `routes/sneaky-${name.replace(/\W+/g, '-')}.ts`;
      expect({ name, offenders: plankaWriteOffenders([{ rel, text }]).length > 0 }).toEqual({ name, offenders: true });
    }
    // controls: a GET read, and the word in a string or comment, are not offenders
    expect(
      plankaWriteOffenders([
        {
          rel: 'routes/reader.ts',
          text:
            "import { plankaClient } from '../services/planka';\n" +
            "// we never request a write here\nconst phase = 'request';\n" +
            "await plankaClient.http.request<Card>('GET', `/api/cards/${id}`, {});",
        },
      ]),
    ).toEqual([]);
  });

  test('rule 1 sees a write planted after a line comment quoting `/api/*` (comment-strip order, fr#1359)', () => {
    const text =
      "import { plankaClient } from '../services/planka';\n" +
      '// writes go to /api/* through the transport layer\n' +
      "await plankaClient.http.request('PATCH', '/api/cards/' + id, { body: { name } });\n" +
      '/** a later block comment closes the phantom block */\n' +
      'export const x = 1;\n';
    expect(plankaWriteOffenders([{ rel: 'routes/sneaky-after-line-comment.ts', text }]).length).toBeGreaterThan(0);
    // and the stripper keeps the code line while dropping both comments
    const stripped = code(text);
    expect(stripped).toContain("request('PATCH'");
    expect(stripped).not.toContain('writes go to');
    expect(stripped).not.toContain('phantom block');
  });

  test('every TRANSPORT_LAYER entry exists (no stale allowlist line waiting to be reused)', () => {
    const rels = new Set(FILES.map((f) => f.rel));
    expect(Object.keys(TRANSPORT_LAYER).filter((r) => !rels.has(r))).toEqual([]);
  });

  /** The body of `name` in `text`: from its signature to the next top-level declaration. */
  function fnBody(text: string, signature: RegExp): string {
    const m = signature.exec(text);
    expect(m).not.toBeNull();
    const start = m!.index;
    const next = text.slice(start + m![0].length).search(/\n {0,2}(?:async |export |static |\/\/|\/\*\*)/);
    return text.slice(start, next === -1 ? undefined : start + m![0].length + next);
  }

  test('rule 2: PlankaHttp.request runs the guard on every non-GET body before the URL and the fetch', () => {
    const body = fnBody(code(readFileSync(join(SRC, HTTP), 'utf8')), /async request<T = unknown>\(/);
    // fr#1359 follow-up: the guard walks the SERIALIZED wire body (toJSON /
    // getters / non-enumerables resolved), and the request sends that same
    // string — one serialization, checked and sent byte-identical.
    const serializedAt = body.indexOf('const serialized = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;');
    const guardAt = body.indexOf("if (method !== 'GET') " + GUARD + 'parseWire(serialized))');
    expect(serializedAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(serializedAt);
    expect(guardAt).toBeLessThan(body.indexOf('this.buildUrl('));
    expect(guardAt).toBeLessThan(body.indexOf('fetch('));
    expect(body).toContain('body: serialized,');
    expect(body.split('JSON.stringify(').length - 1).toBe(1);
    expect(body).not.toContain(GUARD + 'opts.body');
  });

  /**
   * Rule 2, WHOLE BODY (fr#1359): the guard both transports call walks EVERY
   * string value and key of the body — not only `description`. Pure over the
   * guard module's text so the red half is proven on synthetic mutants.
   */
  function wholeBodyGuardOffenders(text: string): string[] {
    const src = code(text);
    const out: string[] = [];
    const assertFn = fnBody(src, /export function assertPlankaCardBodyCarriesNoEvidence\(body: unknown\): void \{/);
    if (!/const refusal = plankaBodyEvidenceRefusal\(body\);/.test(assertFn)) {
      out.push('assertPlankaCardBodyCarriesNoEvidence does not walk the WHOLE body');
    }
    if (/\.description\b|\bdescription\b/.test(assertFn)) out.push('assertPlankaCardBodyCarriesNoEvidence singles out description');
    const walk = fnBody(src, /export function plankaBodyEvidenceRefusal\(body: unknown\): PlankaBodyRefusal \| null \{/);
    if (/\bdescription\b/.test(walk)) out.push('the walk singles out description');
    if (!/check\(k, path, 'key'\)/.test(walk)) out.push('the walk does not check object keys');
    if (!/typeof v === 'string'[\s\S]*?check\(v, path, 'value'\)/.test(walk)) out.push('the walk does not check string values');
    return out;
  }

  test('rule 2 (whole body): the guard both transports call walks every string value and key', () => {
    expect(wholeBodyGuardOffenders(readFileSync(join(SRC, GUARD_MODULE), 'utf8'))).toEqual([]);
    // and behaviourally, on the fields #1359 named (none of them `description`)
    for (const body of [
      { text: 'test_file_content' },
      { name: '{"test_file_\\u0063ontent":"x"}' },
      { content: JSON.stringify(JSON.stringify({ test_file_content: 'x' })) },
      { customFieldValues: [{ content: 'ok' }, { content: 'test_file_content' }] },
      { meta: { test_file_content: 1 } },
    ]) {
      expect({ body, refused: plankaBodyEvidenceRefusal(body) !== null }).toEqual({ body, refused: true });
    }
    // both transports hand the guard the WHOLE body, not a field of it
    expect(code(readFileSync(join(SRC, HTTP), 'utf8'))).toContain("if (method !== 'GET') " + GUARD + 'parseWire(serialized));');
    expect(code(readFileSync(join(SRC, KANBAN), 'utf8'))).toContain(GUARD + 'wireBody(init.body));');
  });

  test('rule 2 (whole body) goes RED for a description-only guard (synthetic mutants)', () => {
    const real = readFileSync(join(SRC, GUARD_MODULE), 'utf8');
    const mutants: Record<string, string> = {
      'assert narrowed to description': real.replace(
        'const refusal = plankaBodyEvidenceRefusal(body);',
        'const refusal = plankaBodyEvidenceRefusal({ description: (body as { description?: unknown } | null)?.description });',
      ),
      'walk skips keys': real.replace("const kr = check(k, path, 'key');", 'const kr = null;'),
      'walk only checks description values': real.replace(
        "const r = check(v, path, 'value');",
        "const r = path === 'description' ? check(v, path, 'value') : null;",
      ),
    };
    for (const [name, text] of Object.entries(mutants)) {
      expect({ name, changed: text !== real }).toEqual({ name, changed: true });
      expect({ name, red: wholeBodyGuardOffenders(text).length > 0 }).toEqual({ name, red: true });
    }
  });

  test('rule 3: no second Planka transport', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = code(f.text);
      if (/new PlankaHttp\(/.test(src) && f.rel !== 'services/planka/index.ts') offenders.push(`${f.rel}: new PlankaHttp`);
      if (/services\.(planka|kanban)\.baseUrl/.test(src) && !['services/planka/index.ts', KANBAN].includes(f.rel)) {
        offenders.push(`${f.rel}: reads a Planka base URL`);
      }
      if (f.rel !== KANBAN && /\bget(Create|Update)CardUrl\b/.test(src)) offenders.push(`${f.rel}: card URL builder`);
    }
    expect(offenders).toEqual([]);
    // the kanban HttpClient stays private to integrations/kanban.ts
    const kanban = code(readFileSync(join(SRC, KANBAN), 'utf8'));
    expect(kanban).toMatch(/\nfunction rawClient\(\): HttpClient/);
    expect(kanban).not.toMatch(
      /export\s+(?:const|let|function)\s+(?:http|rawClient|cachedClient|KANBAN_TRANSPORT)\b|export\s*\{[^}]*\b(?:http|rawClient|cachedClient|KANBAN_TRANSPORT)\b/,
    );
  });

  /**
   * Rule 2 for the SECOND transport: integrations/kanban.ts. Pure over the
   * module text so the red half is proven on synthetic mutants below.
   *  (a) KANBAN_TRANSPORT.json runs the guard on every non-GET body BEFORE it
   *      calls the raw client;
   *  (b) the raw client (`rawClient()`) is called from exactly that one place,
   *      `cachedClient` is touched only by rawClient, and
   *      nothing in the module calls `fetch(` or `createHttpClient(` elsewhere —
   *      so a new writer that bypasses `http()` has no wire to reach.
   */
  function kanbanTransportOffenders(text: string): string[] {
    // `code()` strips LINE comments first: a line comment in kanban.ts quoting
    // `/api/*` would otherwise open a "block" that swallows real code (it hid
    // `return cachedClient;`) — a blind spot a bypass could use.
    const src = code(text);
    const out: string[] = [];
    const t = /const KANBAN_TRANSPORT = \{[\s\S]*?\n\};/.exec(src);
    if (!t) return ['KANBAN_TRANSPORT not found'];
    const transport = t[0];
    const guardAt = transport.search(
      /if \(method !== 'GET' && init\.body !== undefined && init\.body !== null\) \{\s*assertPlankaCardBodyCarriesNoEvidence\(wireBody\(init\.body\)\);\s*\}/,
    );
    const rawAt = transport.indexOf('rawClient().json');
    if (guardAt === -1) out.push('KANBAN_TRANSPORT.json does not guard every non-GET body');
    if (rawAt === -1) out.push('KANBAN_TRANSPORT.json does not send through rawClient()');
    if (guardAt !== -1 && rawAt !== -1 && guardAt > rawAt) out.push('guard runs after the raw request');
    if (!/\nfunction http\(\): typeof KANBAN_TRANSPORT \{\s*return KANBAN_TRANSPORT;\s*\}/.test(src)) {
      out.push('http() does not return the guarded transport');
    }
    const rawCalls = [...src.matchAll(/\brawClient\b(?!\(\): HttpClient)/g)].length;
    if (rawCalls !== 1) out.push(`rawClient referenced ${rawCalls}x (expected 1, inside KANBAN_TRANSPORT)`);
    const blanked = blankStrings(src);
    if ([...blanked.matchAll(/\bfetch\s*\(/g)].length > 0) out.push('direct fetch(');
    if ([...blanked.matchAll(/\bcreateHttpClient\s*\(/g)].length !== 1) out.push('createHttpClient( count != 1');
    const cached = [...src.matchAll(/\bcachedClient\b/g)].length;
    // declaration + `if (!cachedClient)` + assignment + return in rawClient = 4
    if (cached !== 4) out.push(`cachedClient referenced ${cached}x (expected 4)`);
    return out;
  }

  test('rule 2 (kanban): every non-GET body through integrations/kanban.ts passes the guard before the raw client', () => {
    expect(kanbanTransportOffenders(readFileSync(join(SRC, KANBAN), 'utf8'))).toEqual([]);
  });

  test('rule 2 (kanban) goes RED for a guard removed, moved, or bypassed (synthetic mutants)', () => {
    const real = readFileSync(join(SRC, KANBAN), 'utf8');
    const guardLine = 'assertPlankaCardBodyCarriesNoEvidence(wireBody(init.body));';
    expect(real).toContain(guardLine);
    const mutants: Record<string, string> = {
      'guard removed': real.replace(guardLine, ''),
      'guard limited to POST': real.replace("if (method !== 'GET' &&", "if (method === 'POST' &&"),
      'writer calls the raw client directly': real.replace(
        'export async function deleteProject(',
        "export async function sneaky(b: unknown) { return rawClient().json('/api/projects', { method: 'POST', body: JSON.stringify(b) }); }\nexport async function deleteProject(",
      ),
      'writer uses the cached client': real.replace(
        'export async function deleteProject(',
        "export async function sneaky(b: unknown) { return cachedClient!.json('/api/projects', { method: 'POST', body: JSON.stringify(b) }); }\nexport async function deleteProject(",
      ),
      'writer fetches directly': real.replace(
        'export async function deleteProject(',
        "export async function sneaky(b: unknown) { return fetch(u, { method: 'POST', body: JSON.stringify(b) }); }\nexport async function deleteProject(",
      ),
      'bypass hidden inside rawClient (behind the `/api/*` comment)': real.replace(
        'return cachedClient;',
        "void cachedClient.json('/api/projects', { method: 'POST', body: '{}' });\n  return cachedClient;",
      ),
      'second HttpClient': real.replace(
        'export async function deleteProject(',
        "const other = createHttpClient({ serviceName: 'k', baseUrl: 'x' });\nexport async function deleteProject(",
      ),
      'http() returns the raw client': real.replace(
        /function http\(\): typeof KANBAN_TRANSPORT \{\s*return KANBAN_TRANSPORT;\s*\}/,
        'function http(): HttpClient {\n  return rawClient();\n}',
      ),
    };
    for (const [name, text] of Object.entries(mutants)) {
      expect({ name, changed: text !== real }).toEqual({ name, changed: true });
      expect({ name, red: kanbanTransportOffenders(text).length > 0 }).toEqual({ name, red: true });
    }
  });

  test('rule 4: cards.ts create and update call the guard before the request', () => {
    const src = code(readFileSync(join(SRC, CARDS), 'utf8'));
    for (const sig of [/async create\(/, /async update\(/]) {
      const body = fnBody(src, sig);
      expect(body).toContain(GUARD);
      expect(body.indexOf(GUARD)).toBeLessThan(body.indexOf('.request'));
    }
  });

  test('rule 4: cards.ts methods that do not call the guard never send a caller-supplied card body', () => {
    // move and duplicate build their body from named fields only; if either
    // starts forwarding an input object, it must gain the guard.
    const src = code(readFileSync(join(SRC, CARDS), 'utf8'));
    expect(fnBody(src, /async move\(/)).toContain('body: { listId: to.listId, position: to.position }');
    expect(fnBody(src, /async duplicate\(/)).not.toMatch(/description/);
  });

  test('rule 4: integrations/kanban.ts createCard and updateCard call the guard before the request; moveCard delegates', () => {
    const src = code(readFileSync(join(SRC, KANBAN), 'utf8'));
    for (const sig of [/export async function createCard\(/, /export async function updateCard\(/]) {
      const body = fnBody(src, sig);
      expect(body).toContain(GUARD);
      expect(body.indexOf(GUARD)).toBeLessThan(body.indexOf('http()'));
    }
    const move = fnBody(src, /export async function moveCard\(/);
    expect(move).toContain('updateCard(');
    expect(move).not.toContain('http()');
  });
});
