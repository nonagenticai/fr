// Frontend mirror of backend/src/types/project-constraints.ts.
//
// ⚠️ describeConstraint() MUST return the SAME strings as the backend's — that
// text is what the agent reads, so the UI preview must show the user exactly
// what will be delivered. ConstraintsEditor.test.ts pins parity per kind.
//
// ── WHAT IS ACTUALLY ENFORCED (MEASURED 2026-09-23) ─────────────────────────
//
// ⭐ THE LANDING GATE IS LIVE. This header said "⛔ Nothing enforces these yet"
// until 2026-09-23, and by then that had been FALSE for some time. It was
// unfalsifiable prose — a claim with no measurement and no file to check it
// against — so it survived, and it cost real work: it made a "zero callers"
// grep look believable and a plan was built on the false negative. Hence the
// rule this comment now follows: state where to look, not just what is true.
//
// WHAT LANDED IT: n8n_custom_nodes PR #1590 (`32295db0`) and PR #1607
// (`0f202ede`). The gate runs in TWO places on the conveyor's merge paths,
// BEFORE the merge, and is FAIL-CLOSED: a violation refuses with
// `merge_refused_constraint_violation`, and an answer the caller cannot read
// refuses with `merge_refused_constraint_check_failed`. Silence is never a pass.
//
// WHAT IT EVALUATES: `POST /api/projects/constraint-check`
// (backend/src/routes/project-constraint-check.ts → services/constraint-check.ts)
// takes `{card_id|project_id, owner, repo, pr_number}` and evaluates the
// constraints against a **PR DIFF**. So it is a PRE-MERGE gate on a pull
// request, nothing else.
//
// ⚠️ WHAT IS STILL NOT TRUE — do not over-correct in the other direction:
// constraints are evaluated AT MERGE TIME ONLY. Nothing checks an outline, a
// plan, a brief or a card against them at authoring time, because no PR exists
// then. A user whose plan violates their own constraint learns it at the merge,
// not while writing it.
//
// ⭐ HOW TO DISPROVE THIS COMMENT rather than trust it — if you suspect it has
// rotted, these are the reads that settle it, in order:
//   1. backend/src/routes/project-constraint-check.ts — does the route exist and
//      still take `pr_number`? If not, the "PR diff" claim above is dead.
//   2. backend/src/services/constraint-check.ts — the rules themselves, and
//      which kinds return `unchecked`.
//   3. backend/src/types/project-constraints.ts `CHECKABLE_KINDS` — the single
//      source of truth mirrored below; project-constraints.parity.test.ts fails
//      if the two lists diverge.
//   4. n8n_custom_nodes: grep for `merge_refused_constraint_violation` and
//      `merge_refused_constraint_check_failed`. ZERO hits in the merge paths
//      means the gate has been unwired and this comment is again false — but
//      run a positive control in the SAME search (e.g. a token you know is
//      there), because a zero from the wrong scope reads exactly like a finding.
//      That is precisely how the previous version of this comment was believed.
//
// `custom` and `must_keep_api_compatible` are still delivered verbatim to the
// agent and checked by nothing; the gate reports them as `unchecked`. For those
// two the UI must say "the agent is told", never "the agent is prevented".

export type ProjectConstraint =
	| { kind: 'no_language_version_change' }
	| { kind: 'pin_language_version'; language: string; version: string }
	| { kind: 'no_dependency_upgrades' }
	| { kind: 'no_new_dependencies' }
	| { kind: 'no_files_touched'; globs: string[] }
	| { kind: 'must_keep_api_compatible' }
	| { kind: 'custom'; text: string };

export type ProjectConstraintKind = ProjectConstraint['kind'];

export type ProjectDependencyKind = 'service' | 'library' | 'api';

export interface ProjectDependency {
	name: string;
	kind: ProjectDependencyKind;
	note?: string;
}

export interface ProjectRisk {
	description: string;
	likelihood?: string;
	impact?: string;
	mitigation?: string;
}

/** Backend limit on `custom.text` (ProjectConstraintSchema). */
export const CUSTOM_CONSTRAINT_MAX = 2000;

export const CONSTRAINT_KINDS: readonly { kind: ProjectConstraintKind; label: string }[] = [
	{ kind: 'no_language_version_change', label: 'Do not change the language version' },
	{ kind: 'pin_language_version', label: 'Pin the language to an exact version' },
	{ kind: 'no_dependency_upgrades', label: 'Do not upgrade existing dependencies' },
	{ kind: 'no_new_dependencies', label: 'Do not add new dependencies' },
	{ kind: 'no_files_touched', label: 'Do not modify these paths' },
	{ kind: 'must_keep_api_compatible', label: 'Keep the public API backwards compatible' },
	{ kind: 'custom', label: 'Custom rule (free text)' }
] as const;

export const DEPENDENCY_KINDS: readonly ProjectDependencyKind[] = ['service', 'library', 'api'];

/**
 * Mirror of the backend's CHECKABLE_KINDS (backend/src/types/project-constraints.ts):
 * the kinds the landing gate (services/constraint-check.ts) actually enforces.
 * must_keep_api_compatible is NOT here — no diff rule can prove it, so the gate
 * reports it as unchecked and the badge must say "not enforced".
 *
 * ⚠️ THIS IS A HAND-COPY, and a hand-copy drifts silently: a kind present here
 * but absent from the backend makes the badge promise enforcement the gate will
 * report as `unchecked`. `project-constraints.parity.test.ts` (beside this file)
 * asserts set equality in BOTH directions against the backend file, so the drift
 * is a red test rather than a lie in the UI. No HTTP route serves this list on
 * purpose — a runtime fetch is a heavier dependency than the problem deserves.
 */
export const MACHINE_CHECKABLE_CONSTRAINT_KINDS = [
	'no_language_version_change',
	'pin_language_version',
	'no_dependency_upgrades',
	'no_new_dependencies',
	'no_files_touched'
] as const;

export function isMachineCheckable(c: ProjectConstraint): boolean {
	return (MACHINE_CHECKABLE_CONSTRAINT_KINDS as readonly string[]).includes(c.kind);
}

/** Identical to the backend's describeConstraint — the text the agent reads. */
export function describeConstraint(c: ProjectConstraint): string {
	switch (c.kind) {
		case 'no_language_version_change':
			return 'Do NOT change the language version.';
		case 'pin_language_version':
			return `Keep ${c.language} pinned at exactly ${c.version}; do not upgrade or downgrade it.`;
		case 'no_dependency_upgrades':
			return 'Do NOT upgrade any existing dependency.';
		case 'no_new_dependencies':
			return 'Do NOT add any new dependency.';
		case 'no_files_touched':
			return `Do NOT modify these paths: ${c.globs.join(', ')}.`;
		case 'must_keep_api_compatible':
			return 'The public API must remain backwards compatible; no breaking changes.';
		case 'custom':
			return c.text;
	}
}
