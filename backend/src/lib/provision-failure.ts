// src/lib/provision-failure.ts
//
// A PROVISION FAILURE THAT NAMES ITSELF.
//
// ── THE DEFECT (fr#1142, measured 2026-09-16 on live `fr` + `kanban`) ───────
//
// `projects` row `328639ef-7b8b-41d4-9e65-d199395ab10a` carried
// `branch = 'aa/arch-refactor-cycle-fixture-v2'` — a fixture branch DELETED by
// ems#147 (`bde79a2`). GitHub answers 404 for it; the control `main` answers 200.
// 556 card chains resolve to that project by ancestry, and every dispatch of one
// re-failed at Station-3 with:
//
//   workspace_withheld:provision_failed: 400 - Validation error: Branch
//   'aa/arch-refactor-cycle-fixture-v2' not found in repository
//   nonagenticai/enterprise_mcp_server
//
// 53 cards were BLOCKED on it on the day it was measured — the single largest
// non-approval cause in the trio's 374 BLOCKED cards. The blocked sweep re-drove
// them into the same 404 (203 re-drive comments).
//
// ── WHAT WAS ACTUALLY WRONG WITH THE REPORTING ──────────────────────────────
//
// `handleProvisionProject` answered `{error: 'provision_failed', message, status}`
// for EVERY upstream failure. `provision_failed` is a family, not a cause: a dead
// coding-github (502), a repo we cannot read, and a branch that no longer exists
// all arrive under one label. The only thing distinguishing them was English
// prose inside `message` — so the ONLY way a consumer could tell "this will never
// succeed, the branch is gone" from "the upstream is sick, retry" was to regex an
// upstream service's sentence at the call site. Nothing did. Hence a permanent
// failure being retried forever by a sweep built to retry transient ones.
//
// ⚠️ THIS IS THE REGEX, MOVED TO ONE PLACE — IT IS NOT A PROOF. Parsing an
// upstream's prose is a weak instrument and it is used here as a CLASSIFIER, not
// as a fact: a positive match adds a machine-readable `code` and the branch/repo
// it read, and a non-match changes nothing. So a coding-github release that
// rewords the sentence degrades this to the status quo ante (generic
// `provision_failed` with the prose intact in `message`) instead of producing a
// WRONG class. That asymmetry is deliberate — see `classifyProvisionFailure`.
//
// ⛔ WHAT THIS DOES NOT DO. It does not check GitHub, does not repoint a branch,
// and does not create one. fr#1142's decision (operator, 2026-09-17) was to
// ARCHIVE the offending row rather than repoint it, precisely because repointing
// to `main` without a work-kind gate would provision ~548 bookkeeping cards for
// ~35 possible deliveries. Naming the failure is the whole job here.
//
// `error` stays `provision_failed` on every branch. It is the stable family
// label a caller already matches (tests/integration/routes/projects.integration
// .test.ts:798 asserts it), and renaming it would break that consumer to say
// something the new `code` field says better.

/** The causes this classifier can name. `generic` = it could not tell. */
export type ProvisionFailureCode =
  /** The named branch does not exist in the repository. Permanent until the row
   * is repointed or archived — retrying cannot fix it. */
  | 'provision_branch_missing'
  /** The repository itself is not reachable/does not exist. Also permanent. */
  | 'provision_repository_missing'
  /** Unclassified. The prose is in `message`; treat as possibly transient. */
  | 'provision_failed';

export interface ProvisionFailureClassification {
  /** Machine-readable cause. */
  code: ProvisionFailureCode;
  /** The branch the upstream named, when it named one. */
  branch?: string;
  /** The repository the upstream named, when it named one (`owner/repo`). */
  repository?: string;
  /**
   * TRUE only for a cause that CANNOT succeed on retry. A sweep that re-drives
   * blocked cards must read this rather than re-deriving it from prose — that
   * re-derivation not happening is what produced 203 re-drive comments against
   * one dead branch.
   */
  permanent: boolean;
  /** One sentence naming the cause and what would change it. */
  detail: string;
}

/**
 * `Branch 'x' not found in repository owner/repo` — coding-github's own wording
 * (`Validation error: Branch '<b>' not found in repository <o>/<r>`), quoted
 * from the live block_reason in fr#1142.
 *
 * Written tolerantly on the BRANCH quoting (single, double, backtick or bare)
 * and strictly on the surrounding words: the literal `not found` must follow the
 * branch token, so an unrelated sentence merely containing the word "branch"
 * cannot match. The repository half is optional — a reworded message that keeps
 * "Branch 'x' not found" but drops the repo still classifies correctly, with
 * `repository` simply absent rather than guessed.
 */
