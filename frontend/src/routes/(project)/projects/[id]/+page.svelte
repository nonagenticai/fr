<script lang="ts">
	import { onInvalidate } from '$lib/agent/invalidation';
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { setPageTitle } from '$lib/layout/pageTitle.svelte';
	import { fetchProjectCockpit, CockpitNotFoundError } from '$lib/api/cockpit';
	import type { ProjectCockpit, CockpitCard, CockpitProjectRepository } from '$lib/types/cockpit';
	import { hasData, type Panel } from '$lib/types/panel';
	import { usePoll, type PollHandle } from '$lib/net/poll';
	import { inspector } from '$lib/stores/inspector.svelte';
	import { projectCockpit, actionsCount } from '$lib/stores/projectCockpit.svelte';
	import { isClosedProjectStatus } from '$lib/projects/project-status';

	import ObjectiveCard from '$lib/components/cockpit/ObjectiveCard.svelte';
	import ActiveWorkList from '$lib/components/cockpit/ActiveWorkList.svelte';
	import LiveExecutionTimeline from '$lib/components/cockpit/LiveExecutionTimeline.svelte';
	import AssetUseStrip from '$lib/components/cockpit/AssetUseStrip.svelte';
	import CurrentCardEvidenceDrawer from '$lib/components/cockpit/CurrentCardEvidenceDrawer.svelte';
	import ActionStrip from '$lib/components/cockpit/ActionStrip.svelte';
	import PhaseSpine from '$lib/components/cockpit/PhaseSpine.svelte';
	import PhaseDetail from '$lib/components/overview/PhaseDetail.svelte';
	import ProjectOutcome from '$lib/components/overview/ProjectOutcome.svelte';
	import RegistersStrip from '$lib/components/overview/RegistersStrip.svelte';
	import { outputHref, outputMeta, phaseShown, progressSentence, type RegistersView } from '$lib/components/overview/overview';
	import { fetchProjectRegisters } from '$lib/api/project-registers';
	import { isFinished } from '$lib/projects/cockpit-status';
	import DeliveredBadge from '$lib/components/projects/DeliveredBadge.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import PanelNote from '$lib/components/blocks/PanelNote.svelte';
	import EntityRef from '$lib/components/ui/EntityRef.svelte';
	import ReportLinks from '$lib/components/reports/ReportLinks.svelte';
	import ProjectCapabilities from '$lib/components/projects/ProjectCapabilities.svelte';
	import { repoLabelFromUrl } from '$lib/projects/repo-view';
	import ConveyorHistoryPanel from '$lib/components/conveyor-history/ConveyorHistoryPanel.svelte';

	// ── The PROJECT COCKPIT (read model v2, R-CK8) ──────────────────────────────
	// ONE call (GET /api/projects/:id/cockpit) drives every panel on this page AND the shell's C1
	// status header (published into `projectCockpit`). Each panel degrades on its own and carries
	// its own plain-words note; no raw upstream error reaches the page.
	//
	// R2 (FR-PROJECT-HOME-REDESIGN-2026-10-26 §4): the Overview is the project as a CHAIN OF
	// PHASES. Top-down: a problem line only when something is wrong now (D4) → Needs you (hidden
	// once finished) → the phase bar (C3; defaults to the current phase) → that phase as a
	// mini-project (goal-less until a source exists, board, outputs, decisions, cost) → progress
	// per phase → latest outputs → registers at a glance. A FINISHED project (completed /
	// cancelled) is an outcome page instead (D6, D8). Copilot is the shell's right-hand drawer,
	// opened from "Ask about this project" in the header (D7) — never mounted here.
	// Every phase placement comes from the read model, exactly; the page guesses none.

	let projectId = $derived($page.params.id);

	let cockpit = $state<ProjectCockpit | null>(null);
	let loaded = $state(false);
	let notFound = $state(false);

	const closed = $derived(
		isFinished(cockpit?.status.data?.state) ||
			isClosedProjectStatus(cockpit?.project.data?.status ?? null, cockpit?.project.data?.rm_status ?? null),
	);

	const overview = $derived(cockpit?.overview && hasData(cockpit.overview) ? cockpit.overview.data : null);
	const spine = $derived(cockpit?.spine && hasData(cockpit.spine) ? cockpit.spine.data : null);
	/** The phase the user picked on the phase bar (null = follow the current phase). */
	let chosenPhase = $state<string | null>(null);
	const shownPhaseName = $derived(overview ? phaseShown(overview, chosenPhase) : null);
	const shownPhase = $derived(overview?.phases.find((p) => p.name === shownPhaseName) ?? null);
	const phaseLabels = $derived(new Map((overview?.phases ?? []).map((p) => [p.name, p.label] as const)));
	const decisionsPanel = $derived(
		cockpit?.decisions ?? { data: null, as_of: null, health: 'down' as const, detail_code: 'not_served' },
	);
	const latestOutputs = $derived((overview?.outputs ?? []).slice(0, 5));

	// "Registers at a glance": ONE read per project, refreshed with the cockpit's invalidations.
	let registers = $state<RegistersView>({ kind: 'reading' });
	async function loadRegisters(id: string): Promise<void> {
		try {
			const data = await fetchProjectRegisters(id, null);
			if (id === projectId) registers = { kind: 'loaded', data };
		} catch (e) {
			if (id === projectId) registers = { kind: 'failed', message: e instanceof Error ? e.message : 'The registers could not be read.' };
		}
	}
	$effect(() => {
		const id = projectId;
		if (!id) return;
		registers = { kind: 'reading' };
		chosenPhase = null;
		void loadRegisters(id);
	});

	/**
	 * The repository strip, from the read model's `repositories` panel. FOUR states, and the two
	 * that must never collapse are `unavailable` (the read failed) and `none` (it succeeded empty).
	 */
	type RepoStrip =
		| { kind: 'unavailable'; panel: Panel<unknown> }
		| { kind: 'none' }
		| { kind: 'listed'; rows: CockpitProjectRepository[]; total: number };

	const repoStrip = $derived.by((): RepoStrip | null => {
		const p = cockpit?.repositories;
		if (!p) return null;
		if (!hasData(p)) return { kind: 'unavailable', panel: p };
		const rows = Array.isArray(p.data.repositories) ? p.data.repositories : [];
		if (rows.length === 0) return { kind: 'none' };
		// `is_primary` is the authority, not row order.
		const ordered = [...rows].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
		const declared = typeof p.data.count === 'number' && Number.isFinite(p.data.count) ? p.data.count : null;
		return { kind: 'listed', rows: ordered, total: declared !== null && declared > ordered.length ? declared : ordered.length };
	});

	/** "Empty is quiet": the 5D asset strip only when something is bound or linked. */
	const assetsBound = $derived.by(() => {
		const a = cockpit?.asset_usage;
		if (!a || !hasData(a)) return a ? a.health !== 'ok' : false;
		const b = a.data.bound_by_kind;
		return a.data.kag_memory_links > 0 || b.principle + b.requirement + b.decision > 0;
	});

	async function refresh(): Promise<void> {
		const id = projectId;
		if (!id) return;
		try {
			// PROJECT-READ-WAIVER: primary-load — this page reads a DIFFERENT endpoint from
			// the one the shared helper reads. `loadProject` calls GET /api/projects/:id and
			// returns a `Project`; the cockpit calls GET /api/projects/:id/cockpit and returns
			// a `ProjectCockpit` read-model (the project it needs arrives INSIDE that payload
			// as `cockpit.project`). Routing this through `loadProject` would issue a second,
			// redundant HTTP read whose success or failure says nothing about the endpoint
			// this page actually renders — a "readable" verdict about a call we do not make.
			// What the waiver DOES oblige: the failure branch below must render the same
			// honest `project-unreadable` state the six sibling sub-pages render, and must
			// never turn a failed read into a claim of absence. Enforced by
			// src/lib/projects/project-read-path.test.ts.
			const c = await fetchProjectCockpit(id);
			cockpit = c;
			projectCockpit.publish(id, c.project, c.status);
			projectCockpit.publishNeedsYou(id, actionsCount(c.actions));
			notFound = false;
		} catch (e) {
			if (e instanceof CockpitNotFoundError) {
				// A 404 is terminal — the project isn't visible to this caller.
				notFound = true;
				poll?.stop();
				return;
			}
			// Transient failure — rethrow so usePoll backs off; the last-good cockpit stays on screen.
			throw e;
		} finally {
			loaded = true;
		}
	}

	// fr-agui SPEC §5.3: a write the agent ran or a confirm card sent may have
	// changed what the cockpit shows — re-read it now, not at the next poll.
	$effect(() => {
		const id = projectId;
		if (!id) return;
		return onInvalidate([`project:${id}`, `board:${id}`, `approvals:${id}`], () => {
			void refresh().catch(() => {});
			void loadRegisters(id);
		});
	});

	let poll: PollHandle | null = null;
	onMount(() => {
		poll = usePoll(refresh, { intervalMs: 15_000, initialDelayMs: 0 });
		poll.start();
	});
	onDestroy(() => {
		poll?.stop();
		inspector.close();
	});

	const progressSentenceOf = progressSentence;

	function openEvidence(card: CockpitCard): void {
		inspector.open({ kind: 'cockpit-card', id: card.id, payload: card });
	}

	const selectedCard = $derived(
		inspector.selection?.kind === 'cockpit-card'
			? (inspector.selection.payload as CockpitCard)
			: null,
	);

	// Publish this route's entity name to the single title element in the root layout.
	$effect(() => {
		setPageTitle($page.url.pathname, cockpit?.project?.data?.name ?? null);
	});
