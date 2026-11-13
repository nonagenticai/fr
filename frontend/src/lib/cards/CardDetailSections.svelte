<!--
  CardDetailSections — the full AA card-detail body (header + the lib/cards/*
  section grid). Extracted from routes/cards/[id]/+page.svelte so the same
  rendering is mounted in two places: the standalone /cards/[id] deep-link
  route AND the in-workspace slide-over on /projects/[id]. Pure presentation:
  it takes an already-loaded `card` and derives everything from it.
-->
<script lang="ts">
	import PhaseStrip from '$lib/cards/PhaseStrip.svelte';
	import CardTypeProtocol from '$lib/cards/CardTypeProtocol.svelte';
	import FiveDPanel from '$lib/cards/FiveDPanel.svelte';
	import ReadiedBriefSection from '$lib/cards/sections/ReadiedBriefSection.svelte';
	import RelationsSection from '$lib/cards/sections/RelationsSection.svelte';
	import BlockedGateSection from '$lib/cards/sections/BlockedGateSection.svelte';
	import PhaseJourneySection from '$lib/cards/sections/PhaseJourneySection.svelte';
	import { parseReadiedBrief, stripReadiedBrief, descriptionSegments } from '$lib/cards/readiedBrief';
	import { isBlocked } from '$lib/cards/phase';
	import { parseBlockReason, prLink } from '$lib/cards/runtime-state';
	// The tenant chip is a reference to another entity, so it renders through the
	// one component that owns that shape — including the full-id tooltip the
	// hand-rolled `title="Owning tenant id"` could never give (fr#1205).
	import EntityRef from '$lib/components/ui/EntityRef.svelte';
	import { listNameLabel } from '$lib/utils/humanizeEnum';
	import ReportLinks from '$lib/components/reports/ReportLinks.svelte';
	import CardPrioritySelect from '$lib/cards/CardPrioritySelect.svelte';
	import type { CardDetail } from '$lib/cards/types';
	import { kanbanStore } from '$lib/stores/kanbanStore.svelte';

	let {
		card,
		// When true (the slide-over), drop the kanban/project breadcrumb — the
		// user is already inside the project workspace.
		showBreadcrumb = true,
		// Owning project's status, when known; closed ⇒ no "Move back to READY".
		projectStatus = null
	}: { card: CardDetail; showBreadcrumb?: boolean; projectStatus?: string | null } = $props();

	const card_type = $derived(card.groups.Metadata?.card_type ?? '');
	const project_id = $derived(card.groups.Metadata?.project_id ?? '');
	// The breadcrumb's project link follows the SERVER-gated `fr_project_id`
	// (emitted only when GET /api/projects/:id would admit the caller), never
	// the editable Metadata `project_id`: a same-tenant peer who cannot read
	// the project gets null, and a Metadata-built link would land on a 404.
	const linkProjectId = $derived(card.fr_project_id?.trim() || null);
	// The priority select's project: the server-stated `fr_project_id` when the
	// server states one, else the card's Metadata `project_id` (a card whose
	// project the caller cannot GET still shows its own priority control; the
	// PATCH route re-authorises the write, so this is not a security boundary).
	const priorityProjectId = $derived(card.fr_project_id?.trim() || project_id);
	const stream_slug = $derived(card.groups.Metadata?.stream_slug ?? '');

	const brief = $derived(parseReadiedBrief(card.description));
	const descriptionProse = $derived(stripReadiedBrief(card.description));
	const descriptionParts = $derived(descriptionSegments(descriptionProse));
	const blocked = $derived(isBlocked(card.list_name ?? null));
	// Runtime State is filled by the conveyor at execution time; absent on a
	// blank card or an older payload, so every read tolerates undefined.
	const runtimeState = $derived(card.groups?.['Runtime State'] as Record<string, unknown> | undefined);
	const blockReason = $derived(parseBlockReason(runtimeState?.block_reason));
	const pr = $derived(prLink(runtimeState));
	// UI review 2026-10-07: short form of the current block reason for the
	// phase journey's BLOCKED step (the full form stays in BlockedGateSection).
	const blockReasonText = $derived(
		blockReason === null
			? null
			: blockReason.kind === 'unstructured'
				? blockReason.raw
				: `${blockReason.cls}:${blockReason.exit}`
	);
	// UI review #7: related cards rendered as "Card …<id tail>". Titles come
	// from two places: the board ALREADY loaded in kanbanStore (the workspace /
	// stream slide-over), and `card.related_titles` — a bounded (≤10) per-id
	// lookup GET /api/cards/:id does for the standalone page, where no board is
	// loaded. The response wins when both name an id. Anything still unnamed
	// keeps the id-tail fallback.
	const relationTitles = $derived.by(() => {
		const out: Record<string, string> = {};
		for (const c of kanbanStore.board?.cards ?? []) if (c.name) out[c.id] = c.name;
		for (const [id, name] of Object.entries(card.related_titles ?? {})) if (name) out[id] = name;
		return out;
	});
</script>

<header class="mb-6">
	{#if showBreadcrumb}
		<div class="flex items-center gap-2 text-xs text-[var(--color-text-muted)] mb-1">
			<a href="/kanban" class="hover:underline">kanban</a>
			{#if linkProjectId}
				<span>/</span>
				<a href={`/projects/${encodeURIComponent(linkProjectId)}`} class="hover:underline">project</a>
			{/if}
			{#if stream_slug}
				<span>/</span>
				<span class="font-mono">{stream_slug}</span>
			{/if}
		</div>
	{/if}
	<h1 class="text-2xl font-semibold text-[var(--color-text)] mb-2">{card.name}</h1>
	<div class="flex flex-wrap items-center gap-2 text-xs">
		{#if card_type}
			<span class="px-2 py-0.5 rounded border border-[var(--color-border)] font-mono text-[var(--color-text)]">
				{card_type}
			</span>
		{/if}
		{#if card.is_system}
			<span
				class="px-2 py-0.5 rounded bg-[var(--color-accent-bg)] text-[var(--color-accent)] font-medium"
				title="Card lives in an internal AA tenant"
			>
				SYSTEM
			</span>
		{/if}
		{#if card.tenant}
			<span class="text-[var(--color-text-muted)]">
				tenant: <EntityRef id={card.tenant} kind="tenant" />
			</span>
		{/if}
		{#if card.list_name}
			<span class="text-[var(--color-text-muted)]">
				list: <span title={card.list_name} data-testid="card-list-name">{listNameLabel(card.list_name)}</span>
			</span>
		{/if}
		<!-- The priority write follows the SERVER-gated project first (P1a audit → P1b);
		     the Metadata id is the fallback only. The route re-authorises either way. -->
		<CardPrioritySelect cardId={card.id} projectId={priorityProjectId} priority={card.groups.Metadata?.priority} />
	</div>
</header>

<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
	<aside class="space-y-6">
		<PhaseStrip list_name={card.list_name} />

		<section>
			<h2 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-2">Phase journey</h2>
			<PhaseJourneySection journey={card.phase_journey} currentListName={card.list_name} {blockReasonText} />
		</section>

		{#if card_type}
			<CardTypeProtocol {card_type} />
		{/if}
		{#if descriptionParts.length > 0}
			<section>
				<h2 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Description</h2>
				<div class="space-y-2">
					{#each descriptionParts as part, i (i)}
						{#if part.type === 'code'}
							<pre class="text-xs font-mono overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"><code>{part.content}</code></pre>
						{:else}
							<p class="text-sm text-[var(--color-text)] whitespace-pre-wrap">{part.content}</p>
						{/if}
					{/each}
				</div>
			</section>
		{/if}
	</aside>

	<main class="lg:col-span-2 space-y-4">
		<BlockedGateSection
			{blocked}
			openApprovals={card.open_approvals}
			{blockReason}
			cardId={card.id}
			boardId={card.board_id}
			{projectStatus}
		/>

		<section class="border border-[var(--color-border)] rounded-md bg-[var(--color-surface)]">
			<header class="px-4 py-2 border-b border-[var(--color-border)]">
				<h3 class="text-sm font-medium text-[var(--color-text)]">Readied brief</h3>
			</header>
			<div class="px-4 py-3">
				<ReadiedBriefSection {brief} />
			</div>
		</section>

		<section class="border border-[var(--color-border)] rounded-md bg-[var(--color-surface)]">
			<header class="px-4 py-2 border-b border-[var(--color-border)]">
				<h3 class="text-sm font-medium text-[var(--color-text)]">Relations</h3>
			</header>
			<div class="px-4 py-3">
				<RelationsSection relations={card.groups.Relations ?? {}} titles={relationTitles} />
			</div>
		</section>

		<FiveDPanel {card} {brief} />

		<!-- U2: stored reports written for this card (e.g. a bug_report). -->
		<ReportLinks cardId={card.id} />

		<!-- G-UI-1: the PR the conveyor opened for this card. Only a safe https
		     github.com PR URL becomes a link; anything else renders as text. -->
		{#if pr}
			<section
				class="border border-[var(--color-border)] rounded-md bg-[var(--color-surface)]"
				data-testid="card-pr-link"
			>
				<div class="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
					<h3 class="text-sm font-medium text-[var(--color-text)]">Pull request</h3>
					{#if pr.href}
						<a
							href={pr.href}
							target="_blank"
							rel="noopener noreferrer"
							class="font-mono text-[var(--color-accent)] hover:underline"
						>
							{pr.label}
						</a>
					{:else}
						<span class="font-mono text-[var(--color-text-muted)] break-all">{pr.label}</span>
					{/if}
				</div>
			</section>
		{/if}
	</main>
</div>
