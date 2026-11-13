<script lang="ts" module>
	import type {
		ProjectCreate,
		ProjectMilestone,
		ProjectRisk,
		ProjectShape,
		ApprovalMode
	} from '$lib/types/api';
	import { DEFAULT_APPROVAL_MODE } from '$lib/types/api';
	import type { AssetKind } from '$lib/api/bindings';
	import type { ProjectConstraint, ProjectDependency } from '$lib/types/project-constraints';
	import {
		emptyRepoRow,
		type RepoRow
	} from '$lib/components/project-request/RepositoryRepeater.svelte';

	// The flat form-state shape (distinct from the ProjectCreate wire payload —
	// e.g. repo fields are flattened, env is a record). Exported so the project-
	// request review page can build a typed `initial` from a stored payload.
	/** A package to upgrade, and the version to upgrade it TO. */
	export interface TargetPackage {
		name: string;
		target_version: string;
	}

	/**
	 * One repository holding code to rewrite (it_flow 'rewrite'). `pin` is the exact
	 * version read — a full commit SHA or a GitHub PR (George 2026-11-07) — so later
	 * pushes cannot change what is rewritten. The backend resolves a PR to its head
	 * commit; the wire key stays `sha` on the RM side.
	 */
	export interface RewriteSourceRow {
		url: string;
		branch: string;
		pin: string;
	}

	export function emptyRewriteSource(): RewriteSourceRow {
		return { url: '', branch: '', pin: '' };
	}

	export interface ProjectFormState {
		shape: ProjectShape;
		name: string;
		description: string;
		project_type: string;
		scope_level: string;
		approvers: string[];
		problem_statement: string;
		desired_outcome: string;
		business_case: string;
		success_criteria: string[];
		acceptance_criteria: string[];
		/**
		 * The four project-definition scope lists. Re-added to the form
		 * 2026-09-23: they were dropped when an exhaustive grep found ZERO
		 * backend readers, and `scopeFieldsForBrief` / `BRIEF_SCOPE_FIELDS`
		 * (backend/src/routes/projects.ts) now delivers all four into BOTH agent
		 * briefs. Until this the only writers were direct API callers (n8n / the
		 * CP bridge) and a human could not set them at all.
		 */
		in_scope: string[];
		out_of_scope: string[];
		high_level_requirements: string[];
		assumptions: string[];
		/**
		 * N repositories, exactly one primary. Replaces the old single
		 * `repo_url` / `repo_branch` pair: the form offered a `multi_repo` scope
		 * level and gave the user one repository field to express it with.
		 */
		repositories: RepoRow[];
		/**
		 * How the named repositories relate to each other — `coordinated` (they
		 * are one product, so a single unit of work may span them) or
		 * `independent` (each repository is its own stream of work).
		 *
		 * ⚠️ Only MEANINGFUL, and only ASKED, with two or more repositories: the
		 * control is hidden below that and `buildPayload` omits the key, because a
		 * coordination mode on a single repository is a claim the user was never
		 * given the chance to make. Defaults to `coordinated` — the safe reading,
		 * since treating one product as separate workstreams splits work that has
		 * to land together.
		 */
		coordination_mode: string;
		/**
		 * NON-REWRITE `it` only: an optional repository the project's NEW code goes
		 * to, when it writes somewhere other than (or as well as) the repositories
		 * named above. Flattened here, never a wire key: `buildPayload` folds it
		 * into `repo` with role 'target' — the primary when no other repository is
		 * named, otherwise the last `repo.additional` row. A rewrite does not use
		 * it (it has its own target repository), and no other project type asks.
		 */
		output_repo_url: string;
		/** The output repository's branch. Empty ⇒ the payload omits the branch (or uses 'main' when it is the primary). */
		output_repo_branch: string;
		// IT remediation inputs — only meaningful when project_type === 'it'.
		// test_command / bug_test_command are held as free text here and parsed to
		// ARGV on submit (the wire format is a string[]); see parseArgv.
		it_flow: string;
		cve_sweep: boolean;
		/**
		 * Bug HUNT (it_flow === 'bug' only): no failing test is known yet. When
		 * true the form sends `test_command` (the repo's suite command) and omits
		 * bug_test_command / failing_test_ref / bug_description. EXEC tenant only
		 * — the backend refuses it elsewhere (400 bug_hunt_exec_only).
		 */
		bug_hunt: boolean;
		/**
		 * ⚠️ {name, target_version}, NOT string[]. The backend has demanded
		 * `z.array(z.object({name, target_version}))` all along
		 * (types/api.ts), and this form sent bare strings — so EVERY IT
		 * dependency project created with a named package 422'd. It went
		 * unnoticed because cve_sweep:true lets the array be empty, and
		 * discovery mode is the path people actually used.
		 */
		target_packages: TargetPackage[];
		test_command: string;
		bug_test_command: string;
		/**
		 * The bug report text — what is actually wrong, in prose.
		 *
		 * ⚠️ This was a SHAPE-B defect: `bug_analysis` and `development_bug_fix`
		 * both read `dispatch_context.bug_description`, and
		 * `ProjectCreateSchema` has declared `bug_description` all along
		 * (backend/src/types/api.ts), but no control anywhere collected it — so
		 * every bug project reached the analysis card with the key EMPTY. A
		 * declared-and-read key with no writer looks identical, on both sides of
		 * the wire, to a key nobody wanted.
		 */
		bug_description: string;
		failing_test_ref: string;
		target_files: string[];
		min_severity: string;
		/**
		 * REWRITE flow (it_flow === 'rewrite') only. Sent as `repo.additional[]`
		 * rows with role 'source' + sha, and the target as the primary repository
		 * with role 'target'; the ordinary repository rows are not used for it.
		 * Every value lives on the project record, never in fr's own copy.
		 */
		rewrite_sources: RewriteSourceRow[];
		rewrite_target_url: string;
		/**
		 * The target language is NOT asked (George 2026-11-07): the backend extracts it
		 * from the project request when a rewrite create omits it.
		 */
		/**
		 * Which conveyor sign-offs the user is asked for (any flow). 'brief_and_closure'
		 * is the default (George 2026-10-31, R329), and the chosen value is
		 * ALWAYS sent as `approval_mode` — 'all' included, so a user can choose it.
		 */
		approval_mode: ApprovalMode;
		constraints: ProjectConstraint[];
		dependencies: ProjectDependency[];
		risks: ProjectRisk[];
	}

	export type BoundAssetsState = Record<AssetKind, string[]>;

	/** The instance state buildPayload used to reach through its closure. */
	export interface BuildPayloadContext {
		boundAssets: BoundAssetsState;
	}

	export function emptyFormState(): ProjectFormState {
		return {
			shape: 'deliverable',
			name: '',
			description: '',
			project_type: '',
			scope_level: '',
			approvers: [],
			problem_statement: '',
			desired_outcome: '',
			business_case: '',
			success_criteria: [],
			acceptance_criteria: [],
			in_scope: [],
			out_of_scope: [],
			high_level_requirements: [],
			assumptions: [],
			repositories: [{ ...emptyRepoRow(), is_primary: true }],
			coordination_mode: 'coordinated',
			output_repo_url: '',
			output_repo_branch: '',
			it_flow: 'dependency',
			cve_sweep: false,
			bug_hunt: false,
			target_packages: [],
			test_command: '',
			bug_test_command: '',
			bug_description: '',
			failing_test_ref: '',
			target_files: [],
			min_severity: 'HIGH',
			rewrite_sources: [emptyRewriteSource()],
			rewrite_target_url: '',
			approval_mode: DEFAULT_APPROVAL_MODE,
			constraints: [],
			dependencies: [],
			risks: [],
		};
	}

	export function emptyBoundAssets(): BoundAssetsState {
		return {
			requirement: [],
			principle: [],
			decision: [],
			kag_document: [],
			workflow: [],
			trigger: [],
			channel: [],
			artifact: []
		};
	}

	/**
	 * Parse a typed command into the ARGV array the backend expects
	 * (`test_command: ["pytest", "-q"]`). Honours single/double quotes so
	 * `pytest -k "foo bar"` yields 3 items, not 4 — a naive whitespace split
	 * would silently ship a broken command that only fails much later, inside the
	 * container, looking like a test failure rather than a form bug.
	 */
	export function parseArgv(input: string): string[] {
		const out: string[] = [];
		let cur = '';
		let quote: '"' | "'" | null = null;
		let has = false;
		for (const ch of input) {
			if (quote) {
				if (ch === quote) quote = null;
				else cur += ch;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				has = true;
				continue;
			}
			if (/\s/.test(ch)) {
				if (has || cur) out.push(cur);
				cur = '';
				has = false;
				continue;
			}
			cur += ch;
		}
		if (has || cur) out.push(cur);
		return out;
	}

	/** The it_flow values that carry their OWN remediation inputs (no target_packages). */
	const REMEDIATION_FLOWS = new Set(['bug', 'security', 'source-security', 'iac', 'refactor', 'rewrite']);

	/** A full commit hash: exactly 40 hex characters (format only — the project store judges the rest). */
	export const COMMIT_SHA_RE = /^[0-9a-fA-F]{40}$/;
	/** A GitHub PR: `123`, `#123`, or a PR URL. The backend resolves it to its head commit. */
	export const PR_NUMBER_RE = /^#?\d{1,10}$/;
	export const PR_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d{1,10}\/?$/i;

	/**
	 * A repository pin (George 2026-11-07): the exact version to take as input.
	 * A full commit SHA or a GitHub PR. Format only — resolution is the backend's job.
	 */
	export function isRepoPin(value: string): boolean {
		const v = value.trim();
		return COMMIT_SHA_RE.test(v) || PR_NUMBER_RE.test(v) || PR_URL_RE.test(v);
	}

	/**
	 * True when the form describes a rewrite project: an `it` project whose flow
	 * is `rewrite`. ⛔ There is no project-type allowlist here — `py2rust` was one
	 * until RM retired it, and RM's catalogue is the only authority on which types
	 * exist (the picker offers whatever RM reports as startable).
	 */
	export function isRewriteForm(form: { project_type: string; it_flow: string }): boolean {
		return form.project_type === 'it' && form.it_flow === 'rewrite';
	}

	/** Every repository URL a rewrite names: the target first, then each source. */
	export function rewriteRepositoryUrls(
		form: Pick<ProjectFormState, 'rewrite_sources' | 'rewrite_target_url'>
	): string[] {
		return [form.rewrite_target_url, ...form.rewrite_sources.map((r) => r.url)]
			.map((u) => u.trim())
			.filter(Boolean);
	}

	/**
	 * Client-side FORMAT checks for a rewrite (fr facilitates, the project store
	 * decides): the rows the payload needs exist and each source pins a commit SHA or
	 * a PR. The target language is not asked — the backend reads it from the request.
	 */
	export function validateRewriteInputs(
		form: Pick<ProjectFormState, 'rewrite_sources' | 'rewrite_target_url'>
	): string | null {
		const sources = form.rewrite_sources.filter((r) => r.url.trim());
		if (sources.length === 0) {
			return 'For a rewrite, add at least one repository with the code to rewrite.';
		}
		const badPin = sources.find((r) => !isRepoPin(r.pin ?? ''));
		if (badPin) {
			return `For a rewrite, every source repository needs a pinned version — a full 40-character commit SHA or a PR number (missing or invalid for ${badPin.url.trim()}).`;
		}
		if (!form.rewrite_target_url.trim()) {
			return 'For a rewrite, enter the repository the rewritten code should go to.';
		}
		return null;
	}

	/**
	 * The it_flow values whose spawned cards actually READ `min_severity`.
	 *
	 * ⚠️ NOT the same set as REMEDIATION_FLOWS, which is what it was gated on
	 * until 2026-10-01 — so the form asked for a severity floor on the `bug` and
	 * `refactor` flows, where nothing consumes it. MEASURED against the live
	 * dispatch source (`n8n_custom_nodes/AA_IMPLEMENTATION/doing_action_procedures.json`):
	 * `min_severity` appears in exactly three procedures — `security_analysis`
	 * (`|| "HIGH"`), `development_security_patch` (`|| "HIGH"`) and
	 * `development_chore` (`|| "LOW"`). It appears ZERO times in `bug_analysis`,
	 * `development_bug_fix` and `architecture_refactoring`, which are the cards
	 * `bug` and `refactor` spawn. A control whose value no consumer reads teaches
	 * the user their answer mattered; it is worse than no control.
	 *
	 * ⭐ `dependency` IS IN THIS SET — added 2026-10-02, closing fr#1335. The gap
	 * it closes: `development_chore` is the card the dependency flow spawns and
	 * the one a `cve_sweep` discovery run drives, and it reads `min_severity`
	 * with a `|| "LOW"` fallback (backend/src/scripts/seed-it-procedures.ts:448).
	 * Until now neither this set nor `buildPayload` sent the key for
	 * `dependency`, so EVERY CVE sweep ever run executed at that `"LOW"` floor
	 * and no control anywhere could raise it — a sweep the operator believed was
	 * scoped to HIGH/CRITICAL was in fact unfiltered. The floor is the one knob
	 * deciding how much work a discovery sweep mints, so a silent default was
	 * never harmless: it is the difference between a handful of cards and a
	 * backlog nobody asked for.
	 *
	 * ⛔ `bug` and `refactor` stay OUT. `bug_analysis`, `development_bug_fix` and
	 * `architecture_refactoring` contain the key ZERO times; the control is
	 * hidden for them and `buildPayload` omits it.
	 */
	const SEVERITY_FLOWS = new Set(['dependency', 'security', 'source-security', 'iac']);

	/**
	 * Client-side mirror of the backend's IT guards (backend/src/routes/projects.ts
	 * `assertItProjectInputs`). Returns an error string, or null when valid.
	 *
	 * This exists so the user sees the problem in the form instead of a 422 after
	 * submit. The backend remains the authority — this must never be laxer than it.
	 */
	/**
	 * A ref coding-containers treats as a commit sha and FULL-clones (exposing
	 * history). Mirrors backend GIT_SHA_LIKE_REF_RE (routes/projects.ts), which
	 * itself mirrors the provisioner's `_GIT_SHA_RE` — keep all three identical.
	 */
	export const GIT_SHA_LIKE_REF_RE = /^[0-9a-fA-F]{7,40}$/;

	export function validateItInputs(form: {
		project_type: string;
		it_flow: string;
		cve_sweep: boolean;
		target_packages: TargetPackage[];
		bug_test_command: string;
		bug_hunt?: boolean;
		test_command?: string;
		repositories?: { url: string; branch: string; pin?: string }[];
		rewrite_sources?: RewriteSourceRow[];
		rewrite_target_url?: string;
	}): string | null {
		if (isRewriteForm(form)) {
			return validateRewriteInputs({
				rewrite_sources: form.rewrite_sources ?? [],
				rewrite_target_url: form.rewrite_target_url ?? ''
			});
		}
		if (form.project_type !== 'it') return null;
		// A repository is optional for a project, but not for a CVE sweep — mirrors the
		// backend's 422 repository_required_for_cve_sweep (assertRepositoryForRepoFeatures).
		if (form.cve_sweep && form.repositories && !form.repositories.some((r) => r.url.trim())) {
			return "For a CVE sweep, a repository is required (the sweep upgrades its dependencies).";
		}
		if (!REMEDIATION_FLOWS.has(form.it_flow)) {
			// dependency flow: needs explicit targets, or discovery mode
			if (!form.cve_sweep && form.target_packages.length === 0) {
				return 'For an IT dependency upgrade, add at least one target package — or enable CVE sweep to run a discovery scan instead.';
			}
		}
		if (form.it_flow === 'bug' && form.bug_hunt) {
			// Hunt mode — mirrors backend assertItExecIntakeInputs' bug_hunt rules.
			// (bug_test_command is hidden and never sent, so it is not checked here.)
			if (!parseArgv(form.test_command ?? '').some((a) => a.trim().length > 0)) {
				return "For a bug hunt, the test suite command is required (the repo's ordinary test command; it need not fail).";
			}
			// Same rows buildPayload sends: named rows only; a blank primary branch becomes 'main'.
			const shaLike = (form.repositories ?? [])
				.filter((r) => r.url.trim())
				.map((r) => r.branch.trim())
				.find((b) => GIT_SHA_LIKE_REF_RE.test(b));
			if (shaLike !== undefined) {
				return `For a bug hunt, every repository branch must be a branch NAME, not a commit sha ("${shaLike}").`;
			}
			// A repository is optional for a project, but not for a hunt — mirrors the
			// backend's 422 repository_required_for_bug_hunt.
			if (form.repositories && !form.repositories.some((r) => r.url.trim())) {
				return 'For a bug hunt, a repository is required (the hunt runs its test suite).';
			}
			return null;
		}
		if (form.it_flow === 'bug' && parseArgv(form.bug_test_command).length === 0) {
			return 'For an IT bug fix, the currently-failing test command is required (e.g. pytest -q tests/test_foo.py).';
		}
		return null;
	}

	/**
	 * The four project-definition scope lists, in the order they are rendered.
	 * Mirrors `BRIEF_SCOPE_FIELDS` (backend/src/routes/projects.ts) — the reader
	 * that consumes them — so the writer and the reader cannot drift apart
	 * silently. Also drives the Section 4 editors, reusing the same
	 * add/remove/list pattern as success_criteria / acceptance_criteria.
	 */
	export const SCOPE_FIELD_KEYS = [
		'in_scope',
		'out_of_scope',
		'high_level_requirements',
		'assumptions'
	] as const;

	export type ScopeFieldKey = (typeof SCOPE_FIELD_KEYS)[number];

	/**
	 * The scope keys for the wire payload, each present ONLY when it holds at
	 * least one non-blank entry.
	 *
	 * ⚠️ OMIT, never `[]`, and never a list of blanks. The backend reader
	 * (`scopeFieldsForBrief`) omits an empty key deliberately: `"out_of_scope":
	 * []` is the positive claim "the requester was asked and said nothing is out
	 * of scope", which is DIFFERENT from — and false where — the requester
	 * simply did not answer. Sending `[]` would make an unanswered question look
	 * answered in every agent brief. Blank/whitespace entries are trimmed away
	 * for the same reason: a list of empty strings has nothing in it to tell an
	 * agent, and the reader would drop them anyway, so keeping them here would
	 * only make the key look populated on this side of the wire.
	 */
	export function scopeFieldsForPayload(
		form: Pick<ProjectFormState, ScopeFieldKey>
	): Partial<Pick<ProjectCreate, ScopeFieldKey>> {
		const out: Partial<Record<ScopeFieldKey, string[]>> = {};
		for (const key of SCOPE_FIELD_KEYS) {
			const items = (form[key] ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
			if (items.length > 0) out[key] = items;
		}
		return out;
	}

	/**
	 * Build the ProjectCreate wire payload from form state.
	 *
	 * Extracted from the instance script to module scope, unchanged in behaviour,
	 * so it can be characterised by test BEFORE any field is deleted from this
	 * form. That ordering is the whole point: a deletion that drops a LIVE field
	 * looks exactly like one that drops a dead field, and the only thing that can
	 * tell them apart is a test that pinned the payload beforehand.
	 *
	 * The five values it used to close over are now explicit parameters — a
	 * closure is not testable, and "is it computed?" and "is it consumed?" are
	 * different questions.
	 */
	export function buildPayload(
		form: ProjectFormState,
		ctx: BuildPayloadContext
	): ProjectCreate {
		// The primary row is the project's repository_url; every other named row
		// becomes repo.additional, which the backend has stored as
		// project_repositories since migration 072. Blank rows are ignored.
		// REWRITE: the repositories come from the rewrite rows, not the ordinary
		// repository rows — the target is the primary (role 'target'), each source
		// an additional row (role 'source', pinned to its sha). Every other flow
		// takes the untouched path below, so its payload is byte-identical.
		const rewrite = isRewriteForm(form);
		const named = rewrite ? [] : form.repositories.filter((r) => r.url.trim());
		const primary = named.find((r) => r.is_primary) ?? named[0];
		// The OPTIONAL output repository (non-rewrite `it` only): where the project's
		// new code goes when it writes to a second repository. Never read for a
		// rewrite (it has its own target row) or for another project type, so those
		// payloads stay byte-identical.
		const outputUrl = !rewrite && form.project_type === 'it' ? form.output_repo_url.trim() : '';
		const outputBranch = form.output_repo_branch.trim();
		// With NO named row the output repository IS the project's only repository:
		// it takes the primary slot with role 'target' (the same shape a rewrite
		// sends), so an output-only project is valid. With named rows it is appended
		// to `repo.additional` instead — AFTER them, so the array order keeps meaning.
		const outputOnly = outputUrl !== '' && named.length === 0;
		const repoUrl = rewrite
			? form.rewrite_target_url.trim()
			: outputOnly
				? outputUrl
				: (primary?.url.trim() ?? '');
		const primaryBranch = outputOnly ? outputBranch || 'main' : primary?.branch.trim() || 'main';
		const outputRow =
			outputUrl !== '' && !outputOnly
				? [
						{
							url: outputUrl,
							...(outputBranch ? { branch: outputBranch } : {}),
							role: 'target' as const
						}
					]
				: [];
		const additional: NonNullable<NonNullable<ProjectCreate['repo']>['additional']> = rewrite
			? form.rewrite_sources
					.filter((r) => r.url.trim())
					.map((r) => ({
						url: r.url.trim(),
						...(r.branch.trim() ? { branch: r.branch.trim() } : {}),
						role: 'source' as const,
						// A commit SHA or a PR; the backend resolves a PR to its head commit.
						...((r.pin ?? '').trim() ? { pin: (r.pin ?? '').trim() } : {})
					}))
			: [
					...named
						.filter((r) => r !== primary)
						.map((r) => ({
							url: r.url.trim(),
							// ⚠️ OMIT blanks, never send ''. The backend declares these
							// `z.string().min(1).optional()`, so an empty string 422s where an
							// absent key is fine.
							...(r.branch.trim() ? { branch: r.branch.trim() } : {}),
							...(r.name.trim() ? { name: r.name.trim() } : {}),
							// The exact version this repository is read at (George 2026-11-07).
							...((r.pin ?? '').trim() ? { pin: (r.pin ?? '').trim() } : {})
						})),
					...outputRow
				];
		// A coordination mode is only meaningful, and only ASKED, with two or more
		// repositories — the control is hidden below that. Sending the default
		// anyway would record a declaration the user never made.
		const coordinationMode = named.length >= 2 ? form.coordination_mode || 'coordinated' : undefined;
		// The IT inputs are only sent for an `it` project — on any other type they are
		// meaningless and the backend would just carry dead keys in project_data.
		const isIt = form.project_type === 'it';
		const testArgv = parseArgv(form.test_command);
		const bugArgv = parseArgv(form.bug_test_command);
		// Bug HUNT: no failing test is known, so bug_test_command / failing_test_ref /
		// bug_description are never sent (the backend 400s a hunt that carries
		// bug_test_command) and test_command is the suite the hunt runs.
		const hunt = form.it_flow === 'bug' && form.bug_hunt === true;
		// No rewrite-only project keys any more (George 2026-11-07): `max_cards` is
		// gone and the target language is EXTRACTED from the request by the backend.
		const it: Partial<ProjectCreate> = isIt
			? {
					it_flow: (form.it_flow || 'dependency') as ProjectCreate['it_flow'],
					cve_sweep: form.cve_sweep || undefined,
					bug_hunt: hunt ? true : undefined,
					target_packages: form.target_packages.length > 0 ? form.target_packages : undefined,
					test_command: testArgv.length > 0 ? testArgv : undefined,
					bug_test_command:
						form.it_flow === 'bug' && !hunt && bugArgv.length > 0 ? bugArgv : undefined,
					failing_test_ref:
						form.it_flow === 'bug' && !hunt ? form.failing_test_ref.trim() || undefined : undefined,
					target_files: form.target_files.length > 0 ? form.target_files : undefined,
					// ⚠️ SEVERITY_FLOWS, not REMEDIATION_FLOWS — see that set's note.
					// `bug` and `refactor` spawn cards that never read it, and the
					// control is hidden for them, so sending it would record a floor
					// the user was not asked for and nothing applies.
					min_severity: SEVERITY_FLOWS.has(form.it_flow)
						? (form.min_severity as ProjectCreate['min_severity'])
						: undefined,
					// The bug report text itself. `bug_analysis` and
					// `development_bug_fix` both read `dispatch_context.bug_description`
					// (measured in AA_IMPLEMENTATION/doing_action_procedures.json) and
					// the form collected it NOWHERE, so every bug project dispatched
					// with an empty description — the analysis card had the failing
					// test command and no statement of what is wrong.
					bug_description:
						form.it_flow === 'bug' && !hunt ? form.bug_description.trim() || undefined : undefined,
					// ALWAYS sent, the default included, so the stored mode never
					// depends on the flows' own fallback for an unset value (R329).
					approval_mode: form.approval_mode || DEFAULT_APPROVAL_MODE
				}
			: {};
		return {
			...it,
			name: form.name,
			// A repository is OPTIONAL (George 2026-10-13): no named row ⇒ the key and
			// `repo` are ABSENT (never ''), and the project is created without one.
			...(repoUrl ? { repository_url: repoUrl } : {}),
			shape: form.shape,
			branch: primaryBranch,
			description: form.description || undefined,
			project_type: form.project_type || undefined,
			scope_level: form.scope_level || undefined,
			coordination_mode: coordinationMode as ProjectCreate['coordination_mode'],
			approvers: form.approvers.length > 0 ? form.approvers : undefined,
			problem_statement: form.problem_statement || undefined,
			desired_outcome: form.desired_outcome || undefined,
			business_case: form.business_case || undefined,
			success_criteria: form.success_criteria.length > 0 ? form.success_criteria : undefined,
			acceptance_criteria: form.acceptance_criteria.length > 0 ? form.acceptance_criteria : undefined,
			// The four scope lists. ⚠️ Spread, NOT `x: cond ? x : undefined` like
			// the lines above: these keys are ABSENT when empty rather than
			// present-and-undefined, because the reader treats "no key" and "empty
			// key" as different statements. See scopeFieldsForPayload.
			...scopeFieldsForPayload(form),
			// ⛔ Do NOT add a `position` field here — not to `primary`, not to an
			// `additional` entry. The ARRAY ORDER is the single source of truth for
			// repository order: the backend derives `position` itself (0 for the
			// primary, `i + 1` for each `additional[i]`) from the index, in
			// `backend/src/routes/projects.ts`. The inbound schema
			// (`backend/src/types/api.ts`, `repo.primary` / `repo.additional[]`)
			// declares no such key, so a `position` sent from here is stripped by zod
			// before anything reads it — a write-only field on the wire, which is the
			// exact defect class this form was cleaned up to remove. Sending it would
			// also make TWO producers of one fact that can disagree. If you need a
			// different order, change the order of `repo.additional`.
			...(repoUrl
				? {
						repo: {
							primary:
								rewrite || outputOnly
									? { url: repoUrl, branch: primaryBranch, role: 'target' as const }
									: {
											url: repoUrl,
											branch: primaryBranch,
											// The exact version this repository is read at (George 2026-11-07).
											...((primary?.pin ?? '').trim() ? { pin: (primary?.pin ?? '').trim() } : {})
										},
							...(additional.length > 0 ? { additional } : {})
						}
					}
				: {}),
			constraints: form.constraints.length > 0 ? form.constraints : undefined,
			dependencies: form.dependencies.length > 0 ? form.dependencies : undefined,
			risks:
				form.risks.filter((r) => r.description.trim()).length > 0
					? form.risks.filter((r) => r.description.trim())
					: undefined,
			bound_assets: (() => {
				const out: Record<string, string[]> = {};
				for (const k of Object.keys(ctx.boundAssets) as AssetKind[]) {
					if (ctx.boundAssets[k].length > 0) out[k] = ctx.boundAssets[k];
				}
				return Object.keys(out).length > 0 ? (out as ProjectCreate['bound_assets']) : undefined;
			})()
		};
	}

</script>

<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { apiClient, ApiError } from '$lib/api/unified-client';
	import type { Repository } from '$lib/types/api';
	import ShapeRadio from '$lib/components/forms/ShapeRadio.svelte';
	import { AssetMultiPicker } from '$lib/components/library';
	import RepositoryRepeater from '$lib/components/project-request/RepositoryRepeater.svelte';
	import ApproverPicker from '$lib/components/project-request/ApproverPicker.svelte';
	import ConstraintsEditor from '$lib/components/project-request/ConstraintsEditor.svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import { workspaces } from '$lib/stores/workspaces.svelte';
	import { EXECUTION_TENANT_ID } from '$lib/components/ProjectTypeAnalysisWarning.svelte';
	import { loadProjectTypeOptions, pickerOptions, type ProjectTypeOptions } from '$lib/projects/projectTypeOptions';
	import CatalogueNotInitialised from '$lib/components/catalogue/CatalogueNotInitialised.svelte';
	import {
		verifyRepoAccess,
		describeVerdict,
		isReadable,
		parseRepoAccessDenied,
		type RepoAccessVerdict
	} from '$lib/api/repo-access';
	import GithubAppInstallCta from '$lib/components/github/GithubAppInstallCta.svelte';
	import { installCtaOwner } from '$lib/api/github-app';
	import type { AssetErrorCause } from '$lib/api/assets';

	// This is the SHARED project form (Spec 2 §4) used both by /projects/new
	// (create) and /projects/requests/[id] (review + approve a CP-forwarded
	// draft — the CP→fr bridge). It owns all form state + picker loading and
	// emits a built ProjectCreate via `onSubmit`; the page does the API call +
	// navigation. Extracted from the former monolithic /projects/new page so the
	// two surfaces can never diverge.
	interface Props {
		initial?: Partial<ProjectFormState>;
		initialBoundAssets?: Partial<BoundAssetsState>;
		submitLabel?: string;
		submittingLabel?: string;
		cancelHref?: string;
		/**
		 * `meta.idempotencyKey` is ONE UUID per form session (this component
		 * instance), identical on every submit including retries — POST
		 * /api/projects's `Idempotency-Key`, so a retry never makes a second project.
		 */
		onSubmit: (payload: ProjectCreate, meta: { idempotencyKey: string }) => Promise<void>;
		/**
		 * fr-agui SPEC §6.3: the agent's ProjectCreateCard passes the proposal's
		 * key so a confirm and its retries share ONE key. Absent ⇒ a fresh UUID
		 * per form session, as before.
		 */
		idempotencyKey?: string;
		/**
		 * The tenant the project will be created in, when it is NOT the caller's
		 * active workspace — /projects/requests/[id] passes the request's own
		 * `tenant_id` (the backend's `repoGateTenantId`). Absent ⇒ the active
		 * workspace (`X-Active-Tenant`), else the JWT tenant.
		 */
		ownerTenantId?: string | null;
	}

	let {
		initial,
		initialBoundAssets,
		submitLabel = 'Create Project',
		submittingLabel = 'Saving...',
		cancelHref = '/',
		onSubmit,
		idempotencyKey: idempotencyKeyProp,
		ownerTenantId
	}: Props = $props();

	// One per form session: every submit of this form instance (retries included)
	// sends the same key, so the backend creates at most one project for it.
	const idempotencyKey = untrack(() => idempotencyKeyProp) ?? crypto.randomUUID();

	// ⚠️ Every key here MUST have a matching `{#if openSections.<key>}` block and a
	// `toggleSection('<key>')` control. `people`, `secrets_docs` and `resources` were
	// declared here with neither — residue from the sections that were removed, so the
	// code still described a form that had three collapsible panels it does not render.
	// That is what made the Resources and People sections look present while collecting
	// nothing. Pinned by ProjectForm.open-sections.test.ts.
	let openSections = $state<Record<string, boolean>>({
		basics: true,
		objectives: true,
		scope: false,
		repo: true,
		library_scope: false,
		timeline: false
	});

	let boundAssets = $state<BoundAssetsState>({ ...emptyBoundAssets(), ...initialBoundAssets });

	const ASSET_KINDS_ORDERED: { kind: AssetKind; label: string; hint?: string }[] = [
		{ kind: 'kag_document', label: 'KAG documents', hint: 'Knowledge graph documents to reference' },
		{ kind: 'requirement', label: 'Requirements' },
		{ kind: 'principle', label: 'Principles' },
		{ kind: 'decision', label: 'Decisions' },
		{ kind: 'workflow', label: 'Workflows', hint: 'n8n workflows the project should run' },
		{ kind: 'trigger', label: 'Triggers', hint: 'Scheduled triggers attached to this project' },
		{ kind: 'channel', label: 'Channels', hint: 'Notification destinations for this project' },
		{ kind: 'artifact', label: 'Artifacts', hint: 'Pre-existing artifacts to attach (rare)' }
	];

	const LABEL_FOR_KIND: Partial<Record<AssetKind, string>> = Object.fromEntries(
		ASSET_KINDS_ORDERED.map((e) => [e.kind, e.label])
	);

	/**
	 * Asset kinds whose picker failed to load, so the form can SAY SO.
	 *
	 * ⚠️ This exists because the silent version of this was a real defect, not
	 * a polish gap. Each AssetMultiPicker owned its own error state and told
	 * nobody; when `/api/assets/kag-documents` started 502ing (kag's
	 * `ALLOW_UNVOUCHED_TENANT_HEADER` flip, 2026-09-16) the KAG list rendered
	 * empty-with-red-text and the form submitted happily with ZERO documents
	 * bound. A project created that way looks identical to one deliberately
	 * created without KAG scope — the difference is unrecoverable after the
	 * fact.
	 *
	 * ⛔ DELIBERATELY DOES NOT BLOCK SUBMIT. A picker outage must not make
	 * project creation impossible; bindings are editable later from the
	 * project's library tabs. It informs, loudly, and gets out of the way.
	 */
	let pickerErrors = $state<Partial<Record<AssetKind, AssetErrorCause>>>({});
	let unavailableKinds = $derived(
		ASSET_KINDS_ORDERED.map((e) => e.kind).filter((k) => pickerErrors[k] !== undefined)
	);
	/**
	 * True when at least one picker failed for a reason the USER cannot act on.
	 *
	 * ⚠️ Keep the whole cause, not a boolean. The first version of this stored
	 * `cause !== null` and threw the structure away, which made the banner
	 * unable to tell "the knowledge base needs an operator" from "try again in
	 * a moment" — and left `operatorFault` computed by nothing that read it.
	 */
	let anyOperatorFault = $derived(
		Object.values(pickerErrors).some((c) => c?.operatorFault === true)
	);

	function recordPickerError(kind: AssetKind, cause: AssetErrorCause | null): void {
		// Reassign rather than mutate: `$state` on a plain object tracks the
		// reference for the `$derived` above, and a retry must be able to CLEAR
		// the banner, not only raise it.
		const next = { ...pickerErrors };
		if (cause === null) delete next[kind];
		else next[kind] = cause;
		pickerErrors = next;
	}

	let repositories = $state<Repository[]>([]);
	let loadingPickers = $state(false);

	let repoMode = $state<'existing' | 'manual'>('manual');
	let selectedRepoId = $state<string | null>(null);

	let isSubmitting = $state(false);
	let error = $state<string | null>(null);

	let form = $state<ProjectFormState>({ ...emptyFormState(), ...initial });

	// Bug hunt is EXEC-only: the backend (assertItExecIntakeInputs) 400s
	// `bug_hunt_exec_only` unless the OWNER tenant is EXEC, and the owner is the
	// tenant the project is created in: `ownerTenantId` when given, else the active
	// workspace — which only a super-admin can switch (X-Active-Tenant is ignored for
	// everyone else, who create in their JWT tenant). Offer the checkbox only on
	// EXEC, and never let a hidden one stay checked.
	const createTenantId = $derived(
		ownerTenantId || (auth.isSuperAdmin ? workspaces.scopeKey : undefined) || auth.user?.tenant_id || ''
	);
	const bugHuntAllowed = $derived(createTenantId === EXECUTION_TENANT_ID);
	$effect(() => {
		if (!bugHuntAllowed && form.bug_hunt) form.bug_hunt = false;
	});

	let tempInputs = $state<Record<string, string>>({});

	// `feature` and `it` are the two types that drive the conveyor to a code change +
	// PR. fr creates NO card (George 2026-10-12; v4 R80/R81): it builds the board,
	// links it in RM and fires project.created; n8n's trigger.conveyor_start creates
	// the first card. They were absent from this list, so the UI could not reach the
	// code-running path at all.
	//
	// ⛔ `greenfield` / `brownfield` / `migration` / `refactor` / `poc` /
	// `maintenance` WERE HERE AND ARE DELETED (2026-10-01, George: "delete them").
	// MEASURED BASIS: `backend/src/routes/projects.ts` branches on exactly one
	// value — `project_type === 'feature'` picks the
	// `feature_start_request_analysis` intake card_type, everything else gets
	// `project_start_request_analysis`. So those six were not six project kinds;
	// they were six LABELS on the IT intake card, offering the user a choice the
	// pipeline cannot honour. The form now offers only the two paths the system can
	// actually execute: find bugs → report → approve → PR with only the fixes
	// (`it` + flow `bug`), and add a feature → analyse → design → approve → PR with
	// only the feature (`feature`).
	//
	// ⭐ The options are the TENANT's requirements_management project types
	// (design: fr consumes RM vocabulary, George 2026-10-12), loaded from
	// GET /api/conveyor/project-types — there is no frontend list. A tenant with
	// no catalogue gets the catalogue_not_initialised state instead of a picker.
	// The per-type inputs below (`feature` hint, `it` remediation flow) are still
	// keyed by type NAME: they appear only when the tenant defines that name.
	let projectTypeState = $state<ProjectTypeOptions | null>(null);
	const projectTypes = $derived(pickerOptions(projectTypeState, form.project_type));
	async function loadTypes(): Promise<void> {
		projectTypeState = await loadProjectTypeOptions();
	}

	const itFlows = [
		{ value: 'dependency', label: 'Dependency upgrade' },
		{ value: 'security', label: 'Security — dependency CVEs' },
		{ value: 'source-security', label: 'Security — source code' },
		{ value: 'iac', label: 'Security — infrastructure-as-code' },
		{ value: 'bug', label: 'Bug fix' },
		{ value: 'refactor', label: 'Architecture refactor' },
		{ value: 'rewrite', label: 'Rewrite in another language' }
	];

	const isRewrite = $derived(isRewriteForm(form));

	function setRewriteSource(i: number, field: keyof RewriteSourceRow, value: string) {
		form.rewrite_sources = form.rewrite_sources.map((r, j) => (j === i ? { ...r, [field]: value } : r));
	}

	function addRewriteSource() {
		form.rewrite_sources = [...form.rewrite_sources, emptyRewriteSource()];
	}

	function removeRewriteSource(i: number) {
		if (form.rewrite_sources.length <= 1) return;
		form.rewrite_sources = form.rewrite_sources.filter((_, j) => j !== i);
	}

	const approvalModes: { value: ApprovalMode; label: string }[] = [
		{ value: 'brief_and_closure', label: 'Only the brief and the final closure (default)' },
		{ value: 'autonomous', label: 'Nothing — hands-off' },
		{ value: 'auto_drafts', label: 'Everything except drafts the conveyor fills in' },
		{ value: 'all', label: 'Everything' }
	];

	const severities = [
		{ value: 'LOW', label: 'Low' },
		{ value: 'MODERATE', label: 'Moderate' },
		{ value: 'HIGH', label: 'High' },
		{ value: 'CRITICAL', label: 'Critical' }
	];

	const lifecycleClasses = [
		{ value: 'execution', label: 'Execution (default)' },
		{ value: 'workflow-improvement', label: 'Workflow improvement' },
		{ value: 'prompt-improvement', label: 'Prompt improvement' },
		{ value: 'system', label: 'System' }
	];

	// scope_level is a code-GRANULARITY scale, not a t-shirt size. This select used
	// to offer small/medium/large/enterprise — none of which the card schema accepts,
	// so every project created here silently failed to mint its approval cards.
	// Canonical list: backend/src/types/scope-level.ts (keep in lock-step).
	//
	// ⛔ `multi_repo` IS DELIBERATELY ABSENT (2026-09-30). It is not a granularity
	// — it answers "how many repositories?", which the repository repeater below
	// already answers, and asking twice is how the form came to REFUSE the
	// ordinary case (two repositories at granularity `module`). The server derives
	// multi-repo-ness from the repository count and keeps the granularity chosen
	// here. What a multi-repo project is actually asked is its COORDINATION MODE,
	// in §5. Nothing in the backend branches on the literal `'multi_repo'`.
	//
	// ⚠️ `repo` is labelled "Whole repository", NOT "Single repository"
	// (relabelled 2026-10-01). The old label was a COUNT WORD on a GRANULARITY
	// axis, and it misread exactly as you would expect: George looked at this
	// dropdown, saw "Single repository" as the only `repo`-ish choice, and
	// concluded multi-repo support had been REMOVED from fr — *"i check only
	// 'single repo' is an available choice"*. Nothing had been removed; the
	// repository repeater in §5 is what adds repositories, and it sits in a
	// different accordion section, so the label was the only thing he could see.
	// Every member of this list now names a SIZE OF CODE ("the whole repository",
	// "a module", "a function"), never a quantity of repositories. The derived
	// repo count is now also stated as live text AT the repeater, so the two
	// questions can no longer be mistaken for one.
	//
	// ⛔ KEEP ALL SEVEN. Deleting the dropdown would reintroduce the defect this
	// comment block opens with: the select used to offer small/medium/large/
	// enterprise, none of which the card schema accepts, so EVERY project created
	// here silently failed to mint its approval cards.
	const scopeLevels = [
		{ value: '', label: 'Select...' },
		{ value: 'repo', label: 'Whole repository' },
		{ value: 'app', label: 'Application' },
		{ value: 'module', label: 'Module' },
		{ value: 'component', label: 'Component' },
		{ value: 'file', label: 'File' },
		{ value: 'class', label: 'Class' },
		{ value: 'function', label: 'Function' }
	];

	const priorities = [
		{ value: '', label: 'Select...' },
		{ value: 'low', label: 'Low' },
		{ value: 'medium', label: 'Medium' },
		{ value: 'high', label: 'High' },
		{ value: 'critical', label: 'Critical' }
	];

	const dataClassifications = [
		{ value: '', label: 'Select...' },
		{ value: 'public', label: 'Public' },
		{ value: 'internal', label: 'Internal' },
		{ value: 'confidential', label: 'Confidential' },
		{ value: 'restricted', label: 'Restricted' }
	];

	onMount(async () => {
		void loadTypes();
		loadingPickers = true;
		try {
			// Only the repository list has a consumer now. The secrets and
			// documents fetches went with their pickers: two API calls on every
			// form load whose results nothing read is the same write-only shape
			// this redesign exists to remove, just spelled in network traffic.
			const repoRes = await apiClient.repositories.list();
			repositories = repoRes.items || [];
		} catch (err) {
			console.error('Failed to load picker data:', err);
		} finally {
			loadingPickers = false;
		}
	});

	$effect(() => {
		if (repoMode === 'existing' && selectedRepoId) {
			const repo = repositories.find((r) => r.id === selectedRepoId);
			if (repo) {
				// Fills the PRIMARY row — the picker is a shortcut for typing the
				// primary repository, not a separate kind of repository.
				form.repositories = form.repositories.map((r) =>
					r.is_primary ? { ...r, url: repo.url, branch: repo.branch || 'main' } : r
				);
			}
		}
	});

	function toggleSection(key: string) {
		openSections[key] = !openSections[key];
	}

	function addArrayItem(field: keyof ProjectFormState, inputKey: string) {
		const value = (tempInputs[inputKey] || '').trim();
		if (!value) return;
		(form[field] as string[]) = [...(form[field] as string[]), value];
		tempInputs[inputKey] = '';
	}

	/**
	 * A target package needs BOTH a name and the version to move it to. The
	 * generic string-array helper cannot build that object, which is how the
	 * form came to send bare strings the backend rejects.
	 */
	function addTargetPackage() {
		const name = (tempInputs.target_package_name || '').trim();
		const target_version = (tempInputs.target_package_version || '').trim();
		if (!name || !target_version) return;
		form.target_packages = [...form.target_packages, { name, target_version }];
		tempInputs.target_package_name = '';
		tempInputs.target_package_version = '';
	}

	function removeTargetPackage(index: number) {
		form.target_packages = form.target_packages.filter((_, i) => i !== index);
	}

	function removeArrayItem(field: keyof ProjectFormState, index: number) {
		(form[field] as string[]) = (form[field] as string[]).filter((_, i) => i !== index);
	}



	// ── repository access gate ───────────────────────────────────────────
	// BLOCKING (decision George 2026-09-22, superseding the 2026-09-21
	// "advisory"): submit stays disabled until EVERY named repository is
	// `public` or `private_granted`. Unchecked, `error`, `unknown` and
	// `private_ungranted` all block — the backend refuses the same set with a
	// 422 `repo_access_denied`, so this only moves the refusal to where the user
	// can act on it. A failed CHECK is shown as a failed check (with Re-check),
	// never as "your repo is private".
	let accessVerdicts = $state<Record<string, RepoAccessVerdict>>({});
	let checkingAccess = $state(false);
	let accessCheckError = $state<string | null>(null);

	// A rewrite names its repositories in the rewrite rows; the access check covers
	// those. A non-rewrite `it` project can also name an optional output repository
	// — it is written to, so it must be readable too.
	const namedUrls = $derived([
		...new Set(
			isRewrite
				? rewriteRepositoryUrls(form)
				: [
						...form.repositories.map((r) => r.url.trim()).filter(Boolean),
						...(form.project_type === 'it' ? [form.output_repo_url.trim()].filter(Boolean) : [])
					]
		)
	]);
	/**
	 * Two or more ROWS carry a URL — the condition under which a coordination mode
	 * is a real question. Counted on rows, NOT on `namedUrls`, which dedupes: two
	 * rows holding the same url is a mistake to fix in the repeater, not a reason
	 * to hide the question the user has already earned by adding a second row.
	 */
	const isMultiRepo = $derived(
		!isRewrite && form.repositories.filter((r) => r.url.trim()).length >= 2
	);
	const unreadableUrls = $derived(namedUrls.filter((u) => !isReadable(accessVerdicts[u])));
	const accessBlocked = $derived(unreadableUrls.length > 0);

	/** Check `urls` (default: every named repo) and MERGE the verdicts in. */
	async function checkRepoAccess(urls: string[] = namedUrls) {
		if (urls.length === 0) return;
		checkingAccess = true;
		accessCheckError = null;
		try {
			const items = await verifyRepoAccess(urls);
			accessVerdicts = { ...accessVerdicts, ...Object.fromEntries(items.map((v) => [v.url, v])) };
		} catch (e) {
			accessCheckError = e instanceof Error ? e.message : String(e);
		} finally {
			checkingAccess = false;
		}
	}

	// Check automatically once the user stops typing: a gate the user must
	// remember to arm by hand reads as a broken submit button.
	$effect(() => {
		const pending = namedUrls.filter((u) => !accessVerdicts[u]);
		if (pending.length === 0) return;
		const timer = setTimeout(() => void checkRepoAccess(pending), 600);
		return () => clearTimeout(timer);
	});








	async function handleSubmit() {
		if (!form.name.trim()) {
			error = 'Project name is required';
			return;
		}
		// No repository check: a repository is OPTIONAL (George 2026-10-13).
		// ⛔ The `coherenceError` submit guard WAS HERE and is deleted: it refused
		// >1 repository without scope_level 'multi_repo', which after this change
		// is the ordinary case (two repositories at granularity `module`). The
		// repository count is now a fact the server reads, not a claim the user has
		// to keep consistent with a dropdown.
		// Mirror of the backend's IT guards, so the user sees this here rather than as
		// a 422 after submit. The backend stays the authority.
		const itError = validateItInputs(form);
		if (itError) {
			error = itError;
			return;
		}
		// The disabled button is the UX; this is the guard (Enter in a field
		// submits a form whatever the button says).
		const unchecked = namedUrls.filter((u) => !accessVerdicts[u]);
		if (unchecked.length > 0) await checkRepoAccess(unchecked);
		if (accessBlocked) {
			error = accessCheckError
				? `Could not check repository access: ${accessCheckError}. Re-check before submitting.`
				: 'We cannot read every repository yet — see the repository section. Only repositories we can read can be submitted.';
			return;
		}
		isSubmitting = true;
		error = null;
		try {
			await onSubmit(
				buildPayload(form, { boundAssets }),
				{ idempotencyKey }
			);
		} catch (err) {
			const denied = err instanceof ApiError ? parseRepoAccessDenied(err.data) : null;
			if (denied) {
				// The server's verdict wins over a stale local one.
				accessVerdicts = { ...accessVerdicts, ...Object.fromEntries(denied.map((v) => [v.url, v])) };
				error = `We cannot read ${denied.length === 1 ? 'this repository' : 'these repositories'}: ${denied
					.map((v) => `${v.url} — ${describeVerdict(v).text}`)
					.join('; ')}`;
			} else {
				error = err instanceof ApiError ? err.message : 'Failed to save project';
			}
			console.error('ProjectForm submit error:', err);
		} finally {
			isSubmitting = false;
		}
	}

	function formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
	}
