// FR-8: customer UI carried developer/plan references ("(Plan 2-D)",
// "(Spec 2 §4.5)", "Plan 3 Lane C"), a PERSONAL e-mail address, and the
// internal board vendor's name in user-facing copy. This scans every Svelte
// component's rendered surface (comments stripped) so a new one fails here by
// file name rather than shipping.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEFAULT_SUPPORT_EMAIL, supportEmail } from './contact';

const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.svelte') || (p.endsWith('.ts') && !p.includes('.test.'))) out.push(p);
  }
  return out;
}

/** Strip HTML and JS comments; what remains is code and rendered copy. */
function surface(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

const files = walk(SRC).filter(
  (f) =>
    // The generated n8n node manifest carries upstream node docs, not fr copy.
    !f.endsWith('nodeSchemaManifest.ts') &&
    // Super-admin console: operators, not customers.
    !f.includes(join('routes', '(admin)', 'admin', '(platform)')),
);

describe('customer-facing copy', () => {
  it('scans a non-trivial set of files (guards against a vacuous scan)', () => {
    // Named file, not a `>200` count of the tree: a walk that returned nothing
    // fails here, and the count no longer has to move whenever a file is added.
    expect(files.map((f) => relative(SRC, f))).toContain('lib/layout/SidebarNav.svelte');
  });

  it.each([
    ['a personal e-mail address', /george@nonagentic\.ai/],
    ['a plan/spec reference', /\((?:Plan|Spec) \d[^)]*\)|Plan \d+ Lane [A-Z]/],
    ['the board vendor name in prose', /\b(?:in|via|from) Planka\b|Planka (?:service|board|card)\b|Planka's/],
  ])('contains no %s', (_label, re) => {
    const hits = files
      .filter((f) => re.test(surface(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it('the support contact is a role mailbox by default', () => {
    expect(DEFAULT_SUPPORT_EMAIL).toBe('support@nonagentic.ai');
    expect(supportEmail()).toBe(DEFAULT_SUPPORT_EMAIL);
  });
});

// ── fr#1409: HTTP status / statusText / raw body as user-visible text ────────
//
// /chat, /workers/new and /workers/[name] rendered `${res.status} — ${await
// res.text()}` and fetchProviders' thrown `${res.status} ${res.statusText}:
// detail` (e.g. "502 Bad Gateway: <upstream detail>") to tenant admins. The
// fix is neutral copy + `logRawError` (console only). This scan fails on any
// source LINE (comments stripped) that interpolates `${<id>.status}` together
// with either
//   (a) `statusText` or a `.text()` body read, or
//   (b) a second `${…}` interpolation naming a detail-like identifier
//       (detail(s), body, message, msg, text, reason, err, error, description,
//       suffix) — e.g. `${r.status}${detail ? ` — ${detail}` : ''}`.
// Line-based on purpose: a backtick scanner desyncs on prose
// apostrophes/backticks in .svelte markup.
//
// NOT covered (known blind spots — do not read a green run as "no leak"):
//   - a status and its detail split across lines or built in separate
//     statements (`const msg = await res.text(); … `${res.status}: ${msg}``
//     is caught; `parts.push(res.status); parts.push(body)` is not);
//   - a detail interpolation whose identifier is not in the list above
//     (`${res.status} ${x}`);
//   - status read without `.status` interpolation (`String(res.status) + …`,
//     `res.status.toString()`), or a raw body rendered with no status at all;
//   - status/body copied into page state from a caught Error's `.message`
//     outside the 'mapped' consumers checked below.
//
// A hit is allowed only when ALLOWED names its file with the EXACT hit count:
//   - kind 'mapped': a thrower whose Error message every consumer maps to
//     neutral copy. Its `mappedBy` consumers are checked below: none may copy
//     the caught error's `.message` into page state, and each logs the raw one.
//     Mapped entries are capped too (MAPPED_BASELINE_*): a new one is an audit
//     claim and must raise the cap deliberately in the same diff.
//   - kind 'debt': pre-existing, NOT audited (fr#1409 follow-up). The debt
//     total may only SHRINK. The fix for a new hit is neutral copy +
//     logRawError — never a new ALLOWED entry; a file may not enter the debt list.

const STATUS_INTERP = /\$\{\s*[A-Za-z_$][\w$]*\.status\s*\}/;
const RAW_COMPANION = /\bstatusText\b|\.text\(\)/;
/** A second interpolation that names a detail-like value (shape (b) above). */
const DETAIL_INTERP =
  /\$\{[^}]*\b(?:detail|details|body|message|msg|text|reason|err|error|description|suffix)\b/i;

function isStatusLeak(line: string): boolean {
  if (!STATUS_INTERP.test(line)) return false;
  if (RAW_COMPANION.test(line)) return true;
  return DETAIL_INTERP.test(line.replace(STATUS_INTERP, ''));
}

/** The lines of `src` (comments stripped) that build text from an HTTP status + statusText/body/detail. */
function statusLeakLines(src: string): string[] {
  return surface(src)
    .split('\n')
    .filter(isStatusLeak)
    .map((l) => l.trim());
}

/** Server-only code never renders in the browser; it is outside this guard. */
const isServerOnly = (rel: string) =>
  /(^|\/)server\//.test(rel) || /\+(page\.|layout\.)?server\.ts$/.test(rel) || /hooks\.server\.ts$/.test(rel);

const SEP = '/';
const relOf = (f: string) => relative(SRC, f).split(/[\\/]/).join(SEP);
const leakFiles = files.filter((f) => !isServerOnly(relOf(f)));

type Allowed =
  | { kind: 'mapped'; hits: number; reason: string; module: string; mappedBy: string[] }
  | { kind: 'debt'; hits: number; reason: string };

const DEBT_THROWN = 'DEBT fr#1409 follow-up: thrown Error message carries status/statusText; consumers not audited';
const DEBT_RENDERED = 'DEBT fr#1409 follow-up: assigned to page state and rendered with status/statusText';
const DEBT_DETAIL = 'DEBT fr#1409 follow-up: thrown Error message carries status + detail/body (pattern widened); consumers not audited';
const DEBT_DETAIL_RENDERED = 'DEBT fr#1409 follow-up: status + detail/body assigned to page state (pattern widened); not audited';
const DEBT_TELEMETRY = 'DEBT fr#1409 follow-up: status + detail in a telemetry payload, likely not page copy; verify and reclassify';

const ALLOWED: Record<string, Allowed> = {
  'lib/workers/providers.ts': {
    kind: 'mapped',
    hits: 2,
    reason:
      'fetchProviders/fetchProviderModels throw for the console; pages render PROVIDERS_ERROR_TEXT, the picker providerModelsErrorText',
    module: '$lib/workers/providers',
    mappedBy: [
      'lib/workers/provider-models.svelte.ts',
      'routes/chat/+page.svelte',
      'routes/workers/new/+page.svelte',
      'routes/workers/[name]/+page.svelte',
    ],
  },
  'lib/api/assets.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/channel-prefs.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/channels.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/deliveries.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/kag.ts': { kind: 'debt', hits: 5, reason: DEBT_THROWN },
  'lib/api/me-licenses.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/n8n.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/notifications.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/reports.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/suggested-schedules.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/tenancy.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/tenant-members.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/toc.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/traceability.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/workflows.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/api/workspaceMembers.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'lib/asset-workspace/AssetList.svelte': { kind: 'debt', hits: 1, reason: DEBT_RENDERED },
  'lib/asset-workspace/relationDirectory.ts': { kind: 'debt', hits: 1, reason: DEBT_RENDERED },
  'lib/components/library/AssetCreateScopePicker.svelte': { kind: 'debt', hits: 1, reason: DEBT_RENDERED },
  'lib/stores/activityStore.svelte.ts': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'routes/byoc/+page.svelte': { kind: 'debt', hits: 1, reason: DEBT_RENDERED },
  'routes/settings/licenses/+page.svelte': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  'routes/workers/+page.svelte': { kind: 'debt', hits: 1, reason: DEBT_THROWN },
  // Added when shape (b) was introduced (fr#1409 validator follow-up).
  'lib/api/budget.ts': { kind: 'debt', hits: 3, reason: DEBT_DETAIL },
  'lib/api/github-app.ts': { kind: 'debt', hits: 1, reason: DEBT_DETAIL },
  'lib/api/governance.ts': { kind: 'debt', hits: 1, reason: DEBT_DETAIL },
  'lib/api/inference-admin.ts': { kind: 'debt', hits: 1, reason: DEBT_DETAIL },
  'lib/api/licenses-admin.ts': { kind: 'debt', hits: 1, reason: DEBT_DETAIL },
  'lib/api/super-admin.ts': { kind: 'debt', hits: 5, reason: DEBT_DETAIL },
  'lib/api/usage.ts': { kind: 'debt', hits: 2, reason: DEBT_DETAIL },
  'lib/components/ErrorBoundary.svelte': { kind: 'debt', hits: 1, reason: DEBT_DETAIL_RENDERED },
  'lib/stores/analyticsStore.svelte.ts': { kind: 'debt', hits: 1, reason: DEBT_DETAIL },
  'lib/telemetry/client-errors.ts': { kind: 'debt', hits: 1, reason: DEBT_TELEMETRY },
  'routes/(admin)/admin/(tenant)/billing/+page.svelte': { kind: 'debt', hits: 1, reason: DEBT_DETAIL },
  'routes/(project)/projects/[id]/settings/+page.svelte': { kind: 'debt', hits: 1, reason: DEBT_DETAIL },
};

// Ratchet, pinned at fr#1409 (2026-10-03). Lower these when a debt entry is
// fixed; they may never rise.
// Widened 28/24 → 66/39 by shape (b) (+38 hits / +15 files), same PR.
const DEBT_BASELINE_HITS = 60;
const DEBT_BASELINE_FILES = 39;
// 'mapped' entries are audit claims; a new one must raise these deliberately.
const MAPPED_BASELINE_HITS = 2;
const MAPPED_BASELINE_FILES = 1;

/**
 * Errors whose `.message` is a fixed, client-built template (no status, no
 * upstream text) and may therefore be rendered. ProviderStateError
 * (lib/workers/providers.ts): "<provider> is not enabled for this workspace." /
 * "<provider> is unavailable right now." — the provider name is the caller's.
 */
const NEUTRAL_MESSAGE_ERRORS = /\binstanceof\s+ProviderStateError\b/;

/** A caught error's raw `.message` copied into state or markup. */
const COPIES_CAUGHT_MESSAGE = [
  /\b[\w$.]+\s*=\s*\(?\s*(\w+)\s+instanceof\s+Error\s*\?\s*\1\.message/,
  /\b[\w$.]+\s*=\s*(?:e|err|error)\.message\b/,
  /\{\s*(?:e|err|error)\.message\s*\}/,
];

/** The lines of `code` that copy a caught error's message, minus NEUTRAL_MESSAGE_ERRORS guards. */
function copiedMessages(code: string): string[] {
  return code
    .split('\n')
    .filter((l) => !NEUTRAL_MESSAGE_ERRORS.test(l) && COPIES_CAUGHT_MESSAGE.some((re) => re.test(l)))
    .map((l) => l.trim());
}

function scanLeaks(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of leakFiles) {
    const hits = statusLeakLines(readFileSync(f, 'utf8'));
    if (hits.length) out.set(relOf(f), hits);
  }
  return out;
}

describe('no HTTP status/statusText/body as user-visible text (fr#1409)', () => {
  it('the detector flags the leak shapes and passes the neutral ones (self-check)', () => {
    const positives = [
      'loadError = `${res.status} — ${await res.text()}`;',
      "throw new Error(`${res.status} ${res.statusText}${suffix}`);",
      'msg = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;',
      'x = `failed: ${r.status} ${await r.text()}`;',
    ];
    const negatives = [
      'loadError = WORKER_LOAD_ERROR_TEXT;',
      "logRawError('x', res.status, res.statusText, await res.text());",
      'error = `HTTP ${res.status}`;',
      '// loadError = `${res.status} — ${await res.text()}`;',
      '/* throw new Error(`${res.status} ${res.statusText}`) */',
      'const t = res.statusText;',
    ];
    for (const p of positives) expect(statusLeakLines(p), p).toHaveLength(1);
    for (const n of negatives) expect(statusLeakLines(n), n).toHaveLength(0);
    const widened = [
      "throw new Error(`fetchMyPlan: ${r.status}${detail ? ` — ${detail}` : ''}`);",
      'throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);',
      'throw new Error(`deprovisionUser: ${r.status}${suffix}`);',
    ];
    for (const p of widened) expect(statusLeakLines(p), p).toHaveLength(1);
    expect(statusLeakLines('x = `HTTP ${res.status} on ${route}`;')).toHaveLength(0);
    const copies = (s: string) => copiedMessages(s).length > 0;
    expect(copies('providerError = e instanceof Error ? e.message : String(e);')).toBe(true);
    expect(copies('this.lastError = err.message;')).toBe(true);
    expect(copies('<p>{e.message}</p>')).toBe(true);
    expect(copies('providerError = PROVIDERS_ERROR_TEXT;')).toBe(false);
    expect(copies("logRawError('chat providers', e);")).toBe(false);
    expect(copies('if (e instanceof ProviderStateError) this.notice = e.message;')).toBe(false);
    expect(copies('if (e instanceof Error) this.notice = e.message;')).toBe(true);
  });

  it('scans a non-trivial set of files and finds the known allowed patterns (non-vacuity)', () => {
    const found = scanLeaks();
    // The instrument must see real code: fetchProviders + fetchProviderModels.
    // Named presence, not `toHaveLength(2)` — the exact count is already held
    // by ALLOWED and the stale-entry check below.
    expect(found.has('lib/workers/providers.ts')).toBe(true);
  });

  it('every hit is allowed with its exact count; no stale entries', () => {
    const found = scanLeaks();
    const unexpected: string[] = [];
    for (const [file, hits] of found) {
      const a = ALLOWED[file];
      if (!a || hits.length > a.hits) {
        unexpected.push(`${file}:\n    ${hits.join('\n    ')}`);
      }
    }
    expect(
      unexpected,
      'Render neutral copy and send the raw status/body to logRawError (lib/workers/wm-errors.ts). ' +
        'Do not add an ALLOWED entry: a file may not enter the debt list.',
    ).toEqual([]);
    const stale = Object.entries(ALLOWED)
      .filter(([file, a]) => (found.get(file)?.length ?? 0) < a.hits)
      .map(([file, a]) => `${file}: allowed ${a.hits}, found ${found.get(file)?.length ?? 0}`);
    expect(stale, 'Lower the ALLOWED count (and the debt baseline) to what remains.').toEqual([]);
  });

  it('the debt only shrinks (ratchet)', () => {
    const debt = Object.values(ALLOWED).filter((a) => a.kind === 'debt');
    expect(debt.reduce((n, a) => n + a.hits, 0)).toBeLessThanOrEqual(DEBT_BASELINE_HITS);
    expect(debt.length).toBeLessThanOrEqual(DEBT_BASELINE_FILES);
    const mapped = Object.values(ALLOWED).filter((a) => a.kind === 'mapped');
    expect(mapped.reduce((n, a) => n + a.hits, 0), 'mapped hits: raise MAPPED_BASELINE_HITS deliberately').toBeLessThanOrEqual(
      MAPPED_BASELINE_HITS,
    );
    expect(mapped.length, 'mapped files: raise MAPPED_BASELINE_FILES deliberately').toBeLessThanOrEqual(
      MAPPED_BASELINE_FILES,
    );
    for (const [file, a] of Object.entries(ALLOWED)) {
      expect(a.reason.length, file).toBeGreaterThan(20);
      if (a.kind === 'debt') expect(a.reason, file).toContain('fr#1409');
    }
  });

  it("a 'mapped' thrower's consumers never render the caught message, and log it", () => {
    const problems: string[] = [];
    for (const [file, a] of Object.entries(ALLOWED)) {
      if (a.kind !== 'mapped') continue;
      for (const consumer of a.mappedBy) {
        const abs = join(SRC, ...consumer.split('/'));
        let src: string;
        try {
          src = readFileSync(abs, 'utf8');
        } catch {
          problems.push(`${file} → ${consumer}: consumer file missing (stale mappedBy)`);
          continue;
        }
        // Same-directory consumers import the module relatively.
        const sameDir = consumer.split('/').slice(0, -1).join('/') === file.split('/').slice(0, -1).join('/');
        const rel = `'./${file.split('/').pop()!.replace(/\.ts$/, '')}'`;
        if (!src.includes(`'${a.module}'`) && !(sameDir && src.includes(rel))) problems.push(`${consumer}: no longer imports ${a.module} (stale mappedBy)`);
        const code = surface(src);
        for (const m of copiedMessages(code)) {
          problems.push(`${consumer}: copies a caught error's message into the page: ${m}`);
        }
        if (!code.includes('logRawError(')) problems.push(`${consumer}: does not log the raw error (logRawError)`);
      }
    }
    expect(problems).toEqual([]);
  });
});
