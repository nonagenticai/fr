<!--
  The project portfolio, rendered on the tenant home (`/`). Cards show each
  project's CREATED and UPDATED date+time; the list is searchable and sortable
  client-side (created/updated, newest/oldest — see `$lib/projects/portfolio-view`).
  The whole card is one link to /projects/<id>.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { workspaces } from '$lib/stores/workspaces.svelte';
	import { apiClient, ApiError } from '$lib/api/unified-client';
	import { toast } from '$lib/stores/toast.svelte';
	import type { Project } from '$lib/types/api';
	import { phaseTitles } from '$lib/projects/phaseTitles.svelte';
	// The sanctioned states, not a fourth hand-rolled copy of them. This page had
	// its own pulse-div skeleton grid and its own red-paragraph error card while
	// $lib/components/ui exported all three; `/approvals` already renders them off
	// a `'loading' | 'ready' | 'unreadable'` state and is the pattern followed here.
	import { Skeleton, EmptyState, ErrorState, Input, Select } from '$lib/components/ui';
	import WorkspaceEmptyHint from '$lib/components/projects/WorkspaceEmptyHint.svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import DeliveredBadge from '$lib/components/projects/DeliveredBadge.svelte';
	// The shared three-state repository reader. See its header for why sharing is
	// correct here and what the `none` / `unknown` split is protecting.
	import { readProjectRepoView, repoLabelFromUrl } from '$lib/projects/repo-view';
	import { isRealProject } from '$lib/projects/is-real-project';
	// The list's pure search/sort/timestamp logic (unit-tested, no fetching).
	import {
		DEFAULT_PORTFOLIO_SORT,
		PORTFOLIO_SORT_OPTIONS,
		filterProjects,
		sortProjects,
		projectTimestamp,
		type PortfolioSort,
	} from '$lib/projects/portfolio-view';

	let {
		asksPerProject = null,
		projectNames = $bindable(new Map())
	}: {
		/** Open asks per project id; null = not known (asks unread, or only partly read). */
		asksPerProject?: ReadonlyMap<string, number> | null;
		/**
		 * OUT: id → name of the real projects this card read, so the tenant home can
		 * label its asks without a second GET /api/projects. Empty until (or unless) read.
		 */
		projectNames?: ReadonlyMap<string, string>;
	} = $props();

	let projects: Project[] = $state([]);

	/**
	 * ⭐ FOUR STATES, NOT TWO — and the two that were missing are the defect.
	 *
	 * `loading` (never read) and `ready` (the list, however long) are the easy
	 * pair. The two an empty `items` array collapses into are:
	 *
	 *   `unreadable`    the read FAILED. A failed load is not an empty workspace.
	 *   archived-only   the read SUCCEEDED and every project was withheld by the
	 *                   route's default `ne(status,'archived')` predicate.
	 *
	 * ⛔ MEASURED ON PROD 2026-09-30: 133 projects, EVERY ONE `archived`. So the
	 * primary nav item told every user "No projects yet / Create Your First
	 * Project" while the system held 133 projects (fr#1259). An absence rendered
	 * as a result.
	 *
	 * ⚠️ AND THERE IS A FIFTH — see `emptyKind`. The route's board-liveness drop
	 * withholds ACTIVE rows AFTER `archived_excluded` is counted, so "every project
	 * I have is active but its board is gone" was a THIRD thing collapsing into the
	 * first-run pitch. `listState` does not carry it; `deadBoardExcluded` does.
	 */
	let listState = $state<'loading' | 'ready' | 'unreadable'>('loading');

	/**
	 * The raw thrown value, handed to `ErrorState` (which formats `unknown`).
	 * Kept beside `listState`, never instead of it: a truthy message was the old
	 * discriminator, and an ApiError with an empty `message` made the page fall
	 * through to the empty state — i.e. a failure renderable as "you have none".
	 */
	let loadError = $state<unknown>(null);

	/**
	 * `archived_excluded` from the list envelope: how many rows THIS request
	 * withheld because they are archived.
	 *
	 * ⚠️ `null` MEANS "THE SERVER DID NOT SAY", WHICH IS NOT ZERO. A bundle can be
	 * served against a backend predating the field, so `?? 0` here would restore
	 * the exact bug — an unknown read as a confident "nothing was withheld", and
	 * the first-run pitch back on screen over 133 projects. Only an explicit 0
	 * licenses the first-run message.
	 */
	let archivedExcluded = $state<number | null>(null);

	/**
	 * `dead_board_excluded` from the list envelope: how many ACTIVE projects THIS
	 * request withheld because their Planka board is confirmed gone.
	 *
	 * ⛔ WHY A SECOND COUNT EXISTS, AND WHY `archivedExcluded` COULD NOT CARRY IT.
	 * The route counts `archived_excluded` BEFORE its board-liveness drop runs, and
	 * that drop exempts every archived row — so a workspace whose only projects are
	 * active-with-a-dead-board answers `{items:[], total:0, archived_excluded:0}`.
	 * An EXPLICIT zero is exactly what licenses the first-run pitch below, so the
	 * page stated "Nothing has been created in this workspace" about a workspace
	 * holding live projects. That is fr#1259's own defect class — an absence
	 * rendered as a result — reappearing one predicate lower.
	 *
	 * ⚠️ `null` MEANS "THE SERVER DID NOT SAY", AND AGAIN `?? 0` IS THE BUG. A
	 * bundle can be served against a backend carrying `archived_excluded` but not
	 * this field. The first-run message now requires BOTH counts to be explicit 0.
	 */
	let deadBoardExcluded = $state<number | null>(null);

	/** `?include_archived=1` — set by the archived-only state's own action. */
	let showArchived = $state(false);

	let deletingId = $state<string | null>(null);
	let projectToDelete = $state<Project | null>(null);

	/** Client-side search over the fetched list; blank = everything. */
	let query = $state('');
	/** Client-side order; the historical newest-created-first stays the default. */
	let sort = $state<PortfolioSort>(DEFAULT_PORTFOLIO_SORT);

	/**
	 * The API may still list a tenant's v3 continuous-improvement stream boards as
	 * read-only `kind:'continuous'` entries; the portfolio shows real projects only.
	 *
	 * ⛔ The UNFILTERED list, deliberately. `listIsEmpty`/`emptyKind` below are
	 * computed from it, so a search that matches nothing can never be mistaken for
	 * "this workspace has no projects" — the defect class this page documents at
	 * length. Searching and sorting narrow `visibleProjects`, not this.
	 */
	const regularProjects = $derived(projects.filter((p) => p.kind !== 'continuous'));

	/** What the grid actually renders: the search narrowed, then ordered. */
	const visibleProjects = $derived(sortProjects(filterProjects(regularProjects, query), sort));

	/**
	 * Which empty state an empty `items` actually is. THREE, not two.
	 *
	 * ⛔ THE ORDER IS THE CONTRACT, not a formatting choice.
	 *
	 *  1. A CONFIRMED dead-board withholding outranks everything else: it is the
	 *     only one of the three that names a live fault someone can go and fix, and
	 *     collapsing it into `archived-only` would hide it behind an expected state.
	 *  2. Archived-only next — including `archivedExcluded === null`, since an
	 *     unknown must never fall through to the first-run pitch.
	 *  3. `deadBoardExcluded === null` reaching here means archived was an explicit
	 *     0 and the board withholding is UNKNOWN. That is NOT a licence for the
	 *     first-run pitch, and it is the whole repair: the previous code had only
	 *     `archivedExcluded === 0` to check, so a backend that never reported the
	 *     board count (or a workspace with only dead-board projects, which reports
	 *     `archived_excluded: 0`) rendered "Nothing has been created in this
	 *     workspace" over live projects.
	 *  4. `first-run` therefore requires BOTH counts to be an explicit 0 — the
	 *     server measured that this request withheld nothing, on either ground.
	 */
	type ProjectsEmptyKind = 'boards-unreachable' | 'archived-only' | 'first-run';
	const emptyKind = $derived.by((): ProjectsEmptyKind => {
		if (deadBoardExcluded !== null && deadBoardExcluded > 0) return 'boards-unreachable';
		if (archivedExcluded === null || archivedExcluded > 0) return 'archived-only';
		if (deadBoardExcluded === null) return 'boards-unreachable';
		return 'first-run';
	});

	/**
	 * ⛔ Neither variant may say nothing was created, and both must point at the
	 * BOARD side rather than at project creation — the user cannot fix this by
	 * making another project, and offering that is what made the original bug
	 * actively misleading rather than merely wrong.
	 */
	const deadBoardTitle = $derived(
		deadBoardExcluded === null
			? 'Whether any projects are hidden is unknown'
			: 'Projects hidden — their boards are unreachable'
	);
	const deadBoardBody = $derived.by(() => {
		if (deadBoardExcluded === null) {
			return (
				'Nothing was withheld for being archived, but this response did not say whether any ' +
				'active projects were hidden because their Kanban board could not be confirmed live. ' +
				'This is not a statement that nothing has been created in this workspace.'
			);
		}
		const one = deadBoardExcluded === 1;
		const alsoArchived =
			archivedExcluded !== null && archivedExcluded > 0
				? ` A further ${archivedExcluded} archived ${
						archivedExcluded === 1 ? 'project is' : 'projects are'
					} hidden here by default.`
				: '';
		return (
			`${deadBoardExcluded} active ${one ? 'project is' : 'projects are'} hidden here because ` +
			`${one ? 'its Kanban board no longer exists' : 'their Kanban boards no longer exist'}, so ` +
			`opening ${one ? 'it' : 'them'} would fail. This workspace has active projects — the ` +
			`board behind ${one ? 'one' : 'them'} needs restoring.${alsoArchived}`
		);
	});

	/**
	 * ⭐ THE DISCLOSURE, AND WHY IT IS KEYED ON THE COUNT RATHER THAN ON A STATE.
	 *
	 * ⛔ MEASURED ON PROD 2026-09-30, AFTER fr#1259 SHIPPED:
	 *     GET /api/projects → {"total":1,"archived_excluded":133,"dead_board_excluded":0}
	 * ONE active project — so the page renders the POPULATED GRID and none of the
	 * five states — and "Show archived projects" existed ONLY inside the
	 * `archived-only` branch, which is unreachable the moment any active project
	 * exists. 133 projects were counted by the route, reported in the envelope,
	 * and had NO UI PATH AT ALL on the page whose job is to list projects.
	 * `archived_excluded: 133` was displayed nowhere. That is fr#1259's own defect
	 * class one level up: the page knew something and did not say it.
	 *
	 * ⚠️ GATED ON `listState === 'ready'` DELIBERATELY. The catch arm does NOT reset
	 * `archivedExcluded`, and its comment justifies that by MEASUREMENT: every
	 * reader requires a successful read. A reader that fired while `unreadable`
	 * would state a number THIS request never measured and would silently
	 * invalidate that comment. Keep the gate; there is an arm pinning it.
	 *
	 * ⚠️ `null` IS "THE SERVER DID NOT SAY", so it gets the unknown wording and
	 * still offers the view. `?? 0` here is precisely how the original bug worked.
	 *
	 * ⚠️ Suppressed under `showArchived`: that request withholds nothing, so the
	 * count is 0 (or, on an older backend, unknown) and `projects-showing-archived`
	 * is already on screen with the inverse action.
	 *
	 * THE ONE STATE EXCLUSION: `archived-only` already carries this exact count AND
	 * this exact action, so rendering both would put two identical "Show archived
	 * projects" buttons on screen — shipping a duplicated affordance as the fix for
	 * a missing one. Suppressed there, nowhere else.
	 */
	const listIsEmpty = $derived(regularProjects.length === 0);
	const showArchivedDisclosure = $derived(
		listState === 'ready' &&
			!showArchived &&
			(archivedExcluded === null || archivedExcluded > 0) &&
			!(listIsEmpty && emptyKind === 'archived-only')
	);

	/**
	 * ⭐ ONE REPOSITORY ON THE CARD WAS A CLAIM THE PAYLOAD NEVER MADE (unit F2).
	 *
	 * `projects.repository_url` / `.branch` are the DENORMALISED PRIMARY — a cache
	 * of whichever `project_repositories` row is flagged `is_primary` (migration
	 * 072). The card printed that one string and nothing else, so a project with
	 * three attached repositories rendered identically to a project with one. Not
	 * a truncation the reader could see: there was no "…", no count, no affordance.
	 *
	 * The three-state reading itself lives in `$lib/projects/repo-view.ts`, shared
	 * with `/projects/[id]/settings` and `/admin/assets/projects`. Read that
	 * header before touching what the `none` / `unknown` split means here. The
	 * card calls it inline per row — see `readProjectRepoView` in the {#each}.
	 */

	$effect(() => {
		void workspaces.scopeKey;
		untrack(() => {
			void phaseTitles.ensureLoaded();
			void loadProjects();
		});
	});

	/** Bumped per load: a reply for an earlier workspace must not overwrite a later one. */
	let loadSeq = 0;

	async function loadProjects() {
		const seq = ++loadSeq;
		listState = 'loading';
		try {
			const response = await apiClient.projects.list(
				showArchived ? { include_archived: 1 } : undefined
			);
			if (seq !== loadSeq) return;
			projects = response.items || [];
			projectNames = new Map(projects.filter(isRealProject).map((p) => [p.id, p.name] as const));
			// See the `archivedExcluded` declaration: a missing key stays `null`.
			archivedExcluded =
				typeof response.archived_excluded === 'number' ? response.archived_excluded : null;
			// Same rule, same reason — a missing key is `null`, never 0.
			deadBoardExcluded =
				typeof response.dead_board_excluded === 'number' ? response.dead_board_excluded : null;
			loadError = null;
			listState = 'ready';
		} catch (error) {
			if (seq !== loadSeq) return;
			console.error('Failed to load projects:', error);
			loadError = error;
			if (error instanceof ApiError) {
				toast.error(`Failed to load projects: ${error.message}`);
			} else {
				toast.error('Failed to load projects. Please try again.');
			}
			projects = [];
			projectNames = new Map();
			// ⛔ NO `archivedExcluded` RESET HERE, DELIBERATELY — and the reason is a
			// measurement, not taste. One was written and then removed: no test could
			// redden its absence, because the only readers of `archivedExcluded` are
			// the two empty branches, both of which require `listState === 'ready'`,
			// which only the success arm above can set — and that arm ALWAYS assigns
			// the field. A reset here is a line that cannot fail, i.e. a claim.
			listState = 'unreadable';
		}
	}

	/**
	 * The archived-only state's action: re-ask WITH the archived rows.
	 *
	 * ⛔ This is a per-request widening from the client, NOT a change to the
	 * route's default — `RelationPicker`, the project browser and every asset
	 * picker depend on archived staying out by default.
	 */
	async function showArchivedProjects() {
		showArchived = true;
		await loadProjects();
	}

	async function hideArchivedProjects() {
		showArchived = false;
		await loadProjects();
	}

	async function confirmDelete(project: Project) {
		projectToDelete = project;
	}

	async function deleteProject() {
		if (!projectToDelete) return;

		deletingId = projectToDelete.id;
		try {
			await apiClient.projects.delete(projectToDelete.id);
			toast.success(`Project "${projectToDelete.name}" deleted successfully`);
			projectToDelete = null;
			await loadProjects();
		} catch (error) {
			console.error('Failed to delete project:', error);
			if (error instanceof ApiError) {
				toast.error(`Failed to delete project: ${error.message}`);
			} else {
				toast.error('Failed to delete project. Please try again.');
			}
		} finally {
			deletingId = null;
		}
	}

	function cancelDelete() {
		projectToDelete = null;
	}

	function getStatusColor(status: Project['status']) {
		switch (status) {
			case 'active':
				return 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]';
			case 'initializing':
				return 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]';
			case 'archived':
				return 'bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]';
			case 'failed':
				return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]';
			default:
				return 'bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]';
		}
	}