</script>

<div class="space-y-4">
	{#if error}
		<div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-4 dark:bg-[var(--color-danger-bg)]/20">
			<div class="flex items-center gap-3">
				<span class="text-[var(--color-danger)] text-lg">&#9888;</span>
				<div class="flex-1">
					<p class="text-[var(--color-danger-text)] font-medium dark:text-[var(--color-danger-text)]">Error</p>
					<p class="text-[var(--color-danger)] text-sm">{error}</p>
				</div>
				<button onclick={() => (error = null)} class="text-[var(--color-danger)] hover:text-[var(--color-danger-text)]">
					<span class="text-xl">&times;</span>
				</button>
			</div>
		</div>
	{/if}

	<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
		<div class="bg-[var(--color-bg)] rounded-lg shadow mb-4 p-4 dark:bg-[var(--color-surface)]">
			<ShapeRadio bind:value={form.shape} />
		</div>

		<!-- Section 1: Project Basics -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow mb-4 dark:bg-[var(--color-surface)]">
			<button type="button" onclick={() => toggleSection('basics')} class="w-full px-6 py-4 flex items-center justify-between text-left border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h2 class="text-lg font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">1. Project Basics</h2>
				<span class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">{openSections.basics ? '▲' : '▼'}</span>
			</button>
			{#if openSections.basics}
				<div class="px-6 py-4 space-y-4">
					<div>
						<label for="name" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Project Name <span class="text-[var(--color-danger)]">*</span></label>
						<input id="name" type="text" bind:value={form.name} required class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="My Project" />
					</div>
					<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div>
							<label for="project_type" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Project Type *</label>
							<select id="project_type" bind:value={form.project_type} class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]">
								{#each projectTypes as pt (pt.value)}
									<option value={pt.value}>{pt.label}</option>
								{/each}
							</select>
							{#if projectTypeState?.kind === 'not_initialised'}
								<div class="mt-2">
									<CatalogueNotInitialised info={projectTypeState.info} onImported={loadTypes} />
								</div>
							{:else if projectTypeState?.kind === 'failed'}
								<p class="mt-1 text-xs text-[var(--color-danger)]" data-testid="project-types-failed">
									Project types could not be loaded: {projectTypeState.message}
								</p>
							{/if}
						</div>
					</div>

					<!-- Rewrite inputs: inside the IT box, between the flow picker and the test command.
					     No language control and no card cap (George 2026-11-07): the target language
					     is EXTRACTED from the project request by the backend and recorded in the project
					     brief (RM), and the cap never existed. -->
					{#snippet rewriteFields()}
						<div class="space-y-2" data-testid="rewrite-fields">
							<p class="text-xs text-[var(--color-text-muted)]" data-testid="rewrite-language-hint">
								The target language comes from your request and is recorded in the project brief —
								name it there (e.g. “rewrite the ingestion service in Rust”).
							</p>
							<p class="text-xs text-[var(--color-text-muted)]">Name the code to rewrite and where the new code goes in the Repositories section below.</p>
						</div>
					{/snippet}

					{#if form.project_type === 'feature'}
						<p class="text-xs text-[var(--color-text-muted)]" data-testid="feature-hint">
							The system will analyse the repository, propose a decomposition for your approval,
							then work the approved child cards in a container and open a draft pull request.
						</p>
					{/if}

					{#if form.project_type === 'it'}
						<div class="space-y-4 rounded-lg border border-[var(--color-border)] p-4" data-testid="it-flow-fields">
							<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
								<div>
									<label for="it_flow" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Remediation Flow *</label>
									<select id="it_flow" bind:value={form.it_flow} class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]">
										{#each itFlows as f}
											<option value={f.value}>{f.label}</option>
										{/each}
									</select>
								</div>
								{#if SEVERITY_FLOWS.has(form.it_flow)}
									<div data-testid="min-severity-field">
										<label for="min_severity" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Minimum Severity</label>
										<select id="min_severity" bind:value={form.min_severity} class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]">
											{#each severities as s}
												<option value={s.value}>{s.label}</option>
											{/each}
										</select>
										<p class="mt-1 text-xs text-[var(--color-text-muted)]">Findings below this are ignored.</p>
									</div>
								{/if}
							</div>

							{#if isRewrite}
								{@render rewriteFields()}
							{/if}

							{#if !REMEDIATION_FLOWS.has(form.it_flow)}
								<div>
									<label class="flex items-center gap-2 text-sm text-[var(--color-text)]">
										<input type="checkbox" bind:checked={form.cve_sweep} data-testid="cve-sweep" />
										CVE sweep (discovery mode — scan for fixable CVEs instead of naming packages)
									</label>
								</div>
								<div>
									<label for="target_packages_input" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
										Target Packages {#if !form.cve_sweep}<span class="text-[var(--color-danger)]">*</span>{/if}
									</label>
									<div class="flex gap-2">
										<input id="target_packages_input" type="text" bind:value={tempInputs.target_package_name} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTargetPackage(); }}} class="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="package, e.g. fastmcp" aria-label="Package name" />
										<input id="target_packages_version_input" type="text" bind:value={tempInputs.target_package_version} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTargetPackage(); }}} class="w-40 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="to version, e.g. 2.3.0" aria-label="Target version" />
										<button type="button" data-testid="add-target-package" onclick={addTargetPackage} class="px-4 py-2 bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors">Add</button>
									</div>
									{#if form.target_packages.length > 0}
										<div class="mt-2 flex flex-wrap gap-2">
											{#each form.target_packages as pkg, i}
												<span class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-[var(--color-surface)] text-[var(--color-text)]">
													{pkg.name} → {pkg.target_version}
													<button type="button" onclick={() => removeTargetPackage(i)} class="text-[var(--color-accent)]" aria-label="Remove {pkg.name}">&times;</button>
												</span>
											{/each}
										</div>
									{/if}
								</div>
							{/if}

							{#if form.it_flow === 'bug' && bugHuntAllowed}
								<div>
									<label class="flex items-center gap-2 text-sm text-[var(--color-text)]">
										<input type="checkbox" bind:checked={form.bug_hunt} data-testid="bug-hunt" />
										Hunt for bugs (no failing test known yet)
									</label>
								</div>
							{/if}

							{#if form.it_flow === 'bug' && form.bug_hunt}
								<div>
									<label for="bug_hunt_test_command" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Test suite command <span class="text-[var(--color-danger)]">*</span></label>
									<input id="bug_hunt_test_command" type="text" bind:value={form.test_command} data-testid="bug-hunt-test-command" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="uv run --no-sync python -m pytest" />
									<p class="mt-1 text-xs text-[var(--color-text-muted)]">
										The command the hunt runs — e.g. the repo's CI test command. It need not fail.
										{#if form.test_command.trim()}<br />Sent as: <code>{JSON.stringify(parseArgv(form.test_command))}</code>{/if}
									</p>
								</div>
							{/if}

							{#if form.it_flow === 'bug' && !form.bug_hunt}
								<div>
									<label for="bug_description" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">What is wrong?</label>
									<textarea id="bug_description" bind:value={form.bug_description} rows="3" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="Uploading a PDF over 10 MB returns 500 instead of the size error"></textarea>
									<p class="mt-1 text-xs text-[var(--color-text-muted)]">
										The bug report the analysis agent is given. It reads this as
										<code>bug_description</code> — the failing test command below tells it how to
										reproduce the bug, this tells it what the bug IS.
									</p>
								</div>
								<div>
									<label for="bug_test_command" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Failing Test Command <span class="text-[var(--color-danger)]">*</span></label>
									<input id="bug_test_command" type="text" bind:value={form.bug_test_command} class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="pytest -q tests/test_foo.py::test_bar" />
									<p class="mt-1 text-xs text-[var(--color-text-muted)]">
										The test that currently FAILS — the system reproduces it red, fixes the code, and requires it green.
										{#if form.bug_test_command.trim()}<br />Sent as: <code>{JSON.stringify(parseArgv(form.bug_test_command))}</code>{/if}
									</p>
								</div>
								<div>
									<label for="failing_test_ref" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Failing Test Reference</label>
									<input id="failing_test_ref" type="text" bind:value={form.failing_test_ref} class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="tests/test_foo.py::test_bar" />
								</div>
							{/if}

							{#if !(form.it_flow === 'bug' && form.bug_hunt)}
								<div>
									<label for="test_command" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Verification Test Command</label>
									<input id="test_command" type="text" bind:value={form.test_command} class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="pytest -q" />
									<p class="mt-1 text-xs text-[var(--color-text-muted)]">
										Run after the fix to publish the draft PR. It must actually exist in this repo — a wrong command blocks the card even when the change is correct.
										{#if form.test_command.trim()}<br />Sent as: <code>{JSON.stringify(parseArgv(form.test_command))}</code>{/if}
									</p>
								</div>
							{/if}

							<div>
								<label for="target_files_input" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Target Files</label>
								<div class="flex gap-2">
									<input id="target_files_input" type="text" bind:value={tempInputs.target_files} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addArrayItem('target_files', 'target_files'); }}} class="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="src/foo.py" />
									<button type="button" onclick={() => addArrayItem('target_files', 'target_files')} class="px-4 py-2 bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors">Add</button>
								</div>
								<p class="mt-1 text-xs text-[var(--color-text-muted)]">Optional — narrows what the worker may edit.</p>
								{#if form.target_files.length > 0}
									<div class="mt-2 flex flex-wrap gap-2">
										{#each form.target_files as item, i}
											<span class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-[var(--color-surface)] text-[var(--color-text)]">
												{item}
												<button type="button" onclick={() => removeArrayItem('target_files', i)} class="text-[var(--color-accent)]">&times;</button>
											</span>
										{/each}
									</div>
								{/if}
							</div>

							<div data-testid="approval-mode-field">
								<label for="approval_mode" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Ask me to approve</label>
								<select id="approval_mode" bind:value={form.approval_mode} data-testid="approval-mode" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]">
									{#each approvalModes as m}
										<option value={m.value}>{m.label}</option>
									{/each}
								</select>
								<p class="mt-1 text-xs text-[var(--color-text-muted)]">Which steps wait for your sign-off while the project runs.</p>
							</div>
						</div>
					{/if}
					<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div>
							<label for="scope_level" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Scope Level *</label>
							<select id="scope_level" bind:value={form.scope_level} class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]">
								{#each scopeLevels as sl}
									<option value={sl.value}>{sl.label}</option>
								{/each}
							</select>
						</div>
					</div>
					<div>
						<label for="description" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Description</label>
						<textarea id="description" bind:value={form.description} rows="3" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="Brief project description"></textarea>
					</div>
				</div>
			{/if}
		</div>

		<!-- Section 2: Sign-off -->
		<!-- Approvers are REAL tenant users, chosen from a list, defaulting to the
		     person filling in the form. The section collapses to nothing when the
		     tenant has a single user (ApproverPicker decides). The old free-text
		     field was filtered out server-side and silently replaced by the
		     project owner, so the roster the user typed never existed. -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow mb-4 dark:bg-[var(--color-surface)]">
			<div class="px-6 py-4">
				<ApproverPicker bind:selected={form.approvers} currentUserId={auth.user?.id ?? ''} />
			</div>
		</div>

		<!-- Section 3: Problem & Objectives -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow mb-4 dark:bg-[var(--color-surface)]">
			<button type="button" onclick={() => toggleSection('objectives')} class="w-full px-6 py-4 flex items-center justify-between text-left border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h2 class="text-lg font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">2. Problem & Objectives</h2>
				<span class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">{openSections.objectives ? '▲' : '▼'}</span>
			</button>
			{#if openSections.objectives}
				<div class="px-6 py-4 space-y-4">
					<div>
						<label for="problem_statement" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Problem Statement *</label>
						<textarea id="problem_statement" bind:value={form.problem_statement} rows="3" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="What problem does this project solve?"></textarea>
					</div>
					<div>
						<label for="desired_outcome" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Desired Outcome *</label>
						<textarea id="desired_outcome" bind:value={form.desired_outcome} rows="3" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="What does success look like?"></textarea>
					</div>
					<div>
						<label for="business_case" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Business Case *</label>
						<textarea id="business_case" bind:value={form.business_case} rows="3" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="Why should this be done now?"></textarea>
					</div>
				</div>
			{/if}
		</div>

		<!-- Section 4: Scope & Requirements -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow mb-4 dark:bg-[var(--color-surface)]">
			<button type="button" data-testid="toggle-scope" onclick={() => toggleSection('scope')} class="w-full px-6 py-4 flex items-center justify-between text-left border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h2 class="text-lg font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">3. Scope & Requirements</h2>
				<span class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">{openSections.scope ? '▲' : '▼'}</span>
			</button>
			{#if openSections.scope}
				<div class="px-6 py-4 space-y-4">
					<!-- ⭐ ONE editor pattern for every string-list field in this section.
					     The four scope lists (in_scope / out_of_scope /
					     high_level_requirements / assumptions) were re-added here on
					     2026-09-23 — they had been removed for having no backend
					     reader, and `scopeFieldsForBrief` now delivers all four into
					     both agent briefs, so a human needs a way to write them. -->
					{#each [
						{ key: 'success_criteria', label: 'Success Criteria', placeholder: 'Add criterion', help: '' },
						{ key: 'acceptance_criteria', label: 'Acceptance Criteria', placeholder: 'Add criterion', help: '' },
						{ key: 'in_scope', label: 'In scope', placeholder: 'Add something that IS in scope', help: 'Passed to the analysis agent in its project brief. Leave empty if you have not decided — an empty list would tell the agent you decided there is nothing.' },
						{ key: 'out_of_scope', label: 'Out of scope', placeholder: 'Add something that is NOT in scope', help: 'Passed to the analysis agent in its project brief. Leave empty if you have not decided — an empty list would tell the agent you decided there is nothing.' },
						{ key: 'high_level_requirements', label: 'High-level requirements', placeholder: 'Add a high-level requirement', help: 'Passed to the analysis agent in its project brief. Leave empty if you have not decided — an empty list would tell the agent you decided there is nothing.' },
						{ key: 'assumptions', label: 'Assumptions', placeholder: 'Add an assumption', help: 'Passed to the analysis agent in its project brief. Leave empty if you have not decided — an empty list would tell the agent you decided there is nothing.' }
					] as field}
						<div>
							<label for="{field.key}_input" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">{field.label}</label>
							{#if field.help}
								<p class="text-xs text-[var(--color-text-muted)] mb-1 dark:text-[var(--color-text-muted)]">{field.help}</p>
							{/if}
							<div class="flex gap-2">
								<input id="{field.key}_input" type="text" bind:value={tempInputs[field.key]} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addArrayItem(field.key as keyof ProjectFormState, field.key); }}} class="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder={field.placeholder} />
								<button type="button" onclick={() => addArrayItem(field.key as keyof ProjectFormState, field.key)} class="px-4 py-2 bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]">Add</button>
							</div>
							{#if (form[field.key as keyof ProjectFormState] as string[]).length > 0}
								<ul class="mt-2 space-y-1">
									{#each form[field.key as keyof ProjectFormState] as string[] as item, i}
										<li class="flex items-center gap-2 text-sm text-[var(--color-text)] bg-[var(--color-surface)] px-3 py-1.5 rounded dark:text-[var(--color-text-muted)] dark:bg-[var(--color-bg)]">
											<span class="flex-1">{item}</span>
											<button type="button" onclick={() => removeArrayItem(field.key as keyof ProjectFormState, i)} class="text-[var(--color-danger-text)] hover:text-[var(--color-danger)]">&times;</button>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Section 5: Repository & Environment -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow mb-4 dark:bg-[var(--color-surface)]">
			<button type="button" onclick={() => toggleSection('repo')} class="w-full px-6 py-4 flex items-center justify-between text-left border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h2 class="text-lg font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">4. Repositories <span class="text-sm font-normal text-[var(--color-text-muted)]">(optional)</span></h2>
				<span class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">{openSections.repo ? '▲' : '▼'}</span>
			</button>
			{#if openSections.repo}
				<div class="px-6 py-4 space-y-4">
					{#if isRewrite}
						<div class="space-y-3" data-testid="rewrite-repositories">
							<fieldset class="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
								<legend class="block text-sm font-medium text-[var(--color-text)] px-1 dark:text-[var(--color-text-muted)]">Code to rewrite <span class="text-[var(--color-danger)]">*</span></legend>
								<p class="text-xs text-[var(--color-text-muted)]">Each repository is read at the exact version you pin — a commit SHA or a pull request — so later changes to it do not change what is rewritten.</p>
								{#each form.rewrite_sources as src, i (i)}
									<div class="grid grid-cols-1 md:grid-cols-12 gap-2 items-end" data-testid="rewrite-source-row">
										<div class="md:col-span-5">
											<label for="rewrite_source_url_{i}" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Repository URL</label>
											<input id="rewrite_source_url_{i}" type="text" value={src.url} oninput={(e) => setRewriteSource(i, 'url', e.currentTarget.value)} data-testid="rewrite-source-url" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="https://github.com/org/repo" />
										</div>
										<div class="md:col-span-2">
											<label for="rewrite_source_branch_{i}" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Branch</label>
											<input id="rewrite_source_branch_{i}" type="text" value={src.branch} oninput={(e) => setRewriteSource(i, 'branch', e.currentTarget.value)} data-testid="rewrite-source-branch" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="main" />
										</div>
										<div class="md:col-span-4">
											<label for="rewrite_source_pin_{i}" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Pin (commit SHA or PR) <span class="text-[var(--color-danger)]">*</span></label>
											<input id="rewrite_source_pin_{i}" type="text" value={src.pin ?? ''} oninput={(e) => setRewriteSource(i, 'pin', e.currentTarget.value)} data-testid="rewrite-source-pin" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)] font-mono" placeholder="40-character SHA or #123" spellcheck="false" autocomplete="off" />
											{#if (src.pin ?? '').trim() && !isRepoPin(src.pin ?? '')}
												<p class="mt-1 text-xs text-[var(--color-warning)]">A full commit SHA is exactly 40 characters (0–9, a–f); a pull request is #123 or its github.com URL.</p>
											{/if}
										</div>
										<div class="md:col-span-1">
											{#if form.rewrite_sources.length > 1}
												<button type="button" onclick={() => removeRewriteSource(i)} class="px-3 py-2 text-sm text-[var(--color-accent)]" aria-label="Remove this source repository">Remove</button>
											{/if}
										</div>
									</div>
								{/each}
								<button type="button" data-testid="add-rewrite-source" onclick={addRewriteSource} class="px-4 py-2 bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors">Add another source repository</button>
							</fieldset>
							<div>
								<label for="rewrite_target_url" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Where the rewritten code goes <span class="text-[var(--color-danger)]">*</span></label>
								<input id="rewrite_target_url" type="text" bind:value={form.rewrite_target_url} data-testid="rewrite-target-url" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="https://github.com/org/repo-rs" />
								<p class="mt-1 text-xs text-[var(--color-text-muted)]">The new code is written to this repository. It must already exist.</p>
							</div>
						</div>
					{:else}
					<fieldset class="flex gap-4 items-center">
						<legend class="block text-sm font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Repository:</legend>
						<label class="inline-flex items-center gap-2 cursor-pointer">
							<input type="radio" bind:group={repoMode} value="existing" class="text-[var(--color-accent)]" />
							<span class="text-sm">Select existing</span>
						</label>
						<label class="inline-flex items-center gap-2 cursor-pointer">
							<input type="radio" bind:group={repoMode} value="manual" class="text-[var(--color-accent)]" />
							<span class="text-sm">Enter manually</span>
						</label>
					</fieldset>

					{#if repoMode === 'existing'}
						<div>
							<label for="repo_select" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Select Repository</label>
							<select id="repo_select" bind:value={selectedRepoId} class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]">
								<option value={null}>Choose a repository...</option>
								{#each repositories as repo}
									<option value={repo.id}>{repo.name || repo.url} ({repo.branch || 'main'})</option>
								{/each}
							</select>
							{#if repositories.length === 0 && !loadingPickers}
								<p class="text-sm text-[var(--color-warning)] mt-1">No repositories found. <a href="/repositories/registry" class="underline">Add one first</a>.</p>
							{/if}
						</div>
					{/if}

					<RepositoryRepeater bind:repositories={form.repositories} />

					<!-- Optional output repository: non-rewrite `it` only. A rewrite has
					     its own target ("Where the rewritten code goes"), and no other
					     project type offers a second repository. -->
					{#if form.project_type === 'it'}
						<div class="space-y-2 rounded-lg border border-[var(--color-border)] p-4" data-testid="output-repository">
							<div>
								<label for="output_repo_url" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Output repository (optional)</label>
								<input id="output_repo_url" type="text" bind:value={form.output_repo_url} data-testid="output-repo-url" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="https://github.com/org/repo" />
								<p class="mt-1 text-xs text-[var(--color-text-muted)]">Where the project's new code goes, when it writes to a second repository.</p>
							</div>
							<div>
								<label for="output_repo_branch" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Branch</label>
								<input id="output_repo_branch" type="text" bind:value={form.output_repo_branch} data-testid="output-repo-branch" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]" placeholder="main" />
							</div>
						</div>
					{/if}

					<!-- The DERIVED repository scope, stated where the repositories are
					     entered. Read-only text, never an input: the repository count is a
					     FACT the server reads off `repo`, not a claim the user has to keep
					     consistent with a dropdown — that is the coherence rule deleted on
					     2026-09-30, and re-asking it here as a control would rebuild it.
					     It exists because the Scope Level select in §1 reads as a count
					     ("Single repository") to anyone who has not scrolled this far, and
					     that misreading is what made multi-repo support look DELETED. -->
					<p class="text-xs text-[var(--color-text-muted)]" data-testid="derived-repo-scope">
						{#if isMultiRepo}
							Scope: multi-repository project — {form.repositories.filter((r) => r.url.trim())
								.length} repositories named, worked under the coordination mode below.
						{:else}
							Scope: single repository — add a second repo to make this a multi-repo project.
						{/if}
					</p>

					<!-- Coordination mode. Rendered ONLY once a second row carries a URL:
					     with one repository there is nothing to coordinate, and a control
					     that is always on screen teaches the user to ignore it. The labels
					     say what each mode DOES — the enum names ('coordinated' /
					     'independent') mean nothing to the person filling in the form. -->
					{#if isMultiRepo}
						<fieldset class="rounded-lg border border-[var(--color-border)] p-4 space-y-2" data-testid="coordination-mode">
							<legend class="block text-sm font-medium text-[var(--color-text)] px-1 dark:text-[var(--color-text-muted)]">How do these repositories relate?</legend>
							<label class="flex items-start gap-2 cursor-pointer">
								<input
									type="radio"
									name="coordination_mode"
									value="coordinated"
									data-testid="coordination-mode-coordinated"
									checked={form.coordination_mode === 'coordinated'}
									onchange={() => (form.coordination_mode = 'coordinated')}
									class="mt-1 text-[var(--color-accent)]"
								/>
								<span class="text-sm text-[var(--color-text)]">
									They are one product, worked together
									<span class="block text-xs text-[var(--color-text-muted)]">A single piece of work can change more than one of them, and those changes land as one delivery.</span>
								</span>
							</label>
							<label class="flex items-start gap-2 cursor-pointer">
								<input
									type="radio"
									name="coordination_mode"
									value="independent"
									data-testid="coordination-mode-independent"
									checked={form.coordination_mode === 'independent'}
									onchange={() => (form.coordination_mode = 'independent')}
									class="mt-1 text-[var(--color-accent)]"
								/>
								<span class="text-sm text-[var(--color-text)]">
									Each one is its own stream of work
									<span class="block text-xs text-[var(--color-text-muted)]">Work is planned and delivered per repository; nothing has to change two of them at once.</span>
								</span>
							</label>
						</fieldset>
					{/if}

					{/if}

					<div class="flex items-center gap-3">
						<button type="button" data-testid="check-repo-access" onclick={() => checkRepoAccess()} disabled={checkingAccess} class="px-4 py-2 bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors disabled:opacity-50">
							{checkingAccess ? 'Checking…' : 'Check we can read these repositories'}
						</button>
						<span class="text-xs text-[var(--color-text-muted)]">Required — every repository must be public, or private with read access granted to us.</span>
					</div>
					{#if accessCheckError}
						<p class="text-sm text-[var(--color-warning)]" data-testid="repo-access-check-error">Could not run the check: {accessCheckError}</p>
					{/if}
					{#each namedUrls as url (url)}
						{@const verdict = accessVerdicts[url]}
						{@const v = verdict ? describeVerdict(verdict) : { tone: 'muted', text: checkingAccess ? 'Checking…' : 'Not checked yet.' }}
						<p data-testid="repo-access-verdict" data-access-state={verdict?.access_state ?? 'unchecked'} class="text-sm {v.tone === 'warn' ? 'text-[var(--color-warning)]' : v.tone === 'ok' ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]'}">
							<span class="font-mono">{url}</span> — {v.text}
							<GithubAppInstallCta {verdict} />
							{#if !verdict || verdict.access_state === 'error' || installCtaOwner(verdict)}
								<button type="button" data-testid="recheck-repo-access" onclick={() => checkRepoAccess([url])} disabled={checkingAccess} class="ml-2 underline disabled:opacity-50">Re-check</button>
							{/if}
						</p>
					{/each}

					<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					</div>


				</div>
			{/if}
		</div>

		<!-- Library scope -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow mb-4 dark:bg-[var(--color-surface)]">
			<button type="button" onclick={() => toggleSection('library_scope')} class="w-full px-6 py-4 flex items-center justify-between text-left border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h2 class="text-lg font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Library scope</h2>
				<span class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">{openSections.library_scope ? '▲' : '▼'}</span>
			</button>
			{#if openSections.library_scope}
				<div class="px-6 py-4 space-y-4">
					<p class="text-sm text-[var(--color-text-muted)]">Pick library assets to bind to this project. n8n sees only what's bound here on this project's workflows — empty kinds mean nothing is in scope for that kind. You can change bindings later from the project's library tabs.</p>
					{#if unavailableKinds.length > 0}
						<div
							class="rounded border border-[var(--color-danger)] px-3 py-2 text-sm"
							data-testid="library-scope-unavailable"
							role="status"
						>
							<p class="text-[var(--color-danger)] font-medium">
								{unavailableKinds.length === 1 ? '1 asset kind' : `${unavailableKinds.length} asset kinds`}
								could not be loaded: {unavailableKinds.map((k) => LABEL_FOR_KIND[k] ?? k).join(', ')}.
							</p>
							<p class="mt-1 text-xs text-[var(--color-text-muted)]">
								You can still create this project, but nothing from those kinds will be bound to it.
								{#if anyOperatorFault}
									At least one of these needs an operator — retrying will not clear it. Bind them
									later from the project's library tabs once it is fixed.
								{:else}
									Use <em>Retry</em> on the affected picker, or bind them later from the project's
									library tabs.
								{/if}
							</p>
						</div>
					{/if}
					<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
						{#each ASSET_KINDS_ORDERED as entry (entry.kind)}
							<div>
								<AssetMultiPicker
									kind={entry.kind}
									label={entry.label}
									bind:selectedIds={boundAssets[entry.kind]}
									onerror={(cause) => recordPickerError(entry.kind, cause)}
								/>
								{#if entry.hint}
									<p class="mt-1 text-xs text-[var(--color-text-muted)]">{entry.hint}</p>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<!-- Section 7: Rules & Risks -->
		<!-- Typed constraints, dependencies and risks. These were free text,
		     stored, and read by NOTHING; they now reach the agent brief. Shown for
		     every project shape — a rule about the repository matters as much to
		     continuous work as to a deliverable. -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow mb-4 dark:bg-[var(--color-surface)]">
			<button type="button" onclick={() => toggleSection('timeline')} class="w-full px-6 py-4 flex items-center justify-between text-left border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h2 class="text-lg font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">5. Rules & Risks</h2>
				<span class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">{openSections.timeline ? '▲' : '▼'}</span>
			</button>
			{#if openSections.timeline}
				<div class="px-6 py-4">
					<ConstraintsEditor
						bind:constraints={form.constraints}
						bind:dependencies={form.dependencies}
						bind:risks={form.risks}
					/>
				</div>
			{/if}
		</div>

		<!-- Submit -->
		<div class="flex gap-4 justify-end items-center">
			{#if accessBlocked && !isSubmitting}
				<span class="text-sm text-[var(--color-text-muted)]" data-testid="submit-blocked-reason">
					{checkingAccess ? 'Checking repository access…' : 'Submit is available once we can read every repository.'}
				</span>
			{/if}
			<a href={cancelHref} class="px-6 py-3 border border-[var(--color-border-strong)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface)] transition-colors dark:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]">Cancel</a>
			<button type="submit" data-testid="project-form-submit" disabled={isSubmitting || accessBlocked || checkingAccess} class="px-8 py-3 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium">
				{#if isSubmitting}
					<span class="flex items-center gap-2">
						<span class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-border)]"></span>
						{submittingLabel}
					</span>
				{:else}
					{submitLabel}
				{/if}
			</button>
		</div>
	</form>
</div>
