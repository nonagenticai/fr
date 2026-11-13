#!/usr/bin/env bun
//
// Void a named set of approvals from INSIDE the pod, with no bearer token.
//
// ── Why this exists ────────────────────────────────────────────────────────
// Measured 2026-09-05: 240 pending approvals carry zero `required_approvers`,
// no `gate_terms` and no producer rationale — unanswerable by construction,
// 192 of them holding a card in BLOCKED. The mechanism to withdraw them
// already exists as POST /api/approvals/void, but that route is gated on the
// `super_admin` Keycloak realm role, and the operator has decided not to hand
// out a super-admin bearer token to clear a backlog. This script is the
// narrower door: same transaction, same schema, same safety properties, no
// interactive token.
//
// ⛔ THIS IS NOT A BACKDOOR — and must never become one.
//   * It can only ever set `status='voided'`. It inherits that from calling
//     `lib/void-approvals.ts :: voidApprovals`, which is the ONE
//     implementation of the transaction and hard-codes that single status.
//     Do not add another status path here, do not add a filter-driven
//     selection ("void everything pending with no rationale"), and do not add
//     an "update arbitrary field" capability. If you find yourself needing
//     any of those, you are writing a different tool — write it somewhere
//     else, under its own review.
//   * It writes NO `approval_decisions` row, so nothing it does can ever look
//     like a human answered the question. Again: inherited, not re-decided
//     here.
//   * It does NOT weaken the HTTP route's `super_admin` gate. That gate
//     answers "may this NETWORK caller void?" — a bearer token can be
//     forwarded, replayed, or held by anyone the token reached. This file
//     answers a different question, and its gate is stronger: you must have
//     shell access to the running fr-backend pod (kubectl exec, i.e. cluster
//     RBAC on the namespace) to run it at all. An operator who can exec into
//     the pod can already read every secret it holds and talk to the database
//     directly; a `bun run` that can only flip pending→voided with a
//     mandatory recorded reason is a strictly narrower capability than the
//     shell they already have.
//
// ── Safety posture ─────────────────────────────────────────────────────────
//   * DRY RUN IS THE DEFAULT. Writing requires an explicit `--execute`. A
//     caller that forgets every flag gets a report, never a write. `--dry-run`
//     exists as an explicit no-op so an operator can write the safe intent out
//     loud; passing both is refused rather than silently resolved.
//   * Ids only, never a filter — from `--ids-file <path>` (one uuid per line),
//     `--ids-file -` (the same format, read from stdin), or `--ids a,b,c`.
//     There is no way to ask this script "which ones?".
//   * `--reason` is mandatory and >=10 chars, enforced by the SAME zod schema
//     the HTTP route uses (`VoidApprovalsSchema`), so the two cannot diverge
//     on what counts as a valid void.
//   * `--actor` is mandatory. `approvals.voided_by` is TEXT and free-text by
//     design (migration 110: "an operator/user identifier, not a
//     decision-maker, mirroring `triage_actor`'s free-text shape"), so no user
//     record and no FK is involved — the string is stored verbatim. Name a
//     human or a ticket, not "script".
//   * Every id supplied gets a reported outcome, re-expanded over the ORIGINAL
//     (possibly duplicate) list, plus a per-outcome tally and a total — so the
//     output reconciles line-for-line against the manifest that produced it.
//   * A stale manifest FAILS LOUDLY: on an `--execute` run, any `not_found` or
//     `skipped_not_pending` id exits non-zero (EXIT_STALE_IDS). A dry run
//     reports the same ids but exits 0 — reporting is its whole job.
//
// ── ⛔ The pod filesystem is READ-ONLY, so a PATH is not an option ──────────
// Measured in the running fr-backend pod, 2026-09-06:
//
//   $ kubectl -n fr exec <pod> -c fr-backend -- sh -c "cat > /tmp/void-ids.txt"
//   sh: 1: cannot create /tmp/void-ids.txt: Read-only file system
//
// There is nowhere in that pod to put a manifest — `/tmp` included. So the
// `--ids-file /tmp/unanswerable.txt` form this file originally documented is
// DEAD ON ARRIVAL in the only environment the script exists for, and the first
// real run had to fall back to `--ids` with 240 uuids as an 8,879-character
// argv string. `--ids-file -` exists for that: it reads the SAME one-uuid-per-
// line manifest from stdin, so no writable path is needed and there is no argv
// length ceiling. A path is still accepted, for a local run against a dev
// database where the filesystem is writable.
//
// Usage in the pod — ⚠️ the app root is `/app`, NOT `/app/backend`, so the
// script is at `/app/src/scripts/void-approvals.ts`:
//
//   # pipe the manifest in from outside the cluster. ⚠️ `exec -i` is load
//   # bearing: without it the pod gets a closed stdin and the run fails with
//   # "no ids on stdin" rather than voiding anything.
//   kubectl -n fr exec -i <pod> -c fr-backend -- \
//     bun /app/src/scripts/void-approvals.ts --ids-file - \
//     --reason "unanswerable by construction: no approvers, no gate_terms" \
//     --actor "george@nonagentic.ai" < unanswerable.txt        # DRY RUN
//
//   kubectl -n fr exec -i <pod> -c fr-backend -- \
//     bun /app/src/scripts/void-approvals.ts --ids-file - \
//     --reason "unanswerable by construction: no approvers, no gate_terms" \
//     --actor "george@nonagentic.ai" --execute < unanswerable.txt   # WRITES
//
//   # no stdin needed, but small batches only — argv has a length ceiling
//   bun /app/src/scripts/void-approvals.ts --ids a,b,c \
//     --reason "..." --actor "..."
//
// Also wired as a package script — note the `--`, without which bun eats the
// flags rather than forwarding them. Run it from the app root:
//   bun run void:approvals -- --ids-file - \
//     --reason "..." --actor "..." --execute < unanswerable.txt
//
// Exit codes: 0 = clean, 1 = hard error (bad argv, schema rejection, DB
// failure), 2 = EXIT_STALE_IDS (an --execute run met an id that was absent or
// no longer pending).

