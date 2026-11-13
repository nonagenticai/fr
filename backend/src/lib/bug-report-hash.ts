// src/lib/bug-report-hash.ts
//
// U2 — H_r, the content hash of a bug_report/v1 artifact. PURE: no db, no env.
//
//   H_r = sha256( RFC 8785 canonical JSON of {
//           schema: "bug_report/v1", tenant_id, project_id, card_id,
//           hunt: { status, scanned_files, tracked_source_files, root_cause_analysis,
//                   excluded_dirs[], excluded_entry_kinds[], worktree_dirty },
//           repo, commit_sha,
//           bugs: [{ id, kind, location:{file,line}, failing_test:{path,name}, fix_outline[] }]
//         } )
//
// bug_report/v1 as agreed with the U1 owner (10-01): `hunt` replaces the
// earlier `hunt_status` string, and a bug `id` is the fingerprint
// sha256(file "\n" line "\n" kind), recomputed and enforced here.
//
// * `bugs` is sorted by `id` (UTF-16 code-unit order, the same order RFC 8785
//   uses for object keys) so the hash is independent of the order the producer
//   listed the bugs in. `fix_outline` order IS semantic (it is a sequence of
//   steps) and is kept.
// * `severity` and `confidence` are EXCLUDED: they are a producer's opinion,
//   and re-scoring the same bugs must not mint a second artifact.
// * Any field the hash body does not name is dropped before hashing — the hash
//   covers exactly the projection below, nothing a client smuggles beside it.
// * `hunt` IS hashed (the scan's coverage is part of what the report claims).
//   Only `completed` with scanned == tracked and a root_cause_analysis that does
//   not start "Analysis failed: " is ever admitted; see BugReportDetailsSchema.
// * The hunt's DECLARED SCOPE IS hashed (coding-analysis hunt_agent/hunt.py,
//   coding-analysis#115): `excluded_dirs` (directory names out of both counts),
//   `excluded_entry_kinds` (tree-entry kinds out of both counts) and
//   `worktree_dirty` (the workspace had uncommitted edits, which a HEAD scan did
//   NOT see). A report is therefore honest about what it did not scan. Both
//   arrays are SETS: duplicates are refused and the hash body sorts them (UTF-16
//   code-unit order, as for `bugs`), so the producer's listing order never
//   mints a second artifact.
// * `kind` IS hashed. It is already bound through the fingerprint `id`; it is
//   named in the body too so a re-deriver does not have to invert a hash.
// * `trace_id` (AA-TRACE join key, migration 149) is NOT hashed: it names the
//   RUN that produced the report, not its content. Two runs that find the same
//   bugs produce the same artifact (insert-once returns the first row, which
//   keeps the first run's trace_id).
// * `project_id` absent ⇒ `null` in the body (a stated absence, not a missing
//   key), so "no project" and "project X" can never collide.
//
// The server RECOMPUTES H_r from the validated body (src/services/reports/
// bug-report.ts); a client may send `content_hash` only as an assertion that is
// checked, never as a value that is trusted.

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const BUG_REPORT_SCHEMA_ID = 'bug_report/v1' as const;

/**
 * RFC 8785 (JCS) canonicalisation for the value domain the bug_report/v1 zod
 * schema admits: null, booleans, strings, SAFE INTEGERS, arrays and plain
 * objects. For that domain JCS is exactly:
 *   - object members sorted by key in UTF-16 code-unit order (JS default sort),
 *   - no insignificant whitespace,
 *   - strings serialised as ECMAScript JSON.stringify does (JCS §3.2.2.2
 *     mandates that serialisation),
 *   - integers serialised as ECMAScript Number→string, which for a safe
 *     integer is its plain decimal form.
 * Anything outside the domain (a non-integer or unsafe number, NaN/Infinity,
 * undefined, bigint, function, symbol, a non-plain object such as a Date) is
 * REFUSED with a throw rather than serialised approximately — JCS's float
 * formatting is not implemented here, and a silent near-miss would make two
 * implementations disagree on H_r.
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`canonicalizeJcs: only safe integers are admitted, got ${String(value)}`);
      }
      // -0 serialises as "0" in both JSON.stringify and JCS.
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalizeJcs(v)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('canonicalizeJcs: only plain objects are admitted');
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) {
          throw new TypeError(`canonicalizeJcs: undefined value at key ${JSON.stringify(k)}`);
        }
        parts.push(`${JSON.stringify(k)}:${canonicalizeJcs(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalizeJcs: unsupported type ${typeof value}`);
  }
}

const nonEmpty = z.string().min(1);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Bug item `id` is a CONTENT FINGERPRINT, not an ordinal (bug_report/v1 as
 * agreed with the U1 owner, 10-01):
 *     id = lowercase hex sha256( file + "\n" + line + "\n" + kind )
 * with `line` as its decimal integer string. The server recomputes it and
 * refuses a mismatch (422), so the same finding has the same id in every run
 * and two findings can never be collapsed by an ordinal clash.
 */
