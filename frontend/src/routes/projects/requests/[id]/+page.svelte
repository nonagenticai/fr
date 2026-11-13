<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { setPageTitle } from '$lib/layout/pageTitle.svelte';
	import { goto } from '$app/navigation';
	import { apiClient, ApiError } from '$lib/api/unified-client';
	import type { ProjectCreate, ProjectRequest } from '$lib/types/api';
	import { isApprovalMode } from '$lib/types/api';
	import ProjectForm, {
		type ProjectFormState,
		type BoundAssetsState
	} from '$lib/components/ProjectForm.svelte';
	import ProjectTypeAnalysisWarning from '$lib/components/ProjectTypeAnalysisWarning.svelte';
	import {
		describeVerdict,
		parseRepoAccessDenied,
		type RepoAccessVerdict
	} from '$lib/api/repo-access';
	import GithubAppInstallCta from '$lib/components/github/GithubAppInstallCta.svelte';
	import OutlinePanel from '$lib/components/project-request/OutlinePanel.svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import {
		OUTLINE_STATUSES,
		SUBMITTABLE_STATUSES,
		type Outline
	} from '$lib/components/project-request/types';

	// Review + approve a CP-forwarded draft project request (the CP→fr bridge
	// RECEIVING half). The draft's canonical payload prefills the SHARED
	// <ProjectForm>; approving promotes it to a real project via the same path as
	// POST /api/projects. The reviewer must replace the CP repository_url sentinel
	// before the backend will approve.
	const FR_REPO_SENTINEL = 'https://example.invalid/REPLACE-IN-FR';

	// `[id]` route param is always present.
	let id = $derived($page.params.id as string);

	let request = $state<ProjectRequest | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let rejecting = $state(false);
	let rejectReason = $state('');
	let showReject = $state(false);

	// Re-key <ProjectForm> once the request loads so it mounts with the mapped
	// initial values (props are read once at construction).
	let formReady = $state(false);
	let initial = $state<Partial<ProjectFormState>>({});
	let initialBoundAssets = $state<Partial<BoundAssetsState>>({});

	// Two-stage lifecycle (submit → analyse → outline → decide → promote).
	let status = $derived(request?.status ?? '');
	let canSubmit = $derived(SUBMITTABLE_STATUSES.includes(status));
	let showOutlines = $derived(OUTLINE_STATUSES.includes(status));
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	// Per-repo refusals from a 422 `repo_access_denied` (decision 2026-09-22:
	// a request cannot be submitted unless we can read every repository).
	let deniedRepos = $state<RepoAccessVerdict[]>([]);
	// Set only when the backend says analysis was NOT dispatched — shown as-is,
	// never softened into "analysis started".
	let dispatchNote = $state<string | null>(null);
	let outlines = $state<Outline[]>([]);
	let outlinesLoading = $state(false);
	let outlinesError = $state<string | null>(null);

	// ── Persisted per-repo access verdict ─────────────────────────────────────
	/**
	 * A `project_request_repositories` row as `GET /api/project-requests/:id`
	 * returns it — `handleGetProjectRequest` (backend/src/routes/project-requests.ts)
	 * spreads `loadRequestRepositories(row.id)` onto the request as `repositories`.
	 *
	 * ⚠️ TYPED HERE, not in `$lib/types/api.ts`, because `ProjectRequest` there has
	 * no `repositories` field and that file belongs to other work in flight. This
	 * is the ONE place the page trusts the wire shape; every field is narrowed in
	 * `persistedRepos` before anything renders it. `access_checked_at` arrives as a
	 * JSON string, not the `Date` the backend row carries.
	 */
	type PersistedRequestRepo = {
		url: string;
		branch: string | null;
		name: string | null;
		is_primary: boolean;
		access_state: string;
		access_detail: string | null;
		access_checked_at: string | null;
	};

	/**
	 * The vocabulary the backend can record. This is a FOURTH copy of the same
	 * list: `RepoAccessState` ($lib/api/repo-access.ts), `RepoAccessState`
	 * (backend/src/services/repo-access.ts), `RECORDABLE_ACCESS_STATES`
	 * (backend/src/routes/project-request-repo-gate.ts) and the
	 * `project_request_repositories_access_state_check` CHECK constraint
	 * (migration 123, widened by 126).
	 *
	 * ⛔ SO IT IS USED ONLY TO DECIDE HOW TO WORD A VALUE, NEVER WHETHER TO SHOW
	 * ONE. A state this list has not caught up with is still a fact recorded
	 * against that repository: it is printed verbatim with an explicit
	 * "unrecognised" wording. Filtering it out, or re-labelling it as `unknown`,
	 * would make a widened backend look like a clean request — the same
	 * failure-reads-as-success shape this panel exists to prevent.
	 */
	const KNOWN_ACCESS_STATES: readonly string[] = [
		'unknown',
		'public',
		'private_granted',
		'private_ungranted',
		'platform_repo_forbidden',
		'error'
	];

	/**
	 * `null` means the API reported NO repositories array at all (an older
	 * backend, or a shape we could not read) — which is NOT an all-clear and is
	 * rendered as its own "not reported" line. `[]` is a different statement: the
	 * API reported an empty set, i.e. nothing has been recorded yet, and gets its
	 * own copy too.
	 *
	 * This page had no absence/failure convention of its own to follow — its only
	 * precedent is `dispatchNote` ("shown as-is, never softened into 'analysis
	 * started'") and `outlinesError` ("Could not load outlines"), both of which
	 * state the gap in words rather than rendering silence. There is no
	 * `BlockUnavailable` on this route. So the distinction is made explicitly
	 * here, in that same spirit: three branches, and not one of them can be
	 * reached by an absent verdict.
	 */
	let persistedRepos = $derived.by<PersistedRequestRepo[] | null>(() => {
		const raw = request?.repositories;
		if (!Array.isArray(raw)) return null;
		return raw
			.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
			.filter((r) => typeof r.url === 'string' && r.url.length > 0)
			.map((r) => ({
				url: String(r.url),
				branch: typeof r.branch === 'string' ? r.branch : null,
				name: typeof r.name === 'string' ? r.name : null,
				is_primary: r.is_primary === true,
				// NOT NULL DEFAULT 'unknown' in the schema, so a row always has one;
				// a non-string here means the shape is wrong, which is not a verdict.
				access_state: typeof r.access_state === 'string' ? r.access_state : 'unknown',
				access_detail: typeof r.access_detail === 'string' ? r.access_detail : null,
				access_checked_at:
					typeof r.access_checked_at === 'string' ? r.access_checked_at : null
			}));
	});

	type AccessRow = PersistedRequestRepo & { source: 'stored' | 'submit_response' };

	const fromSubmitBody = (v: RepoAccessVerdict): AccessRow => ({
		url: v.url,
		branch: null,
		name: null,
		is_primary: false,
		access_state: v.access_state,
		access_detail: v.detail || null,
		access_checked_at: null,
		source: 'submit_response'
	});

	/**
	 * ⭐ WHICH SOURCE WINS, AND WHY BOTH EXIST.
	 *
	 * THE RULE, PER REPOSITORY: if the most recent submit attempt returned a
	 * verdict for this url, THAT verdict wins. Otherwise the stored row stands.
	 * Scope, not rank, is what separates the two sources.
	 *
	 * ⛔ WHY NOT "STORED WINS WHEREVER IT CARRIES A VERDICT", WHICH THIS USED TO
	 * SAY. `submitForAnalysis` refetches the request ONLY on success and NEVER in
	 * its `catch`, so once a submit has been refused the stored rows in memory are
	 * strictly OLDER than the 422 body: they were loaded before the check that
	 * refused. Letting them win rendered `private_granted` — "Private — we have
	 * access." — for the very repository the submit had just refused, while the
	 * banner above said we cannot read every repository. That is one signal
	 * masking another, the class this panel exists to remove, and it is why the
	 * precedence is settled by FRESHNESS rather than by richness.
	 *
	 * ⭐ WHAT MAKES "FRESH" SOUND — AN INVARIANT THE CODE ENFORCES, not an inference
	 * about clocks: `deniedRepos` is non-empty ONLY while the in-memory `request`
	 * is older than it. No timestamp comparison is needed. Exactly THREE places
	 * keep that true, and a fourth writer of EITHER piece of state must join this
	 * list or the precedence below is unsound:
	 *   1. `submitForAnalysis` empties `deniedRepos` before every attempt;
	 *   2. `describeSubmitError` — reached only from that function's `catch` — is
	 *      the sole filler, from the 422 of the attempt in flight, and cannot
	 *      coexist with the SUCCESS path that replaces `request`;
	 *   3. `load()` empties it the moment it replaces `request`, because what it
	 *      refetches are the rows the gate itself wrote.
	 *   4. `saveDraft` (fr#1263) refetches through the SAME `GET` on success and
	 *      empties it there for the same reason, immediately after that fetch
	 *      resolves — it deliberately does not reuse `load()` (see its own note),
	 *      so it has to keep this invariant itself. It is the FOURTH writer this
	 *      list demands be named; its FAILURE path writes neither piece of state,
	 *      so a refused save leaves the precedence exactly as it found it.
	 *
	 * ⛔ THAT THIRD LINE IS THE FIX FOR A CLAIM THIS BLOCK USED TO MAKE AND THE
	 * CODE DID NOT KEEP: it asserted submit's two lines were the only writers, so
	 * a non-empty `deniedRepos` "PROVED" the rows predate it. `withdraw()` →
	 * `load()` replaced `request` and cleared nothing, so after a withdraw the
	 * rows were NEWER — and `checkedLabel` then told the reviewer this verdict was
	 * "newer than" the record and "not on the request yet" about a verdict that
	 * WAS on the request. The verdict itself was identical either way, so the cost
	 * was false PROVENANCE rather than a masked refusal; it is recorded because an
	 * almost-true correctness argument reads as proof and is worse than none.
	 *
	 * ⛔ THE STORED ROWS ARE STILL THE BROADER SOURCE, AND THE PRECEDENCE IS NOT
	 * INVERTED WHOLESALE. The gate writes one row per repository the request
	 * names; the 422 body names only what it refused. So a repository the body is
	 * SILENT about keeps its stored verdict — the body's silence is not a verdict —
	 * and every row keeps its stored branch/name/primary either way. Stored rows
	 * also survive a reload, which the body does not (it lives in one `ApiError`),
	 * so after a reload every row is `stored` again and the panel still covers all
	 * of them.
	 *
	 * ⛔ AND THE BODY IS STILL THE ONLY SIGNAL IN SOME CASES, so its path must
	 * stay: a submit refused before any row was ever written (a first submit, a
	 * request created before migration 123 had a writer) fills a row that has
	 * never been checked, and a url the body names that owns no row at all — e.g.
	 * probed through the approve path's `extraUrls` — is APPENDED rather than
	 * dropped.
	 *
	 * ⚠️ The override always moves TOWARDS the newest measurement, including when
	 * that is vaguer than what was stored (a body item with no `access_state`
	 * parses as `unknown`, which reads as UNVERIFIED). That direction is the safe
	 * one: it can cost a reviewer a re-check, never grant a repository a clean
	 * bill of health the gate has just contradicted.
	 *
	 * The list under the submit error is deliberately left in place as well: that
	 * one is "why the button you just pressed failed", this panel is the record.
	 */
	let accessRows = $derived.by<AccessRow[]>(() => {
		const fresh = new Map(deniedRepos.map((d) => [d.url, d]));
		const rows: AccessRow[] = (persistedRepos ?? []).map((r) => {
			const f = fresh.get(r.url);
			// Silence in the body is not a verdict: no entry ⇒ the stored row stands.
			if (!f) return { ...r, source: 'stored' };
			return {
				...r,
				access_state: f.access_state,
				access_detail: f.detail || r.access_detail,
				source: 'submit_response'
			};
		});
		const seen = new Set(rows.map((r) => r.url));
		for (const d of deniedRepos) if (!seen.has(d.url)) rows.push(fromSubmitBody(d));
		return rows;
	});

	/**
	 * HOW MANY entries the `repositories` array carried that `persistedRepos`
	 * could not turn into a row (not an object, or no usable `url`).
	 *
	 * ⛔ WHY THIS IS COUNTED RATHER THAN JUST FILTERED. `.filter()` alone made
	 * "N rows came back and not one was readable" render as the EMPTY-set copy,
	 * "nothing has been checked" — an unreadable payload shown as a calm,
	 * confident nothing-to-see-here, which is the same outage-reads-as-success
	 * shape as the absent-array branch. The JSDoc on `ProjectRequest.repositories`
	 * ($lib/types/api.ts) promises that absent, `[]` and populated are THREE
	 * different answers; a populated-but-unreadable array must not borrow the
	 * wording of `[]`. There is no producer of that shape today — this is the
	 * reader refusing to be the place where one would go unnoticed.
	 */
	let unreadableRepoRows = $derived.by<number>(() => {
		const raw = request?.repositories;
		if (!Array.isArray(raw)) return 0;
		return raw.length - (persistedRepos?.length ?? 0);
	});

	/** Wording for one row. An unrecognised state is named, not translated. */
	function verdictText(r: AccessRow): string {
		if (!KNOWN_ACCESS_STATES.includes(r.access_state)) {
			return `Unrecognised verdict "${r.access_state}" — this page does not know what it means. Treat this repository as UNVERIFIED.`;
		}
		return describeVerdict({
			url: r.url,
			access_state: r.access_state as RepoAccessVerdict['access_state'],
			detail: r.access_detail ?? ''
		}).text;
	}

	function verdictTone(r: AccessRow): 'ok' | 'warn' | 'muted' {
		if (!KNOWN_ACCESS_STATES.includes(r.access_state)) return 'warn';
		return describeVerdict({
			url: r.url,
			access_state: r.access_state as RepoAccessVerdict['access_state'],
			detail: r.access_detail ?? ''
		}).tone;
	}

	/** WHEN it was checked. "Never checked" is said out loud, never left blank. */
	function checkedLabel(r: AccessRow): string {
		if (r.source === 'submit_response') {
			if (!r.access_checked_at) {
				return 'Checked on the submit attempt just now — not recorded on the request.';
			}
			// ⛔ This row DID carry a recorded verdict, which the fresh one now
			// outranks — so the sentence above would be false here. Say that this
			// verdict is the newer one AND which record it is shown instead of;
			// "not recorded on the request" alone would hide that a stale verdict
			// exists, which is the same masking in the opposite direction.
			const d = new Date(r.access_checked_at);
			const was = Number.isNaN(d.getTime()) ? r.access_checked_at : d.toLocaleString();
			return `Re-checked on the submit attempt just now — newer than, and shown instead of, the verdict recorded ${was}. This newer verdict is not on the request yet; reload once the gate has written it.`;
		}
		if (!r.access_checked_at) return 'Never checked.';
		const d = new Date(r.access_checked_at);
		return Number.isNaN(d.getTime())
			? `Checked at ${r.access_checked_at} (unparseable timestamp, shown as stored)`
			: `Checked ${d.toLocaleString()}`;
	}

	// ── Withdraw ──────────────────────────────────────────────────────────────
	// The REQUESTER takes their own request back. Mirrors the backend's
	// EVENT_SOURCES.withdraw exactly (project-request-lifecycle.ts); `approved`
	// and `failed` are deliberately absent there and must stay absent here.
	// This is not the operator road — an operator rejects, or voids the approval.
	const WITHDRAWABLE_STATUSES: readonly string[] = [
		'draft',
		'submitted',
		'analysing',
		'outline_proposed'
	];
	// The backend is the authority (403 `not_the_requester`); this only stops the
	// UI offering a button that would always be refused. `created_by` is nullable
	// — a bridge draft with no subject has no requester and nobody may withdraw it.
	let canWithdraw = $derived(
		WITHDRAWABLE_STATUSES.includes(status) &&
			!!request?.created_by &&
			request.created_by === auth.user?.id
	);
	let showWithdraw = $state(false);
	let withdrawing = $state(false);
	let withdrawError = $state<string | null>(null);

	// ── Save the draft (fr#1263) ──────────────────────────────────────────────
	/**
	 * ⭐ THE DEFECT THIS FIXES. `apiClient.projectRequests.patch`
	 * ($lib/api/unified-client.ts) has existed since this review surface shipped
	 * and had ZERO callers anywhere in `frontend/src`. This page offered exactly
	 * three actions — `submit-request`, `withdraw-request` and reject — so the
	 * 422 wording in `describeSubmitError` below, which read "Fix it below and
	 * save before submitting", named a control that DID NOT EXIST (that sentence
	 * is rewritten there as part of this fix). A CP-forwarded draft whose
	 * `repository_url` is the FR_REPO_SENTINEL was therefore a DEAD END: the page
	 * blanks the field on purpose (`mapPayloadToForm`), the backend refuses the
	 * submit until it is real, and the reviewer was told to save with no way to.
	 *
	 * ⚠️ SCOPE, SAID OUT LOUD RATHER THAN IMPLIED. This control saves the draft's
	 * PRIMARY repository — `repository_url` plus `branch` — and nothing else.
	 * That is the field the sentinel blocks, and it is the only field this PAGE
	 * owns editable state for: every other field lives inside <ProjectForm>,
	 * whose single outbound edge is `onSubmit` (it exposes no bindable form
	 * state), so this file cannot read what the reviewer typed down there. The
	 * button is labelled for what it does. ⛔ Widening it to the whole payload is
	 * a <ProjectForm> change (a bindable state prop), NOT a change to this file,
	 * and must never be faked by duplicating that form's controls up here — two
	 * writers of the same field on one screen is a worse defect than a narrow
	 * save.
	 */
	let draftRepoUrl = $state('');
	let draftRepoBranch = $state('');
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	/**
	 * Names the value that was persisted, not a bare "Saved". A static success
	 * flag goes stale the moment the reviewer types again and then asserts
	 * something untrue about the field in front of them; naming the saved value
	 * keeps the line a RECORD of the last save instead of a claim about the
	 * current input.
	 */
	let savedNote = $state<string | null>(null);

	async function saveDraft() {
		const url = draftRepoUrl.trim();
		const branch = draftRepoBranch.trim();
		saveError = null;
		savedNote = null;
		// A repository is OPTIONAL (George 2026-10-13): a BLANK field saves the
		// draft with NO repository (`repository_url: null`, which also clears a CP
		// sentinel). Never '' — `ProjectCreateFields.repository_url` is
		// `z.string().url().nullish()`, so '' is a 422 where null is "no repo".
		saving = true;
		try {
			await apiClient.projectRequests.patch(id, {
				repository_url: url || null,
				// ⚠️ OMIT a blank branch, never send '' — the same rule as
				// <ProjectForm>'s `buildPayload`. The column defaults to 'main'.
				...(branch ? { branch } : {})
			});
			// ⛔ THE PATCH RESPONSE IS DELIBERATELY DISCARDED, and this does NOT
			// reuse `load()`. Two separate reasons, both load-bearing:
			//
			// 1. `handlePatchProjectRequest` ends in `jsonResponse(updated)` — the
			//    BARE row, with no `repositories` key, where `handleGetProjectRequest`
			//    spreads `loadRequestRepositories(row.id)` onto it. Assigning the
			//    PATCH body to `request` would make `persistedRepos` null and paint
			//    "Not reported … This is NOT a clean bill of health" over a request
			//    whose verdicts are perfectly intact — manufacturing the exact
			//    absence-reads-as-outage signal the panel below exists to prevent.
			// 2. `load()` sets `loading = true`, and the template's `{#if loading}`
			//    unmounts the whole card — <ProjectForm> with it. `{#key request.id}`
			//    does not protect it from an ancestor unmount, so every edit the
			//    reviewer had typed into the form below would be silently discarded
			//    as the price of saving one URL.
			//
			// So: refetch through the same GET, without the skeleton.
			request = await apiClient.projectRequests.get(id);
			// Keeper #4 of the `accessRows` precedence invariant — see that comment.
			// Cleared only once the fetch has RESOLVED, exactly as `load()` argues:
			// clearing on entry would discard the newer 422 verdict and leave the
			// older `request` on screen if the refetch failed.
			deniedRepos = [];
			mapPayloadToForm(request.payload ?? {});
			savedNote = url
				? `Saved — repository is now ${url}${branch ? ` (branch ${branch})` : ''}.`
				: 'Saved — this request has no repository.';
		} catch (err) {
			// `err.message` is already the backend's own `error` string —
			// `unified-client` picks `errorData.error` first — so a refusal reads
			// e.g. "project request can only be edited while draft or failed (is
			// 'submitted')". The only thing it does not say is what to do next.
			saveError =
				err instanceof ApiError
					? notEditable(err)
						? `${err.message}. Reload to see its current state.`
						: err.message
					: 'Failed to save';
		} finally {
			saving = false;
		}
	}

	/**
	 * ⚠️ 422, NOT 409 — and that distinction is the whole reason this is a named
	 * function rather than an inline `err.status === 409` by analogy with
	 * `withdraw()`'s conflict branch. `handlePatchProjectRequest` refuses a
	 * non-draft edit with `ValidationError`, which is `AppError(422)`
	 * (backend/src/utils/errors.ts:82), and its machine-readable cause rides in
	 * `details.code`, because that throw site passes `{ code }` as `details` and
	 * does NOT use `withCode()` (which is what emits a TOP-LEVEL `code`). Both
	 * positions are read here so a later switch to `withCode()` does not silently
	 * turn this into a branch that can never fire.
	 */
	function notEditable(err: ApiError): boolean {
		if (err.status !== 422) return false;
		const d = (err.data ?? {}) as Record<string, unknown>;
		const details = (d.details ?? {}) as Record<string, unknown>;
		const code = 'project_request_not_editable';
		return details.code === code || d.code === code;
	}

	async function withdraw() {
		withdrawing = true;
		withdrawError = null;
		try {
			await apiClient.projectRequests.withdraw(id);
			showWithdraw = false;
			await load();
		} catch (err) {
			withdrawError =
				err instanceof ApiError
					? err.status === 409
						? 'Cannot withdraw: this request has already moved on. Reload to see its current state.'
						: err.message
					: 'Failed to withdraw';
		} finally {
			withdrawing = false;
		}
	}

	// ⚠️ PRE-EXISTING AND DELIBERATELY NOT FIXED HERE — it predates this PR. This
	// mounts ONCE and there is no `$effect` on `id` (which is `$derived` from
	// `$page.params.id` above), so a SAME-ROUTE param change — /requests/A →
	// /requests/B with no remount — leaves BOTH `request` and `deniedRepos`
	// describing request A, and the access panel would attribute A's refusals to
	// B. Fixing it is an `$effect`-on-`id` reload plus a decision about what that
	// does to in-flight submit state: a lifecycle change, not a one-line one.
	onMount(load);

	async function load() {
		loading = true;
		error = null;
		try {
			request = await apiClient.projectRequests.get(id);
			// ⭐ THE THIRD KEEPER OF THE PRECEDENCE INVARIANT (see `accessRows`): the
			// rows just fetched are the ones the gate WROTE, so they supersede any
			// 422 body still in hand. Cleared HERE, immediately after the fetch
			// resolves, and deliberately NOT on entry: on a failed refetch, entry
			// clearing would discard the newer verdict and leave the OLDER `request`
			// on screen — reviving the very masking this precedence removes.
			deniedRepos = [];
			mapPayloadToForm(request.payload ?? {});
			formReady = true;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load the project request';
		} finally {
			loading = false;
		}
		if (request && OUTLINE_STATUSES.includes(request.status)) {
			await loadOutlines();
		}
	}

	async function loadOutlines() {
		outlinesLoading = true;
		outlinesError = null;
		try {
			const res = await apiClient.projectRequests.listOutlines(id);
			outlines = res.items ?? [];
		} catch (err) {
			outlinesError = err instanceof Error ? err.message : 'Failed to load outlines';
		} finally {
			outlinesLoading = false;
		}
	}

	function describeSubmitError(err: unknown): string {
		if (err instanceof ApiError) {
			const d = (err.data ?? {}) as Record<string, unknown>;
			if (err.status === 409) {
				return `Cannot submit: the request is "${String(d.from ?? status)}" and cannot move to "${String(d.to ?? 'submitted')}". Reload to see its current state.`;
			}
			if (err.status === 422) {
				const denied = parseRepoAccessDenied(d);
				if (denied) {
					deniedRepos = denied;
					return 'Cannot submit: we cannot read every repository this request names. Grant us read access (or fix the URL), then submit again.';
				}
				if (typeof d.message === 'string') return d.message;
				const issues = Array.isArray(d.issues)
					? (d.issues as { path?: unknown[]; message?: string }[])
							.map((i) => `${(i.path ?? []).join('.') || 'payload'}: ${i.message ?? 'invalid'}`)
							.join('; ')
					: '';
				// ⚠️ THIS SENTENCE USED TO READ "Fix it below and save before
				// submitting", naming a save control that DID NOT EXIST anywhere on
				// this page (fr#1263) — copy that sent the reviewer looking for a
				// button, which is how a blocked draft became a dead end rather than a
				// task. It now names the control that does exist, and is explicit that
				// the form below has no save of its own.
				return `The request is not a valid project yet${issues ? ` — ${issues}` : ''}. Fix the repository with "Save repository" above; every other field is saved when you approve, using the form below.`;
			}
			return err.message;
		}
		return err instanceof Error ? err.message : 'Failed to submit';
	}

	async function submitForAnalysis() {
		submitting = true;
		submitError = null;
		deniedRepos = [];
		dispatchNote = null;
		try {
			const res = await apiClient.projectRequests.submit(id);
			if (!res.dispatched) {
				dispatchNote =
					res.dispatch_note ?? 'Submitted, but analysis was not dispatched.';
			}
			request = await apiClient.projectRequests.get(id);
			if (OUTLINE_STATUSES.includes(request.status)) await loadOutlines();
		} catch (err) {
			submitError = describeSubmitError(err);
		} finally {
			submitting = false;
		}
	}

	function mapPayloadToForm(p: Partial<ProjectCreate> & { name?: string }) {
		// repository_url defaults to '' (not the sentinel) so the placeholder never
		// reads as a real URL. The field is OPTIONAL (George 2026-10-13): left blank,
		// the project is created without a repository.
		const repoUrl = p.repository_url && p.repository_url !== FR_REPO_SENTINEL ? p.repository_url : '';
		// fr#1263 — the page-level Save control's editable state, seeded from the
		// SAME blanked value as the form below, so the sentinel never appears as a
		// plausible URL in either place. Re-seeded on every load/save refetch, so
		// after a successful save the input shows what the server actually stored
		// rather than what was typed.
		draftRepoUrl = repoUrl;
		draftRepoBranch = p.branch ?? 'main';
		initial = {
			shape: p.shape ?? 'deliverable',
			name: p.name ?? '',
			description: p.description ?? '',
			project_type: p.project_type ?? '',
			scope_level: p.scope_level ?? '',
			approvers: p.approvers ?? [],
			problem_statement: p.problem_statement ?? '',
			desired_outcome: p.desired_outcome ?? '',
			business_case: p.business_case ?? '',
			success_criteria: p.success_criteria ?? [],
			acceptance_criteria: p.acceptance_criteria ?? [],
			// ⛔ THESE FOUR MUST STAY IN SYNC WITH `BRIEF_SCOPE_FIELDS`
			// (backend/src/routes/projects.ts) AND `SCOPE_FIELD_KEYS`
			// (ProjectForm.svelte). Added 2026-09-23 with the fields themselves.
			//
			// WHY THIS LINE EXISTS AT ALL: this function maps a FIXED list, so a
			// field absent from it is silently DESTROYED at reviewer approval —
			// `approve()` below posts the FORM-built payload, not the stored one.
			// An NL-intake draft that captured `in_scope` would have lost it here,
			// with no error, which is worse than never accepting the field: the
			// requester would see it accepted and the agent would never receive it.
			// A new field on the request form is not done until it appears HERE.
			in_scope: p.in_scope ?? [],
			out_of_scope: p.out_of_scope ?? [],
			high_level_requirements: p.high_level_requirements ?? [],
			assumptions: p.assumptions ?? [],
			// Primary from repository_url/branch, then every repo.additional row —
			// the review page must show the reviewer ALL the repositories the
			// request names, not just the first.
			repositories: [
				{
					url: repoUrl,
					branch: p.branch ?? 'main',
					name: '',
					is_primary: true,
					// A pinned request keeps its pin (George 2026-11-07); an older draft
					// may carry the resolved commit as `sha` instead.
					pin: p.repo?.primary?.pin ?? p.repo?.primary?.sha ?? ''
				},
				...(p.repo?.additional ?? []).map((r) => ({
					url: r.url,
					branch: r.branch ?? '',
					name: r.name ?? '',
					is_primary: false,
					pin: r.pin ?? r.sha ?? ''
				}))
			],
			// ⚠️ LEGACY free-text values are carried as `custom` constraints — i.e.
			// labelled "Guidance — not enforced" — never guessed into a typed kind.
			// Reading "do not upgrade python" as pin_language_version would invent
			// a checkable promise the requester never made.
			constraints: (p.constraints ?? []).map((c) =>
				typeof c === 'string' ? { kind: 'custom' as const, text: c } : c
			),
			// A legacy dependency string has no kind; `service` is recorded with a
			// note saying so rather than silently pretending we knew.
			dependencies: (p.dependencies ?? []).map((d) =>
				typeof d === 'string'
					? { name: d, kind: 'service' as const, note: 'kind not specified (from free text)' }
					: d
			),
			risks: p.risks ?? [],
			// The requester's sign-off choice survives review; absent ⇒ the form
			// default (brief_and_closure), which approve() then sends.
			...(isApprovalMode(p.approval_mode) ? { approval_mode: p.approval_mode } : {})
		};
		initialBoundAssets = (p.bound_assets as Partial<BoundAssetsState>) ?? {};
	}

	async function approve(payload: ProjectCreate): Promise<void> {
		const res = await apiClient.projectRequests.approve(id, payload);
		// Promoted → land on the new project.
		goto(res.project_id ? `/projects/${res.project_id}` : '/');
	}

	async function reject() {
		if (!rejectReason.trim()) return;
		rejecting = true;
		error = null;
		try {
			await apiClient.projectRequests.reject(id, rejectReason.trim());
			goto('/projects/requests');
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Failed to reject';
		} finally {
			rejecting = false;
		}
	}

	// The DIRECT approve/reject form is the legacy road, for a draft (e.g. one
	// forwarded from CommonPractice) or a failed promotion. Once a request is
	// submitted for analysis the OUTLINE owns it: approving directly here would
	// bypass the outline and strand its approval in the queue. The backend
	// refuses the same transition (409 outline_in_flight); this only stops the
	// UI offering it. Everything not in DIRECT_DECIDABLE renders read-only.
	const DIRECT_DECIDABLE: readonly string[] = ['draft', 'failed'];
	const decided = $derived(!DIRECT_DECIDABLE.includes(request?.status ?? ''));

	// Publish this route's entity name to the single title element in the
	// root layout. Always the CURRENT pathname: the resolver drops an override
	// whose path no longer matches, which is what makes a stale tab title
	// impossible. `null` while loading falls back to the static map entry.
	$effect(() => {
		setPageTitle($page.url.pathname, request?.payload?.name ?? null);
	});