import {
  VoidApprovalsSchema,
  voidApprovals,
  emptyVoidCounts,
  type VoidOutcome,
} from '../lib/void-approvals';

/** A stale id list on an `--execute` run. Distinct from 1 (a hard error). */
export const EXIT_STALE_IDS = 2;

export interface VoidCliArgs {
  ids: string[];
  reason: string;
  actor: string;
  /** TRUE unless `--execute` was passed. Never inferred from anything else. */
  dryRun: boolean;
  /** A path, or `-` for stdin (see STDIN_SENTINEL). */
  idsFile?: string;
}

/**
 * `--ids-file -` means "read the manifest from stdin".
 *
 * A single dash rather than a separate `--ids-stdin` flag, because it keeps ONE
 * id-source flag: `--ids-file` and `--ids` are already mutually exclusive and
 * one of them is already mandatory, and adding a third source would mean a
 * three-way exclusivity check nobody would get right at 3am. `-` is also the
 * convention every operator already knows from `tar`/`git apply`/`kubectl -f -`.
 *
 * NB `readFlag` refuses a value starting with `--` (that is a missing value),
 * but a bare `-` is not `--`, so `--ids-file -` parses as intended.
 */
export const STDIN_SENTINEL = '-';

/**
 * Pull `--flag value` / `--flag=value` out of argv.
 *
 * Returns undefined when absent so the caller can distinguish "not supplied"
 * from "supplied empty" — an empty `--reason` must fail the schema, not be
 * silently treated as missing.
 */
export function readFlag(
  argv: readonly string[],
  flag: string,
): string | undefined {
  const prefix = `${flag}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === flag) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag}: expected a value`);
      }
      return next;
    }
  }
  return undefined;
}

/**
 * One uuid per line. Blank lines and `#` comments are ignored so a manifest
 * can carry provenance ("# from the 2026-09-05 unanswerable census") next to
 * the ids it authorises. Inline trailing comments are NOT stripped — an id is
 * a whole line, and half-parsing a line is how you void the wrong row.
 *
 * The name says "file", but this is the manifest format, not the transport: a
 * path and stdin (`--ids-file -`) both land here, through the ONE call in
 * `resolveIds`. Do not add a second parser for stdin — a manifest that means
 * one thing on disk and another through a pipe is a way to void the wrong row.
 */