const BRANCH_MISSING_RE =
  /branch\s+(?:'([^']+)'|"([^"]+)"|`([^`]+)`|([^\s'"`]+))\s+(?:was\s+)?not\s+found(?:\s+in\s+(?:the\s+)?repository\s+([^\s,.;]+))?/i;

/**
 * `Repository owner/repo not found` / `repository not found`. Kept SEPARATE from
 * the branch rule and tested after it, because coding-github's branch message
 * contains the word "repository" and a repo-first rule would swallow it.
 */
const REPO_MISSING_RE =
  /repository\s+(?:'([^']+)'|"([^"]+)"|`([^`]+)`|([^\s'"`,.;]+))?\s*(?:was\s+)?not\s+found/i;

function firstDefined(...xs: Array<string | undefined>): string | undefined {
  for (const x of xs) if (typeof x === 'string' && x.trim()) return x.trim();
  return undefined;
}

/**
 * Classify an upstream provisioning failure message.
 *
 * ⭐ THE ASYMMETRY. A match must be positively recognised; nothing is inferred
 * from a non-match. `generic` is therefore the answer for an unreadable message,
 * a reworded upstream, an empty string, a timeout, a 502 — every case where we
 * do not KNOW. That keeps a wrong class impossible: the worst outcome of a
 * regex that stops matching is the behaviour this repo had before the field
 * existed, which is a known, survivable state rather than a confident lie.
 *
 * `fallback` supplies what fr already knows from its own row (the branch it
 * asked for, the repository url it sent). It is used ONLY to fill a field the
 * upstream did not name — it can never create or change a `code`, because fr's
 * row says what fr ASKED for, never what the upstream FOUND.
 */
export function classifyProvisionFailure(
  message: string | null | undefined,
  fallback: { branch?: string | null; repositoryUrl?: string | null } = {},
): ProvisionFailureClassification {
  const text = typeof message === 'string' ? message : '';

  const branchMatch = BRANCH_MISSING_RE.exec(text);
  if (branchMatch) {
    const branch =
      firstDefined(branchMatch[1], branchMatch[2], branchMatch[3], branchMatch[4]) ??
      firstDefined(fallback.branch ?? undefined);
    const repository =
      firstDefined(branchMatch[5]) ?? firstDefined(fallback.repositoryUrl ?? undefined);
    return branchMissing(branch, repository);
  }

  const repoMatch = REPO_MISSING_RE.exec(text);
  if (repoMatch) {
    const repository =
      firstDefined(repoMatch[1], repoMatch[2], repoMatch[3], repoMatch[4]) ??
      firstDefined(fallback.repositoryUrl ?? undefined);
    return repositoryMissing(repository);
  }

  return {
    code: 'provision_failed',
    permanent: false,
    detail:
      'provisioning failed and the cause could not be classified from the upstream ' +
      'message; it may be transient. The upstream text is preserved verbatim in ' +
      '`message` — read it before retrying.',
  };
}

function branchMissing(
  branch: string | undefined,
  repository: string | undefined,
): ProvisionFailureClassification {
  return {
    code: 'provision_branch_missing',
    ...(branch ? { branch } : {}),
    ...(repository ? { repository } : {}),
    permanent: true,
    detail:
      `the branch${branch ? ` "${branch}"` : ''} does not exist in ` +
      `${repository ?? 'the repository'}. Provisioning cannot succeed until the ` +
      "project's `branch` names a branch that exists, or the project is archived. " +
      'Re-driving this card will produce the identical failure.',
  };
}

function repositoryMissing(repository: string | undefined): ProvisionFailureClassification {
  return {
    code: 'provision_repository_missing',
    ...(repository ? { repository } : {}),
    permanent: true,
    detail:
      `the repository${repository ? ` ${repository}` : ''} could not be found. ` +
      "Provisioning cannot succeed until the project's `repository_url` names a " +
      'repository fr can read. Re-driving this card will produce the identical failure.',
  };
}

/**
 * The classification a NON-super-admin caller may see. `code` and `permanent`
 * are kept (the AA sweep keys on them); every field the classifier READ from
 * the upstream's sentence is replaced by what fr's own row says (the branch and
 * repository fr ASKED for), so no upstream-authored text reaches the browser.
 * The generic class no longer points at `message`, which is redacted too.
 */
export function clientSafeProvisionFailure(
  c: ProvisionFailureClassification,
  fallback: { branch?: string | null; repositoryUrl?: string | null } = {},
): ProvisionFailureClassification {
  const branch = firstDefined(fallback.branch ?? undefined);
  const repository = firstDefined(fallback.repositoryUrl ?? undefined);
  if (c.code === 'provision_branch_missing') return branchMissing(branch, repository);
  if (c.code === 'provision_repository_missing') return repositoryMissing(repository);
  return {
    code: 'provision_failed',
    permanent: false,
    detail: 'provisioning failed and the cause could not be classified; it may be transient — try again.',
  };
}
