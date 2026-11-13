#!/usr/bin/env bun
// CI guard — fr's tests use no test doubles (owner ruling 2026-10-29).
//
// A test exercises fr's own code against real collaborators (the CI postgres,
// redis) or tests pure logic. It does not stub fetch, mock modules or
// functions, spy on collaborators, inject fakes through `__set*ForTests` seams,
// patch prototypes, fake timers or the clock, stand up fake servers with
// `Bun.serve`, replace built-ins (`Object.entries =`, `Date.now =`, `process.x =`;
// `process.env.X =` and `process.exitCode =` stay allowed), or intercept the browser's network. Comments are ignored; fail-closed on
// scope (a missing root or zero scanned files is EXIT_BROKEN_SCOPE).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const EXIT_OFFENCES = 1;
export const EXIT_BROKEN_SCOPE = 2;

const REPO = resolve(import.meta.dir, '../..');
export const ROOTS = ['backend/tests', 'backend/src', 'backend/scripts', 'frontend/src', 'frontend/e2e'];

export const RULES: ReadonlyArray<[string, RegExp]> = [
  [
    'fetch stub',
    /\b(?:globalThis|window|global|self)\b(?:\s+as\s+[^)]+)?\)*\.fetch\s*=(?!=)|stubGlobal\(\s*['"`]fetch|\bdefineProperty\(\s*(?:globalThis|window|global|self)\s*,\s*['"`]fetch|\bObject\.assign\(\s*(?:globalThis|window|global|self)\s*,\s*\{[^}]*\bfetch\b/,
  ],
  ['module mock', /\bmock\.module\(|\bvi\.(?:mock|doMock)\(|\bjest\.mock\(/],
  ['mock function', /\bvi\.fn\(|\bjest\.fn\(|(?<![.\w$])mock\s*(?:<[^>()]*>)?\s*\(/],
  ['spy', /\b(?:vi\.)?spyOn\(\s*(?!console\b)/],
  [
    'global stub',
    /\bvi\.stubGlobal\(|\b(?:globalThis|window|global|self|Bun)\b(?:\s+as\s+[^)]+)?\)*\.(?:WebSocket|EventSource|XMLHttpRequest|RedisClient|Date|setTimeout|setInterval|clearTimeout|clearInterval|queueMicrotask|performance|crypto|localStorage|sessionStorage|navigator|location|serve|spawn|file)\s*=(?!=)/,
  ],
  ['fake collaborator', /\bclass\s+(?:Stub|Fake|Mock)[A-Z]\w*|\b(?:make|create|build)(?:Stub|Fake|Mock)[A-Z]\w*\s*\(/],
  ['injected fake', /\b__set[A-Z]\w*|\b_set[A-Z]\w*ForTests\b|\bDepsForTests\b/],
  ['network interception', /\b(?:page|context|target|browserContext)\.route\(/],
  ['prototype patch', /\b\w+\.prototype\.\w+\s*=(?!=)|\bdefineProperty\(\s*\w+\.prototype\b/],
  ['fake timers', /\b(?:vi|jest)\.(?:useFakeTimers|setSystemTime|advanceTimers\w*|runAllTimers|runOnlyPendingTimers)\(|(?<![.\w$])setSystemTime\(/],
  ['fake server', /\bBun\.serve\(/],
  [
    'built-in patch',
    /(?<![.\w$])(?:(?:globalThis|window|global|self)\.)?(?:Object|Array|JSON|Math|Reflect|Promise|Number|String|Symbol|Date)(?:\.prototype)?(?:\.\w+|\[\s*['"`]\w+['"`]\s*\])\s*(?:\|\||&&|\?\?)?=(?!=)|(?<![.\w$])(?:(?:globalThis|global)\.)?process\.(?!env\s*[.[]|exitCode\b)\w+(?:\.\w+)*\s*(?:\|\||&&|\?\?)?=(?!=)/,
  ],
];

const isTestFile = (p: string) => /\.(?:test|spec)\.(?:ts|tsx|js)$/.test(p);
const isTestHelper = (p: string) => /(?:^|\/)(?:tests|e2e)\//.test(p) && /\.(?:ts|tsx|js)$/.test(p);
// Test-only Svelte components (harnesses mounted by a test) are named `__*.svelte`.
const isTestComponent = (p: string) => /(?:^|\/)__[^/]*\.svelte$/.test(p);

// Drops // and /* */ comments (and <!-- --> in Svelte markup) while leaving
// string, template and regex literals intact, so a glob like '**/*.ts' is code,
// not the start of a comment that swallows everything after it.
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const regexAllowedAfter = /[(,=:[!&|?{};+\-*%<>~^]$|(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '<' && src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        else if (c !== '`' && src[i] === '\n') break;
        i++;
      }
      i++;
      out += src.slice(start, i);
      continue;
    }
    if (c === '/' && regexAllowedAfter.test(out.trimEnd() || '(')) {
      const start = i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        i++;
      }
      i++;
      out += src.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function offences(path: string, src: string): string[] {
  const body = stripComments(src);
  return RULES.filter(([, re]) => re.test(body)).map(([name]) => `${path}: ${name}`);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

export function scan(repo = REPO, roots = ROOTS): { files: number; found: string[] } {
  const files: string[] = [];
  for (const r of roots) {
    const abs = join(repo, r);
    if (!existsSync(abs)) throw new Error(`scope root missing: ${r}`);
    walk(abs, files);
  }
  const self = resolve(import.meta.path);
  const scoped = files.filter((f) => f !== self).map((f) => relative(repo, f)).filter((p) => isTestFile(p) || isTestHelper(p) || isTestComponent(p));
  return { files: scoped.length, found: scoped.flatMap((p) => offences(p, readFileSync(join(repo, p), 'utf8'))) };
}

if (import.meta.main) {
  let result: ReturnType<typeof scan>;
  try {
    result = scan();
  } catch (err) {
    console.error(`BROKEN SCOPE: ${(err as Error).message}`);
    process.exit(EXIT_BROKEN_SCOPE);
  }
  if (result.files === 0) {
    console.error('BROKEN SCOPE: zero test files scanned');
    process.exit(EXIT_BROKEN_SCOPE);
  }
  if (result.found.length > 0) {
    console.error(`FAIL: ${result.found.length} test double(s):\n  ${result.found.join('\n  ')}`);
    process.exit(EXIT_OFFENCES);
  }
  console.log(`OK: ${result.files} test file(s)/helper(s) scanned, no test doubles.`);
}