export function parseIdsFile(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** Split `--ids a,b,c`. Empty segments are dropped; the schema rejects the rest. */
export function parseIdsList(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function parseArgs(argv: readonly string[]): Omit<VoidCliArgs, 'ids'> & {
  ids?: string[];
} {
  const execute = argv.includes('--execute');
  const explicitDryRun = argv.includes('--dry-run');
  if (execute && explicitDryRun) {
    // Refused rather than resolved. Whichever way we picked, half the readers
    // of this command line would have guessed the other one.
    throw new Error('--execute and --dry-run are mutually exclusive');
  }

  const reason = readFlag(argv, '--reason');
  if (reason === undefined) throw new Error('--reason is required');
  const actor = readFlag(argv, '--actor');
  if (actor === undefined || actor.trim() === '') {
    throw new Error(
      '--actor is required — it is recorded verbatim in approvals.voided_by',
    );
  }

  const idsFile = readFlag(argv, '--ids-file');
  const idsCsv = readFlag(argv, '--ids');
  if (idsFile !== undefined && idsCsv !== undefined) {
    throw new Error('pass either --ids-file or --ids, not both');
  }
  if (idsFile === undefined && idsCsv === undefined) {
    throw new Error('one of --ids-file or --ids is required');
  }

  return {
    ids: idsCsv === undefined ? undefined : parseIdsList(idsCsv),
    idsFile,
    reason,
    actor: actor.trim(),
    // ⛔ dryRun is TRUE unless --execute was passed explicitly.
    dryRun: !execute,
  };
}

/**
 * Turn a parsed argv into the actual id list, reading stdin or the file if that
 * is where the ids live.
 *
 * Only the ACQUISITION of the text branches; `parseIdsFile` is called ONCE,
 * below both branches, so the stdin and path forms cannot drift on what a line
 * means.
 */
export async function resolveIds(
  parsed: Pick<VoidCliArgs, 'idsFile'> & { ids?: string[] },
): Promise<string[]> {
  if (parsed.ids !== undefined) return parsed.ids;

  const source = parsed.idsFile as string;
  const fromStdin = source === STDIN_SENTINEL;
  // `Bun.stdin.text()` rather than a node:stream read: bun is the runtime here
  // (the shebang, the package script, and the in-pod invocation all say `bun`),
  // it consumes the stream to EOF in one await with no partial-chunk handling to
  // get wrong, and it mirrors the `Bun.file(...).text()` already used for the
  // path case — one API, two sources.
  const text = await (fromStdin ? Bun.stdin.text() : Bun.file(source).text());
  const ids = parseIdsFile(text);

  // ⛔ An empty manifest is an ERROR, never an empty-set run. `total=0
  // wouldVoid=0 exitCode=0` reads as "clean, nothing to do" — indistinguishable
  // from a successful sweep — so a forgotten `exec -i` (closed stdin), a typo'd
  // redirect, or a manifest that was all comments would silently look like the
  // job was done. Refuse instead, and name which source was empty.
  if (ids.length === 0) {
    throw new Error(
      fromStdin
        ? 'no ids on stdin — `--ids-file -` read 0 uuids. Did you forget ' +
          '`kubectl exec -i` (which leaves stdin closed) or the `< file` redirect?'
        : `no ids in ${source} — the file parsed to 0 uuids (blank, or all comments)`,
    );
  }

  return ids;
}

export interface VoidCliReport {
  dryRun: boolean;
  /** One entry per id in the ORIGINAL list, duplicates included. */
  results: { id: string; outcome: VoidOutcome }[];
  counts: Record<VoidOutcome, number>;
  total: number;
  exitCode: number;
}

/** Run the void and build the report; the caller below owns the process exit. */
export async function runVoidApprovalsCli(args: VoidCliArgs): Promise<VoidCliReport> {
  // The SAME schema the HTTP route parses its body with. Parsing here rather
  // than trusting argv means the CLI cannot accept a void the route would
  // reject (a 9-char reason, a non-uuid id, a 501-id batch).
  const validated = VoidApprovalsSchema.parse({
    ids: args.ids,
    reason: args.reason,
    dryRun: args.dryRun,
  });

  const outcomeById = await voidApprovals({
    ids: validated.ids,
    reason: validated.reason,
    dryRun: validated.dryRun,
    actor: args.actor,
    // fr row 14d ruling "void: platform rows only" — same as the super-admin
    // HTTP route (routes/approval-void.ts). A customer-tenant id reports
    // `not_found` and is never written; on --execute that is a stale-id exit.
    platformOnly: true,
  });

  // Re-expand over the ORIGINAL (possibly duplicate) list — every id the
  // operator supplied gets a reported outcome, including repeats, so the total
  // below equals the manifest's line count.
  const results = validated.ids.map((id) => ({
    id,
    outcome: outcomeById.get(id)!,
  }));

  const counts = emptyVoidCounts();
  for (const r of results) counts[r.outcome] += 1;

  for (const r of results) console.log(`[approval] id=${r.id} outcome=${r.outcome}`);

  // A stale id list must be visible without reading 240 per-row lines.
  const stale = counts.not_found + counts.skipped_not_pending;
  const exitCode = !validated.dryRun && stale > 0 ? EXIT_STALE_IDS : 0;

  console.log(
    `[done] dryRun=${validated.dryRun} ` +
      `actor="${args.actor}" ` +
      `total=${results.length} ` +
      `wouldVoid=${counts.would_void} ` +
      `voided=${counts.voided} ` +
      `skippedNotPending=${counts.skipped_not_pending} ` +
      `notFound=${counts.not_found} ` +
      `exitCode=${exitCode}`,
  );
  if (validated.dryRun) {
    console.log('[dry-run] NOTHING WAS WRITTEN. Re-run with --execute to apply.');
  }
  if (exitCode !== 0) {
    console.log(
      `[stale] ${stale} of ${results.length} ids were not voidable ` +
        '(already decided/expired/voided, or absent). The manifest is out of ' +
        'date — re-derive it before assuming the remainder is complete.',
    );
  }

  return {
    dryRun: validated.dryRun,
    results,
    counts,
    total: results.length,
    exitCode,
  };
}

if (import.meta.main) {
  const main = async (): Promise<number> => {
    const parsed = parseArgs(process.argv.slice(2));
    const ids = await resolveIds(parsed);
    const report = await runVoidApprovalsCli({
      ids,
      reason: parsed.reason,
      actor: parsed.actor,
      dryRun: parsed.dryRun,
    });
    return report.exitCode;
  };

  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(
        '[error]',
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      process.exit(1);
    });
}