export function bugFingerprint(file: string, line: number, kind: string): string {
  return createHash('sha256').update(`${file}\n${String(line)}\n${kind}`, 'utf8').digest('hex');
}

export const BugReportBugSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/, 'id must be the 64-char lowercase hex fingerprint'),
    // The rule / finding kind. Part of the fingerprint.
    kind: nonEmpty,
    location: z.object({
      file: nonEmpty,
      line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
    // REQUIRED on every item (U1 owner input 10-01): no per-bug failing test
    // exists upstream, so a missing one must be a loud schema violation.
    failing_test: z.object({
      path: nonEmpty,
      name: nonEmpty,
    }),
    fix_outline: z.array(nonEmpty).min(1),
    // Stored, displayed, NOT hashed.
    severity: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .superRefine((b, ctx) => {
    const want = bugFingerprint(b.location.file, b.location.line, b.kind);
    if (b.id !== want) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: `id is not sha256(file\\nline\\nkind): expected ${want}`,
      });
    }
  });
export type BugReportBug = z.infer<typeof BugReportBugSchema>;

/**
 * `hunt` — did the analyzer actually run, over the WHOLE tracked tree?
 *
 * coding-analysis `bug_hunter.py:78-87` swallows its own errors and returns an
 * EMPTY result ("Analysis failed: …"), so `bugs: []` alone cannot tell a clean
 * tree from a crashed or partial hunt. fr therefore STORES ONLY a hunt that
 * completed over every tracked source file:
 *     status == 'completed'  AND  scanned_files == tracked_source_files
 * Anything else (analyzer_failed, or a partial scan) is refused with 422 and is
 * never stored — an empty list is only an honest result when the hunt saw
 * everything. `hunt` is REQUIRED and part of H_r.
 */
export const HUNT_STATUSES = ['completed', 'analyzer_failed'] as const;
export type HuntStatus = (typeof HUNT_STATUSES)[number];

/**
 * Defence in depth on top of `status`: bug_hunter's crash path returns a
 * COMPLETED job with zero findings and no error_message, and its only trace is
 * the summary's root_cause_analysis = "Analysis failed: …". So a report whose
 * `root_cause_analysis` starts with this prefix is refused even when
 * `status == 'completed'`.
 */
export const ANALYSIS_FAILED_PREFIX = 'Analysis failed: ';

/**
 * Tree-entry kinds a hunt may declare out of scope — exactly coding-analysis
 * `hunt_agent/hunt.py` EXCLUDED_ENTRY_KINDS (symlink = mode 120000, submodule =
 * mode 160000, non_utf8_path = a tracked path that is not valid UTF-8), in the
 * sorted order the agent emits them. A kind outside this set is refused: an
 * exclusion fr cannot name is an exclusion nobody can read.
 */
export const HUNT_EXCLUDED_ENTRY_KINDS = ['non_utf8_path', 'submodule', 'symlink'] as const;
export type HuntExcludedEntryKind = (typeof HUNT_EXCLUDED_ENTRY_KINDS)[number];

/** UTF-16 code-unit order — the order RFC 8785 sorts object keys in. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A JSON array used as a SET: a repeated member is refused, never collapsed. */
function uniqueArray<T extends z.ZodTypeAny>(item: T) {
  return z.array(item).superRefine((xs, ctx) => {
    const seen = new Set<unknown>();
    xs.forEach((x, i) => {
      if (seen.has(x)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: `duplicate entry ${JSON.stringify(x)}` });
      }
      seen.add(x);
    });
  });
}