</script>

<div class="max-w-4xl mx-auto space-y-6 pb-12">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-[var(--color-text)]">Review Project Request</h1>
			<p class="mt-2 text-[var(--color-text-muted)]">
				<!-- UI review 2026-10-07: "Edit any field" was shown on submitted/
				     decided requests too, where every edit is refused (422
				     project_request_not_editable). `decided` is the same gate the
				     read-only branch below uses; the original copy stays while loading. -->
				{#if request && decided}
					Forwarded from Common Practice. This request can no longer be edited.
				{:else}
					Forwarded from Common Practice. Edit any field, set a real repository, then approve to create the project.
				{/if}
			</p>
		</div>
		<a href="/projects/requests" class="px-4 py-2 text-[var(--color-text)] border border-[var(--color-border-strong)] rounded-lg hover:bg-[var(--color-surface)] transition-colors">Back</a>
	</div>

	{#if error}
		<div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-4">
			<p class="text-[var(--color-danger)] text-sm">{error}</p>
		</div>
	{/if}

	{#if loading}
		<div class="h-40 bg-[var(--color-surface)] rounded-lg animate-pulse"></div>
	{:else if request}
		<!-- Provenance + status -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow p-4 dark:bg-[var(--color-surface)] space-y-2">
			<div class="flex flex-wrap items-center gap-3">
				<span class="text-sm text-[var(--color-text-muted)]">Status</span>
				<span class="px-3 py-1 rounded-full text-sm font-semibold bg-[var(--color-surface-strong)] text-[var(--color-text)]" data-testid="request-status">{status.replace(/_/g, ' ')}</span>
				<span class="text-sm text-[var(--color-text-muted)]">source: {request.source} · ref {request.external_ref}</span>
				{#if canSubmit}
					<!--
						fr#1263 — SAVE, beside Submit. `canSubmit` is the gate on purpose:
						SUBMITTABLE_STATUSES is `['draft','failed']`, which is EXACTLY the
						set `handlePatchProjectRequest` accepts an edit for, so the control
						is offered precisely where the backend will take it. The backend
						stays the authority (422 `project_request_not_editable`); this only
						stops the UI offering an edit that would always be refused.
					-->
					<button
						type="button"
						onclick={saveDraft}
						disabled={saving || submitting}
						class="ml-auto px-4 py-2 border border-[var(--color-border-strong)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface)] disabled:opacity-50"
						data-testid="save-request">{saving ? 'Saving...' : 'Save repository'}</button>
					<button
						type="button"
						onclick={submitForAnalysis}
						disabled={submitting || saving}
						class="px-4 py-2 bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
						data-testid="submit-request">{submitting ? 'Submitting...' : 'Submit for analysis'}</button>
				{/if}
				{#if canWithdraw && !showWithdraw}
					<button
						type="button"
						onclick={() => (showWithdraw = true)}
						class="{canSubmit ? '' : 'ml-auto '}px-4 py-2 border border-[var(--color-border-strong)] text-[var(--color-danger)] rounded-lg hover:bg-[var(--color-surface)]"
						data-testid="withdraw-request">Withdraw request</button>
				{/if}
			</div>
			{#if canSubmit}
				<!--
					⭐ THE CONTROL THE 422 COPY ALREADY ASSUMED. `describeSubmitError`
					used to tell the reviewer to "Fix it below and save before
					submitting" while nothing on this page saved anything —
					`projectRequests.patch` had zero callers in the whole frontend. A CP
					draft arrives with `repository_url` set to the FR_REPO_SENTINEL,
					which `mapPayloadToForm` blanks on purpose; without a save the
					reviewer could neither submit (the backend refuses the sentinel) nor
					persist a replacement. This is that save.

					⚠️ Narrow BY DESIGN and labelled as such: the fields <ProjectForm>
					owns are not readable from here (its only outbound edge is
					`onSubmit`), so this edits the primary repository and says so rather
					than implying it saves the whole draft.
				-->
				<div
					class="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-border-strong)] p-3"
					data-testid="draft-repository-editor">
					<div class="flex-1 min-w-[16rem]">
						<label
							for="draft_repository_url"
							class="block text-sm font-medium text-[var(--color-text)]">Repository URL <span class="font-normal text-[var(--color-text-muted)]">(optional)</span></label>
						<input
							id="draft_repository_url"
							type="url"
							bind:value={draftRepoUrl}
							placeholder="https://github.com/org/repo"
							class="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
							data-testid="draft-repository-url" />
					</div>
					<div class="w-40">
						<label
							for="draft_repository_branch"
							class="block text-sm font-medium text-[var(--color-text)]">Branch</label>
						<input
							id="draft_repository_branch"
							type="text"
							bind:value={draftRepoBranch}
							placeholder="main"
							class="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
							data-testid="draft-repository-branch" />
					</div>
					<p class="w-full text-xs text-[var(--color-text-muted)]">
						Saves the draft's primary repository (leave it blank for a project with no
						repository). Every other field is saved when you approve, using the form below.
					</p>
				</div>
			{/if}
			{#if saveError}
				<p class="text-sm text-[var(--color-danger)]" data-testid="save-error">{saveError}</p>
			{/if}
			{#if savedNote}
				<p class="text-sm text-[var(--color-success-text)]" data-testid="save-ok">{savedNote}</p>
			{/if}
			{#if canWithdraw && showWithdraw}
				<!--
					CONFIRM, because withdrawing is TERMINAL: `withdrawn` transitions
					nowhere and any outline
					approval still waiting on a human is voided out of their queue.
				-->
				<div
					class="space-y-2 rounded-lg border border-[var(--color-border-strong)] p-3"
					data-testid="withdraw-confirm">
					<p class="text-sm text-[var(--color-text)]">
						Withdraw this request? This cannot be undone — the request is closed for
						good, and any outline approval still waiting on a decision is removed
						from their queue.
					</p>
					<div class="flex gap-2 justify-end">
						<button
							type="button"
							onclick={() => (showWithdraw = false)}
							disabled={withdrawing}
							class="px-4 py-2 border border-[var(--color-border-strong)] rounded-lg hover:bg-[var(--color-surface)] disabled:opacity-50"
							>Cancel</button>
						<button
							type="button"
							onclick={withdraw}
							disabled={withdrawing}
							class="px-4 py-2 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded-lg disabled:opacity-50"
							data-testid="withdraw-confirm-button"
							>{withdrawing ? 'Withdrawing...' : 'Confirm withdraw'}</button>
					</div>
				</div>
			{/if}
			{#if withdrawError}
				<p class="text-sm text-[var(--color-danger)]" data-testid="withdraw-error">
					{withdrawError}
				</p>
			{/if}
			{#if submitError}
				<p class="text-sm text-[var(--color-danger)]" data-testid="submit-error">{submitError}</p>
				{#if deniedRepos.length > 0}
					<ul class="text-sm space-y-1" data-testid="submit-denied-repos">
						{#each deniedRepos as r (r.url)}
							<li data-access-state={r.access_state}>
								<span class="font-mono">{r.url}</span> — {describeVerdict(r).text}
								<GithubAppInstallCta verdict={r} />
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
			{#if dispatchNote}
				<p class="text-sm text-[var(--color-warning-text)] bg-[var(--color-warning-bg)] rounded p-2" data-testid="dispatch-note">
					Submitted — analysis has NOT started: {dispatchNote}
				</p>
			{/if}
			{#if request.external_origin}
				<details class="text-sm">
					<summary class="cursor-pointer text-[var(--color-text-muted)]">Provenance (Common Practice)</summary>
					<pre class="mt-2 p-3 bg-[var(--color-surface)] rounded text-xs overflow-x-auto dark:bg-[var(--color-bg)]">{JSON.stringify(request.external_origin, null, 2)}</pre>
				</details>
			{/if}
			{#if request.status === 'failed' && request.error}
				<p class="text-sm text-[var(--color-danger)]">Last approve attempt failed: {request.error}</p>
			{/if}
			{#if request.status === 'promoted' && request.project_id}
				<p class="text-sm text-[var(--color-success-text)]">
					Promoted → <a class="underline" href="/projects/{request.project_id}">view project</a>
				</p>
			{/if}
		</div>

		<!--
			⭐ THE READER for `project_request_repositories.access_state` /
			`access_detail` / `access_checked_at`. The submit gate has computed a
			verdict per repository since migration 123 created the table; until this
			panel the columns had no rendering reader at all, so "a reviewer can now
			see which repo refused" was true of the API and of nothing a human looks
			at. Every field the schema keeps must have a named reader, and the test
			that ships with a field is not one.
		-->
		<section
			class="bg-[var(--color-bg)] rounded-lg shadow p-4 dark:bg-[var(--color-surface)] space-y-2"
			data-testid="request-repo-access-panel">
			<h2 class="text-sm font-semibold text-[var(--color-text)]">Repository access</h2>
			{#if persistedRepos === null}
				<!--
					⛔ ABSENCE IS NOT SUCCESS. No `repositories` array came back, so this
					page knows NOTHING about any repository's readability. It says so.
					A branch that rendered an empty list here would turn an outage — or
					an older backend — into an on-screen claim that every repo is fine.
				-->
				<p
					class="text-sm text-[var(--color-warning-text)] bg-[var(--color-warning-bg)] rounded p-2"
					data-testid="request-repo-access-unreported">
					Not reported — this request came back without its per-repository access
					verdicts, so we cannot say whether we can read the repositories it
					names. This is NOT a clean bill of health; reload, and if it persists
					the request API is not returning the recorded verdicts.
				</p>
			{/if}
			{#if accessRows.length > 0}
				<ul class="text-sm space-y-2" data-testid="request-repo-access">
					{#each accessRows as r (r.url)}
						<li
							class="rounded border border-[var(--color-border-strong)] p-2 space-y-1"
							data-testid="request-repo-access-row"
							data-access-state={r.access_state}
							data-source={r.source}>
							<div class="flex flex-wrap items-baseline gap-2">
								<span class="font-mono text-[var(--color-text)]">{r.url}</span>
								{#if r.name}<span class="text-[var(--color-text-muted)]">{r.name}</span>{/if}
								{#if r.branch}<span class="text-[var(--color-text-muted)]">branch {r.branch}</span>{/if}
								{#if r.is_primary}
									<span
										class="px-2 py-0.5 rounded-full text-xs bg-[var(--color-surface-strong)] text-[var(--color-text)]"
										data-testid="request-repo-access-primary">primary</span>
								{/if}
								<!--
									The RAW recorded token, always, next to the wording — so a
									state no front-end release knows about is still on screen.
								-->
								<span
									class="px-2 py-0.5 rounded-full text-xs font-mono bg-[var(--color-surface-strong)] text-[var(--color-text)]"
									data-testid="request-repo-access-state">{r.access_state}</span>
							</div>
							<p
								class={verdictTone(r) === 'ok'
									? 'text-[var(--color-success-text)]'
									: 'text-[var(--color-warning-text)]'}
								data-testid="request-repo-access-text">{verdictText(r)}</p>
							{#if r.access_detail}
								<!-- `access_detail` — the gate's own reason, verbatim. -->
								<p
									class="text-xs text-[var(--color-text-muted)] font-mono"
									data-testid="request-repo-access-detail">{r.access_detail}</p>
							{/if}
							<p
								class="text-xs text-[var(--color-text-muted)]"
								data-testid="request-repo-access-checked">{checkedLabel(r)}</p>
							<GithubAppInstallCta verdict={{ url: r.url, access_state: r.access_state }} />
						</li>
					{/each}
				</ul>
			{:else if persistedRepos !== null && unreadableRepoRows === 0}
				<!--
					The API reported an EMPTY set. Distinct copy from the branch above,
					because it is a distinct statement: nothing has been checked yet
					(a request that has never been submitted has no rows), which is not
					the same as every repository being readable. ⛔ Guarded on
					`unreadableRepoRows === 0`: an array that arrived WITH entries and
					yielded no readable row is a different statement again, and must not
					borrow this wording — see the branch below.
				-->
				<p class="text-sm text-[var(--color-text-muted)]" data-testid="request-repo-access-none">
					No repository access verdict has been recorded for this request yet —
					nothing has been checked. Submitting for analysis records one per
					repository.
				</p>
			{/if}
			{#if unreadableRepoRows > 0}
				<!--
					⛔ THE THIRD STATE: rows ARRIVED and could not be read. Said out loud
					because the alternative is silence — either the empty-set copy
					("nothing has been checked", a calm and confident lie) or, when other
					rows did parse, a list that quietly omits some repositories. Shown
					alongside the list too, so a PARTIAL drop is visible as well.
				-->
				<p
					class="text-sm text-[var(--color-warning-text)] bg-[var(--color-warning-bg)] rounded p-2"
					data-testid="request-repo-access-unreadable">
					{unreadableRepoRows} repository {unreadableRepoRows === 1 ? 'row' : 'rows'}
					came back that this page could not read — no usable repository url — so no
					access verdict is shown for {unreadableRepoRows === 1 ? 'it' : 'them'}.
					Data DID arrive: this is not an empty set, and it is NOT a clean bill of
					health. Reload, and if it persists the request API is returning
					repository rows in a shape this page does not understand.
				</p>
			{/if}
		</section>

		{#if showOutlines}
			{#if outlinesLoading}
				<div class="h-24 bg-[var(--color-surface)] rounded-lg animate-pulse"></div>
			{:else if outlinesError}
				<p class="text-sm text-[var(--color-danger)]">Could not load outlines: {outlinesError}</p>
			{:else}
				<OutlinePanel {outlines} />
			{/if}
		{/if}

		{#if decided}
			<div class="text-center py-10 text-[var(--color-text-muted)]">
				This request has been {request.status} and can no longer be edited.
			</div>
		{:else}
			<!-- Reject -->
			<div class="bg-[var(--color-bg)] rounded-lg shadow p-4 dark:bg-[var(--color-surface)]">
				{#if showReject}
					<div class="space-y-2">
						<label for="reject_reason" class="block text-sm font-medium text-[var(--color-text)]">Reject reason</label>
						<textarea id="reject_reason" bind:value={rejectReason} rows="2" class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]" placeholder="Why is this request being rejected?"></textarea>
						<div class="flex gap-2 justify-end">
							<button onclick={() => (showReject = false)} class="px-4 py-2 border border-[var(--color-border-strong)] rounded-lg hover:bg-[var(--color-surface)]">Cancel</button>
							<button onclick={reject} disabled={rejecting || !rejectReason.trim()} class="px-4 py-2 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded-lg disabled:opacity-50">Confirm reject</button>
						</div>
					</div>
				{:else}
					<button onclick={() => (showReject = true)} class="text-sm text-[var(--color-danger)] hover:underline">Reject this request</button>
				{/if}
			</div>

			<!--
				Conversational intake (D5): warn when the drafted project won't fire the
				*_start_request_analysis card. Advisory — based on the draft's extracted
				type; the reviewer can change it on the form below. The gate is
				tenant-dependent (every EXEC-tenant project orchestrates), so the warning
				reads the signed-in tenant and mirrors the backend rule exactly.
			-->
			<ProjectTypeAnalysisWarning
				projectType={request.payload?.project_type}
				cveSweep={request.payload?.cve_sweep}
			/>

			{#if formReady}
				{#key request.id}
					<ProjectForm
						{initial}
						{initialBoundAssets}
						submitLabel="Approve & create project"
						submittingLabel="Approving..."
						cancelHref="/projects/requests"
						onSubmit={approve}
						ownerTenantId={request.tenant_id}
					/>
				{/key}
			{/if}
		{/if}
	{/if}
</div>