</script>

<section class="space-y-6" data-testid="project-portfolio">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-xl font-semibold text-[var(--color-text)]">Projects</h2>
			<p class="mt-1 text-sm text-[var(--color-text-muted)]">Click a project to open it.</p>
		</div>
		{#if !auth.conveyorCreationDisabled}
		<a
			href="/projects/new"
			class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors"
		>
			+ New Project
		</a>
		{/if}
	</div>

	<!--
		SEARCH + SORT. Client-side over the list this page already fetched (the
		route returns the whole list, no pagination); the controls operate on
		`regularProjects`, so they can only narrow what the server sent.
		Shown only when there is something to narrow — an empty workspace keeps
		its own empty state, never a search box over nothing.
	-->
	{#if listState === 'ready' && regularProjects.length > 0}
		<div class="flex flex-wrap items-end gap-3" data-testid="projects-controls">
			<div class="flex w-72 max-w-full flex-col gap-1">
				<label for="projects-search-input" class="text-xs font-medium text-[var(--color-text-muted)]">Search</label>
				<Input
					id="projects-search-input"
					type="search"
					placeholder="Search projects…"
					bind:value={query}
				/>
			</div>
			<div class="flex flex-col gap-1">
				<label for="projects-sort-select" class="text-xs font-medium text-[var(--color-text-muted)]">Sort</label>
				<Select
					id="projects-sort-select"
					bind:value={sort}
					options={[...PORTFOLIO_SORT_OPTIONS]}
				/>
			</div>
			<span class="pb-2 text-xs text-[var(--color-text-muted)]" data-testid="projects-count">
				{visibleProjects.length} of {regularProjects.length}
			</span>
		</div>
	{/if}

	{#if showArchivedDisclosure}
		<!-- Keyed on the COUNT, not on which state renders — see
		     `showArchivedDisclosure`. Markup mirrors `projects-showing-archived`
		     below so the two directions of the same toggle read as one control.
		     It reuses `showArchivedProjects()`, the archived-only state's own
		     handler and its `loadProjects()` refetch; there is no second path. -->
		<div
			class="flex items-center justify-between gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-muted)]"
			data-testid="projects-archived-disclosure"
		>
			<span>
				{archivedExcluded === null
					? 'Whether any archived projects are hidden is unknown — this response did not say how many were withheld.'
					: `${archivedExcluded} archived ${archivedExcluded === 1 ? 'project is' : 'projects are'} hidden here by default.`}
			</span>
			<button
				type="button"
				class="shrink-0 whitespace-nowrap underline hover:text-[var(--color-text)]"
				onclick={() => void showArchivedProjects()}
			>
				Show archived projects
			</button>
		</div>
	{/if}

	{#if listState === 'loading' && projects.length === 0}
		<!-- ⛔ Gated on there being nothing to show, like `/approvals`: the skeleton
		     REPLACES the grid, so a reload allowed to reach it while rows exist
		     unmounts everything the user was looking at. `Skeleton` from
		     $lib/components/ui — the hand-rolled pulse divs this replaced were a
		     fourth private copy of it. -->
		<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="projects-loading">
			{#each Array(6) as _, i (i)}
				<div class="bg-[var(--color-bg)] rounded-lg shadow p-6 dark:bg-[var(--color-surface)]">
					<Skeleton variant="text" count={4} height="1.25rem" />
				</div>
			{/each}
		</div>
	{:else if listState === 'unreadable'}
		<!-- Ordered BEFORE both empty states deliberately: an empty list caused by a
		     failed request must never render as "you have no projects". The
		     paragraph says what must NOT be concluded; `ErrorState` carries the
		     diagnosis and the Retry. -->
		<div
			class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]"
			data-testid="projects-unreadable"
		>
			<ErrorState
				error={loadError}
				title="Your projects could not be read"
				onRetry={() => void loadProjects()}
			/>
			<p class="px-6 pb-8 text-center text-sm text-[var(--color-text-muted)]">
				This is <strong class="font-medium text-[var(--color-text)]">not</strong> a statement that
				you have no projects. How many exist is unknown right now — retry above, or reload the page.
			</p>
		</div>
	{:else if regularProjects.length === 0}
		{#if emptyKind === 'boards-unreachable'}
			<!-- ⭐ THE FIFTH STATE. `keepAfterBoardLivenessCheck` in the route drops
			     ACTIVE rows whose Planka board is confirmed gone, and it runs AFTER
			     `archived_excluded` is counted — so this page used to receive
			     `{items:[], archived_excluded:0}` for a workspace full of live
			     projects and render the first-run pitch over it. `dead_board_excluded`
			     is the count that makes the two distinguishable; this state is what
			     the page says instead. It names the BOARD side and offers a re-check,
			     never "Create Your First Project". -->
			<div
				class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]"
				data-testid="projects-boards-unreachable"
			>
				<EmptyState
					title={deadBoardTitle}
					body={deadBoardBody}
					actionLabel="Re-check boards"
					onAction={() => void loadProjects()}
				/>
			</div>
		{:else if emptyKind === 'archived-only'}
			<!-- ⭐ ARCHIVED-ONLY (or "the server did not say"). THE STATE THIS PAGE DID
			     NOT HAVE, and the one production is actually in: 133 projects, all
			     archived. It offers the archived view; it must never offer a
			     first-run pitch, because the workspace has been used. -->
			<div
				class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]"
				data-testid="projects-archived-only"
			>
				<EmptyState
					title="No active projects"
					body={archivedExcluded === null
						? 'Archived projects are hidden here by default, and this response did not say how many were withheld. Show them to see what this workspace holds.'
						: `No active projects — but ${archivedExcluded} archived ${archivedExcluded === 1 ? 'project is' : 'projects are'} hidden here by default. This workspace has been used.`}
					actionLabel="Show archived projects"
					onAction={() => void showArchivedProjects()}
				/>
			</div>
		{:else}
			<!-- Genuinely empty — and reachable ONLY on an explicit
			     `archived_excluded: 0` AND an explicit `dead_board_excluded: 0`, i.e.
			     the server measured that this request withheld nothing on EITHER
			     ground. See `emptyKind`: one explicit zero was not enough, and that
			     is what this repair adds. -->
			<div
				class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]"
				data-testid="projects-empty"
			>
				<EmptyState
					title="No projects yet"
					body="Nothing has been created in this workspace, and nothing is archived either."
				/>
				<!-- fr row 14b: a project is visible only in the workspace its tag
				     names, so an empty workspace may mean "one switch away".
				     Platform workspaces only (the endpoint never returns a
				     customer one). -->
				<WorkspaceEmptyHint />
				{#if !auth.conveyorCreationDisabled}
				<div class="pb-12 text-center">
					<a
						href="/projects/new"
						class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors"
					>
						Create Your First Project
					</a>
				</div>
				{/if}
			</div>
		{/if}
	{:else}
		{#if showArchived}
			<!-- Says which population is on screen. Without it the archived rows read
			     as the normal list, and the only cue is a per-card status badge. -->
			<div
				class="flex items-center justify-between gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-muted)]"
				data-testid="projects-showing-archived"
			>
				<span>Showing archived projects as well as active ones.</span>
				<button
					type="button"
					class="underline hover:text-[var(--color-text)]"
					onclick={() => void hideArchivedProjects()}
				>
					Hide archived
				</button>
			</div>
		{/if}
		{#if visibleProjects.length > 0}
		<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
			{#each visibleProjects as project (project.id)}
				{@const repos = readProjectRepoView(project)}
				{@const waiting = asksPerProject?.get(project.id) ?? 0}
				<div class="bg-[var(--color-bg)] rounded-lg shadow hover:shadow-lg transition-shadow p-6 relative group dark:bg-[var(--color-surface)]">
					<a href="/projects/{project.id}" class="block">
						<div class="flex items-start justify-between mb-4">
							<span class="text-3xl">📁</span>
							<div class="flex items-center gap-2">
								{#if waiting > 0}
									<span
										class="text-xs font-medium px-2 py-1 rounded-full bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]"
										title="Items in this project waiting for your answer"
									>
										{waiting} waiting
									</span>
								{/if}
								{#if project.andon_engaged}
									<!-- Nothing runs on a halted project until an operator releases it. -->
									<span
										class="text-xs font-semibold px-2 py-1 rounded-full bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]"
										title="Nothing runs on this project until it continues. Open it to see why."
										data-testid="project-halted-badge-{project.id}"
									>
										Halted
									</span>
								{/if}
								{#if project.board_live === false}
									<span
										class="text-xs font-medium px-2 py-1 rounded-full bg-[var(--color-warning-bg)] text-[var(--color-warning)]"
										title="The board for this project was deleted."
									>
										board unavailable
									</span>
								{/if}
								{#if project.status === 'delivered'}
									<!-- linkPr off: this row is one <a>; no nested anchor. -->
									<DeliveredBadge
										status={project.status}
										deliveredAt={project.delivered_at ?? null}
										evidence={project.delivery_evidence ?? null}
										linkPr={false}
									/>
								{:else}
									<span class="text-xs font-medium px-2 py-1 rounded-full {getStatusColor(project.status)}">
										{project.status}
									</span>
								{/if}
							</div>
						</div>
						<h3 class="text-lg font-semibold text-[var(--color-text)] mb-2 dark:text-[var(--color-text)]">{project.name}</h3>
						<span
							class="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-accent-strong)]"
							title="Macro phase"
						>
							◐ {phaseTitles.label(project.project_phase)}
						</span>
						{#if project.rm_status === 'closed'}
							<span
								class="mb-2 ml-1 inline-flex items-center rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-success-text)]"
								data-testid="project-closed"
								title="This project is finished"
							>
								✓ closed
							</span>
						{/if}
						<!--
							REPOSITORIES — every attached repo, primary marked. Reader:
							`$lib/projects/repo-view.ts`.
						-->
						{#if repos.kind === 'listed'}
							<div class="mb-4" data-testid="project-repos">
								<p class="flex items-baseline gap-1.5 text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
									{#if repos.primary}
										<span class="truncate" data-testid="project-repo-primary" title={repos.primary.url}
											>{repoLabelFromUrl(repos.primary.url, repos.primary.name)}</span
										>
										{#if repos.total > 1}
											<span
												class="shrink-0 rounded-full bg-[var(--color-accent-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-strong)]"
												>primary</span
											>
										{/if}
									{:else}
										<!-- No row claimed `is_primary`. Head row still shown, badge REFUSED. -->
										<span class="truncate" data-testid="project-repo-headline" title={repos.rows[0].url}
											>{repoLabelFromUrl(repos.rows[0].url, repos.rows[0].name)}</span
										>
									{/if}
								</p>
								{#if repos.total > 1}
									<p class="mt-1 text-xs font-semibold text-[var(--color-text-muted)]" data-testid="project-repo-more">
										+{repos.total - 1} more {repos.total === 2 ? 'repository' : 'repositories'}
									</p>
									<ul class="mt-0.5 space-y-0.5">
										{#each repos.others as other (other.repo_id)}
											<li
												class="truncate text-xs text-[var(--color-text-muted)]"
												data-testid="project-repo-extra"
												title={other.url}
											>
												{repoLabelFromUrl(other.url, other.name)}{other.branch ? ` · ${other.branch}` : ''}
											</li>
										{/each}
									</ul>
									{#if repos.countOutrunsRows}
										<!-- The count outran the rows: say so rather than let the list read as complete. -->
										<p class="mt-0.5 text-xs text-[var(--color-warning-text)]" data-testid="project-repo-unnamed">
											{repos.total - 1 - repos.others.length} further attached, not named in this response.
										</p>
									{/if}
								{/if}
								{#if !repos.primary}
									<!-- 0..N rows with EXACTLY ONE primary is the backend's invariant. No
									     flag on any row means the invariant is broken or the field was
									     dropped, and badging the head row anyway would invent the answer. -->
									<p class="mt-1 text-xs text-[var(--color-warning-text)]" data-testid="project-repo-no-primary">
										None of these is flagged primary — which one is cannot be shown.
									</p>
								{/if}
							</div>
						{:else if repos.kind === 'none'}
							<p class="mb-4 text-sm text-[var(--color-text-muted)]" data-testid="project-repo-none">
								No repositories attached.
							</p>
						{:else if project.repository_url}
							<!-- The server did not report the list. Show the denormalised primary and
							     say it may be one of several — never "no repositories". A project
							     with NO repository (null, migration 190) renders nothing here. -->
							<div class="mb-4" data-testid="project-repos-unknown">
								<p class="truncate text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
									{project.repository_url}
								</p>
								<p class="mt-1 text-xs text-[var(--color-text-muted)]">
									Primary repository — how many others are attached was not reported.
								</p>
							</div>
						{/if}
						<div class="flex items-center justify-between text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
							<!--
								The head row's branch, or the denormalised `project.branch` when the
								list was not reported. ⛔ Not `repos.primary.branch` unguarded: with no
								row claiming primary there is no primary branch to name.
							-->
							<span
								>{repos.kind === 'listed'
									? (repos.primary?.branch ?? repos.rows[0].branch ?? project.branch)
									: project.branch}</span
							>
							<!-- Date AND time on both columns (owner request). -->
							<span class="text-right leading-5" data-testid="project-timestamps">
								<span class="block" data-testid="project-created-at" title={String(project.created_at)}>
									Created {projectTimestamp(project.created_at)}
								</span>
								<span class="block" data-testid="project-updated-at" title={String(project.updated_at)}>
									Updated {projectTimestamp(project.updated_at)}
								</span>
							</span>
						</div>
					</a>

					<!-- Delete Button -->
					<button
						onclick={(e) => {
							e.preventDefault();
							confirmDelete(project);
						}}
						class="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity bg-[var(--color-danger-bg)] hover:bg-[var(--color-danger-bg)] text-[var(--color-danger)] rounded-full p-2 text-sm dark:bg-[var(--color-danger-bg)]/30"
						title="Delete project"
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
						</svg>
					</button>
				</div>
			{/each}
		</div>
		{:else}
			<!--
				SEARCH-MISS — a SIBLING of the grid, never one of the empty states
				above. `regularProjects` is non-empty here (the outer branch proved it),
				so "nothing was created" would be a false statement about data the
				server just returned; this says only that the query matched nothing.
			-->
			<div
				class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]"
				data-testid="projects-no-match"
			>
				<EmptyState
					title="No projects match your search"
					body={`Nothing here matches "${query.trim()}". Clear the search to see all ${regularProjects.length} ${regularProjects.length === 1 ? 'project' : 'projects'}.`}
					actionLabel="Clear search"
					onAction={() => {
						query = '';
					}}
				/>
			</div>
		{/if}
	{/if}
</section>

<!-- Delete Confirmation Modal -->
{#if projectToDelete}
	<div
		class="fixed inset-0 bg-[var(--color-bg)] bg-opacity-50 flex items-center justify-center z-50"
		role="button"
		tabindex="0"
		onclick={cancelDelete}
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cancelDelete(); } }}
	>
		<div
			class="bg-[var(--color-bg)] rounded-lg shadow-xl p-6 w-full max-w-md dark:bg-[var(--color-surface)]"
			role="presentation"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<h2 class="text-2xl font-bold text-[var(--color-text)] mb-4 dark:text-[var(--color-text)]">Delete Project</h2>
			<p class="text-[var(--color-text)] mb-6 dark:text-[var(--color-text-muted)]">
				Are you sure you want to delete <strong>{projectToDelete.name}</strong>? This action cannot be undone.
			</p>

			<div class="flex gap-3">
				<button
					type="button"
					onclick={cancelDelete}
					disabled={deletingId !== null}
					class="flex-1 px-4 py-2 border border-[var(--color-border-strong)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface)] transition-colors disabled:opacity-50 dark:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={deleteProject}
					disabled={deletingId !== null}
					class="flex-1 px-4 py-2 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{deletingId ? 'Deleting...' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}