</script>

<!-- ONE scrolling document. This used to be a fixed-height box whose columns
     were each `overflow-hidden` / `min-h-0 flex-1`: the two rails sat outside
     the only scroller (pinned, ~half the screen on a laptop) and a column whose
     content outgrew its box painted over its neighbour ("5D asset use" over the
     timeline, "Reports" over Copilot) — UI review 2026-10-07. Natural flow
     cannot overlap; the long panes cap their own height and scroll inside. -->
<div class="relative flex min-h-[calc(100vh-4rem)] flex-col">
	{#if !loaded}
		<div class="p-4">
			<Skeleton height="4rem" class="mb-3" />
			<div class="grid gap-3 xl:grid-cols-3">
				<Skeleton height="16rem" />
				<Skeleton height="16rem" />
				<Skeleton height="16rem" />
			</div>
		</div>
	{:else if notFound}
		<div class="grid flex-1 place-items-center p-8 text-center">
			<div>
				<h1 class="text-lg font-bold text-[var(--color-text)]">Project not found</h1>
				<p class="mt-1 text-sm text-[var(--color-text-muted)]">
					This project doesn't exist or isn't available to your workspace.
				</p>
			</div>
		</div>
	{:else if !cockpit}
		<!-- The read FAILED (a 404 took the `notFound` branch above and is a real answer;
		     everything else lands here). Render the SAME honest state the six sibling
		     sub-pages render under `data-testid="project-unreadable"`: name the failure and
		     say explicitly that absence has NOT been established. The sibling copy this
		     family exists to kill told the user to RE-CREATE a project that was fine. -->
		<div class="grid flex-1 place-items-center p-8 text-center">
			<div>
				<h1 class="text-lg font-bold text-[var(--color-text)]">The project could not be read</h1>
				<p
					class="mt-1 text-sm text-[var(--color-warning-text)]"
					data-testid="project-unreadable"
				>
					The cockpit could not be read, so nothing about this project's state is known — it
					has NOT been shown to be missing, empty or unprovisioned. Retrying automatically;
					report this if it persists.
				</p>
			</div>
		</div>
	{:else}
		<div class="flex flex-col gap-3 p-3" data-testid="project-overview" data-finished={closed}>
			{#if !closed && overview && overview.problems.length > 0}
				<!-- D4: a problem line ONLY when something is wrong now. -->
				<ul class="space-y-1 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-2.5" data-testid="overview-problems" role="status">
					{#each overview.problems as pr (pr.message)}
						<li class="text-sm text-[var(--color-danger-text)]" data-testid="overview-problem" data-code={pr.code}>
							{pr.message} <a class="font-semibold underline" href={pr.href}>Look</a>
						</li>
					{/each}
				</ul>
			{/if}

			{#if cockpit.project.data?.status === 'delivered'}
				<DeliveredBadge
					status={cockpit.project.data.status}
					deliveredAt={cockpit.project.data.delivered_at ?? null}
					evidence={cockpit.project.data.delivery_evidence ?? null}
				/>
			{/if}

			{#if closed && overview && projectId}
				<ProjectOutcome {projectId} {overview} {registers} />
			{/if}

			{#if !closed && projectId}
				<!-- Needs you: every open ask, sign-off and review, oldest first, tagged with its phase. -->
				<ActionStrip
					{projectId}
					actions={cockpit.actions}
					approvals={cockpit.approvals}
					{phaseLabels}
					onDecided={() => void refresh().catch(() => {})}
				/>
			{/if}

			{#if cockpit.spine}
				<div>
					{#if closed}<h2 class="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Inspect a phase</h2>{/if}
					<PhaseSpine
						panel={cockpit.spine}
						selectedPhase={shownPhaseName}
						onSelectPhase={(p) => (chosenPhase = p ?? overview?.current_phase ?? null)}
					/>
				</div>
			{/if}

			{#if !overview}
				{#if cockpit.overview}
					<PanelNote panel={cockpit.overview} title="The phases of this project" />
				{/if}
			{:else}
				{#if cockpit.overview && cockpit.overview.health !== 'ok'}
					<PanelNote panel={cockpit.overview} title="Part of this overview" />
				{/if}
				{#if shownPhase && projectId}
					<PhaseDetail
						{projectId}
						phase={shownPhase}
						currency={overview.currency}
						decisions={decisionsPanel}
						{spine}
					/>
				{/if}

				{#if !closed}
					<div class="grid gap-3 xl:grid-cols-2">
						<section data-testid="overview-progress" aria-label="Progress">
							<h2 class="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Progress</h2>
							<ol class="space-y-1">
								{#each overview.phases as p (p.name)}
									<li class="text-sm text-[var(--color-text)]" data-testid="overview-progress-row" data-phase={p.name}>
										<span class="font-semibold">{p.label}</span> — {progressSentenceOf(p)}
									</li>
								{/each}
							</ol>
						</section>
						<section data-testid="overview-latest-outputs" aria-label="Latest outputs">
							<div class="mb-1 flex items-baseline">
								<h2 class="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Latest outputs</h2>
								<a class="ml-auto text-xs text-[var(--color-link)] hover:underline" href={`/projects/${encodeURIComponent(projectId ?? '')}/artifacts`}>All outputs</a>
							</div>
							{#if latestOutputs.length === 0}
								<p class="text-xs text-[var(--color-text-muted)]">Nothing has been produced yet.</p>
							{:else}
								<ul class="space-y-1">
									{#each latestOutputs as o (o.id)}
										<li class="text-xs" data-testid="overview-output">
											<a class="font-semibold text-[var(--color-link)] hover:underline" href={outputHref(projectId ?? '', o)} target={o.url ? '_blank' : undefined} rel={o.url ? 'noopener noreferrer' : undefined}>{o.title}</a>
											<span class="text-[var(--color-text-muted)]"> · {outputMeta(o)}{o.phase ? ` · ${phaseLabels.get(o.phase) ?? o.phase}` : ''}</span>
										</li>
									{/each}
								</ul>
							{/if}
						</section>
					</div>
				{/if}

				{#if overview.unassigned.cards + overview.unassigned.outputs.length + overview.unassigned.decisions > 0}
					<p class="text-xs text-[var(--color-text-muted)]" data-testid="overview-unassigned">
						Not tied to a phase: {[
							overview.unassigned.cards ? `${overview.unassigned.cards} card${overview.unassigned.cards === 1 ? '' : 's'}` : null,
							overview.unassigned.outputs.length ? `${overview.unassigned.outputs.length} output${overview.unassigned.outputs.length === 1 ? '' : 's'}` : null,
							overview.unassigned.decisions ? `${overview.unassigned.decisions} decision${overview.unassigned.decisions === 1 ? '' : 's'}` : null,
						].filter(Boolean).join(', ')}.
					</p>
				{/if}
			{/if}

			<RegistersStrip view={registers} decisions={cockpit.decisions?.data ?? []} />

			<!-- The previous Overview content that has no new home yet (R3–R6 move it): kept, collapsed. -->
			<details class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-testid="overview-more">
				<summary class="cursor-pointer text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">More about this project</summary>
				<div class="mt-3 grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
					<div class="flex min-w-0 flex-col gap-3">
						<ObjectiveCard project={cockpit.project} goal={cockpit.goal} />
						{#if projectId}
							<ReportLinks {projectId} {closed} conveyorReports={cockpit.reports} storedReports={cockpit.stored_reports} />
						{/if}
						<!-- REPOSITORY STRIP — every attached repo, primary marked. -->
						<section>
							<h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
								Repositories{repoStrip?.kind === 'listed' ? ` · ${repoStrip.total}` : ''}
							</h3>
							{#if repoStrip?.kind === 'unavailable'}
								<div data-testid="cockpit-repos-unavailable">
									<PanelNote panel={repoStrip.panel} title="The repository list" />
								</div>
							{:else if repoStrip?.kind === 'none'}
								<p class="text-xs text-[var(--color-text-muted)]" data-testid="cockpit-repos-none">
									No repositories are attached to this project.
								</p>
							{:else if repoStrip?.kind === 'listed'}
								<ul
									class="space-y-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
									data-testid="cockpit-repo-strip"
								>
									{#each repoStrip.rows as repo (repo.repo_id)}
										<li
											class="flex flex-wrap items-baseline gap-2 text-xs text-[var(--color-text)]"
											data-testid="cockpit-repo-row"
											title={repo.url}
										>
											<EntityRef id={repo.repo_id} name={repoLabelFromUrl(repo.url, repo.name)} kind="repository" />
											{#if repo.branch}
												<span class="font-mono text-[11px] text-[var(--color-text-muted)]">{repo.branch}</span>
											{/if}
											{#if repo.is_primary}
												<span
													class="rounded-full bg-[var(--color-accent-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-strong)]"
													data-testid="cockpit-repo-primary">primary</span
												>
											{/if}
										</li>
									{/each}
									{#if repoStrip.total > repoStrip.rows.length}
										<li class="text-xs text-[var(--color-warning-text)]" data-testid="cockpit-repos-unnamed">
											{repoStrip.total - repoStrip.rows.length} further attached, not named in this response.
										</li>
									{:else if !repoStrip.rows.some((r) => r.is_primary)}
										<li class="text-xs text-[var(--color-warning-text)]" data-testid="cockpit-repos-no-primary">
											None of these is flagged primary — which one is cannot be shown.
										</li>
									{/if}
								</ul>
							{/if}
						</section>
						{#if !closed}
							<section>
								<h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
									Active work
								</h3>
								<ActiveWorkList
									cards={cockpit.active_cards}
									onOpenEvidence={openEvidence}
									rail={cockpit.phase_rail.data ?? null}
								/>
							</section>
						{/if}
						{#if projectId}
							<!-- R271: the PM's capability selection + history (RM) — display only. -->
							<ProjectCapabilities {projectId} panel={cockpit.capabilities} />
						{/if}
					</div>
					<div class="flex min-w-0 flex-col gap-3">
						<div class="flex max-h-[36rem] min-h-[16rem] flex-col">
							<LiveExecutionTimeline
								events={cockpit.timeline_events}
								llmCalls={cockpit.cost.data?.attributed_request_count ?? null}
							/>
						</div>
						{#if assetsBound}
							<section>
								<h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
									5D asset use
								</h3>
								<AssetUseStrip assetUsage={cockpit.asset_usage} {projectId} />
							</section>
						{:else}
							<p class="text-xs text-[var(--color-text-muted)]" data-testid="cockpit-assets-none">No assets bound to this project.</p>
						{/if}
						{#if projectId && cockpit.project.data?.conveyor_linked}
							<ConveyorHistoryPanel {projectId} history={cockpit.conveyor_history} />
						{/if}
					</div>
				</div>
			</details>
		</div>

			<!-- Evidence drawer (customer-safe) -->
		{#if selectedCard}
			<div class="fixed bottom-0 right-0 top-16 z-20 w-full max-w-md p-3">
				<CurrentCardEvidenceDrawer
					card={selectedCard}
					events={cockpit.timeline_events.data ?? []}
					onclose={() => inspector.close()}
				/>
			</div>
		{/if}
	{/if}
</div>