export const BugReportHuntSchema = z.object({
  status: z.enum(HUNT_STATUSES),
  scanned_files: count,
  tracked_source_files: count,
  // REQUIRED key; `null` is the explicit "no summary text". Raw value from
  // coding-analysis's summary report, part of H_r.
  root_cause_analysis: z.string().nullable(),
  // DECLARED SCOPE — all three REQUIRED and part of H_r (see header). An
  // undeclared scope is an unknown scope, so absence is refused, never defaulted.
  excluded_dirs: uniqueArray(nonEmpty),
  excluded_entry_kinds: uniqueArray(z.enum(HUNT_EXCLUDED_ENTRY_KINDS)),
  // true = the workspace had uncommitted edits that this HEAD scan did NOT see.
  // Not nullable: "unknown" is not a value a stored report may carry.
  worktree_dirty: z.boolean(),
});
export type BugReportHunt = z.infer<typeof BugReportHuntSchema>;

/** `details` of a `report_type: 'bug_report'` report. */
export const BugReportDetailsSchema = z
  .object({
    schema: z.literal(BUG_REPORT_SCHEMA_ID),
    hunt: BugReportHuntSchema,
    repo: nonEmpty,
    commit_sha: nonEmpty,
    // May be empty: a COMPLETE hunt that found nothing is an honest result.
    // What keeps an empty list honest is `hunt`, not a minimum length.
    bugs: z.array(BugReportBugSchema).superRefine((bugs, ctx) => {
      const seen = new Set<string>();
      bugs.forEach((b, i) => {
        if (seen.has(b.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'id'],
            message: `duplicate bug id ${JSON.stringify(b.id)} — the same (file, line, kind) twice in one report`,
          });
        }
        seen.add(b.id);
      });
    }),
  })
  .superRefine((d, ctx) => {
    if (d.hunt.status !== 'completed') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hunt', 'status'],
        message: `hunt.status '${d.hunt.status}': only a completed hunt is stored — a failed hunt is not a result`,
      });
    }
    if (d.hunt.root_cause_analysis?.startsWith(ANALYSIS_FAILED_PREFIX)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hunt', 'root_cause_analysis'],
        message: `hunt.root_cause_analysis starts with ${JSON.stringify(ANALYSIS_FAILED_PREFIX)}: the analyzer crashed, whatever hunt.status says`,
      });
    }
    if (d.hunt.scanned_files !== d.hunt.tracked_source_files) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hunt', 'scanned_files'],
        message: `partial hunt: scanned ${d.hunt.scanned_files} of ${d.hunt.tracked_source_files} tracked source files`,
      });
    }
  });
export type BugReportDetails = z.infer<typeof BugReportDetailsSchema>;

export interface BugReportHashInput {
  tenant_id: string;
  project_id?: string | null;
  card_id: string;
  hunt: BugReportHunt;
  repo: string;
  commit_sha: string;
  bugs: ReadonlyArray<Pick<BugReportBug, 'id' | 'kind' | 'location' | 'failing_test' | 'fix_outline'>>;
}

/** The exact object H_r is the sha256 of (exported so a test can pin it). */
export function bugReportHashBody(input: BugReportHashInput): Record<string, unknown> {
  const bugs = input.bugs
    .map((b) => ({
      id: b.id,
      kind: b.kind,
      location: { file: b.location.file, line: b.location.line },
      failing_test: { path: b.failing_test.path, name: b.failing_test.name },
      fix_outline: [...b.fix_outline],
    }))
    .sort((a, b) => byCodeUnit(a.id, b.id));
  return {
    schema: BUG_REPORT_SCHEMA_ID,
    tenant_id: input.tenant_id,
    project_id: input.project_id ?? null,
    card_id: input.card_id,
    hunt: {
      status: input.hunt.status,
      scanned_files: input.hunt.scanned_files,
      tracked_source_files: input.hunt.tracked_source_files,
      root_cause_analysis: input.hunt.root_cause_analysis,
      // Sets: sorted so the hash is independent of the producer's order.
      excluded_dirs: [...input.hunt.excluded_dirs].sort(byCodeUnit),
      excluded_entry_kinds: [...input.hunt.excluded_entry_kinds].sort(byCodeUnit),
      worktree_dirty: input.hunt.worktree_dirty,
    },
    repo: input.repo,
    commit_sha: input.commit_sha,
    bugs,
  };
}

/** H_r — lowercase hex sha256 of the canonical bug_report/v1 hash body. */
export function bugReportHash(input: BugReportHashInput): string {
  return createHash('sha256').update(canonicalizeJcs(bugReportHashBody(input)), 'utf8').digest('hex');
}

export const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
