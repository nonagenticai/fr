<!--
  Band ① — Readied brief.

  Renders the `readied_brief` that READY materialised into the card
  description (parsed by lib/cards/readiedBrief.ts). Asset references render
  as chips linking into the Knowledge surface, mirroring the link convention
  in PrinciplesSection / RequirementsSection. Frontend-
  only: every field comes from the already-loaded card description.
-->
<script lang="ts">
	import type { ReadiedBrief } from '../readiedBrief';
	import { hasBriefContent } from '../readiedBrief';

	interface Props {
		brief: ReadiedBrief | null;
	}
	let { brief }: Props = $props();

	const present = $derived(hasBriefContent(brief));

	// Normalised asset-ref rows for a {id,title}[] list.
	function refs(
		list: Array<{ id?: string; title?: string }> | undefined,
	): Array<{ id: string; title: string }> {
		return (list ?? [])
			.filter((r) => r && r.id)
			.map((r) => ({ id: r.id as string, title: r.title?.trim() || (r.id as string) }));
	}

	const principles = $derived(refs(brief?.principles_applied));
	const requirements = $derived(refs(brief?.requirements_in_scope));
	const decisions = $derived(
		(brief?.decisions ?? [])
			.filter((d) => d && d.id)
			.map((d) => ({ id: d.id as string, title: d.summary?.trim() || (d.id as string) })),
	);
	const acceptance = $derived(
		(brief?.acceptance_criteria ?? []).filter((s) => s && s.trim()),
	);
	const openQuestions = $derived(
		(brief?.open_questions ?? []).filter((s) => s && s.trim()),
	);
	const split = $derived(brief?.split_recommendation ?? null);
	const sparse = $derived(brief?.provenance?.sparse_dimensions ?? []);
</script>

<div>
	{#if !present}
		<p class="text-sm text-[var(--color-text-muted)] italic">
			No readied brief yet — READY has not run for this card.
		</p>
	{:else if brief}
		<div class="space-y-4 text-sm">
			{#if brief.objective}
				<div>
					<h4 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
						Objective
					</h4>
					<p class="text-[var(--color-text)] whitespace-pre-wrap">{brief.objective}</p>
				</div>
			{/if}

			{#if brief.context || brief.key_context}
				<div>
					<h4 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
						Context
					</h4>
					{#if brief.context}
						<p class="text-[var(--color-text)] whitespace-pre-wrap">{brief.context}</p>
					{/if}
					{#if brief.key_context}
						<p class="text-[var(--color-text-muted)] whitespace-pre-wrap mt-1 italic">
							{brief.key_context}
						</p>
					{/if}
				</div>
			{/if}

			{#if acceptance.length > 0}
				<div>
					<h4 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
						Acceptance criteria
					</h4>
					<ul class="list-disc pl-5 space-y-0.5">
						{#each acceptance as c, i (i)}
							<li class="text-[var(--color-text)]">{c}</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if principles.length > 0}
				<div>
					<h4 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
						Principles applied
					</h4>
					<ul class="flex flex-wrap gap-1.5">
						{#each principles as r (r.id)}
							<li>
								<a
									class="inline-block rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent-bg)] hover:underline"
									href={`/principles/${encodeURIComponent(r.id)}`}
								>
									{r.title}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if requirements.length > 0}
				<div>
					<h4 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
						Requirements in scope
					</h4>
					<ul class="flex flex-wrap gap-1.5">
						{#each requirements as r (r.id)}
							<li>
								<a
									class="inline-block rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent-bg)] hover:underline"
									href={`/requirements/${encodeURIComponent(r.id)}`}
								>
									{r.title}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if decisions.length > 0}
				<div>
					<h4 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
						Decisions authored
					</h4>
					<ul class="space-y-1">
						{#each decisions as r (r.id)}
							<li class="flex items-baseline gap-2">
								<a
									class="text-[var(--color-accent)] hover:text-[var(--color-accent-strong)] hover:underline"
									href={`/decisions/${encodeURIComponent(r.id)}`}
								>
									{r.title}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if split?.needed}
				<div class="rounded border border-[var(--color-warning)] bg-[var(--color-warning-bg)] p-3">
					<h4 class="text-xs uppercase tracking-wider text-[var(--color-warning-text)] mb-1">
						Split recommended
					</h4>
					{#if split.rationale}
						<p class="text-[var(--color-text)]">{split.rationale}</p>
					{/if}
					{#if split.proposed_children && split.proposed_children.length > 0}
						<ul class="list-disc pl-5 mt-1.5 space-y-0.5">
							{#each split.proposed_children as child, i (i)}
								<li class="text-[var(--color-text)]">
									<span class="font-medium">{child.title || `child ${i + 1}`}</span>
									{#if child.scope}
										<span class="text-[var(--color-text-muted)]"> — {child.scope}</span>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
					<p class="text-xs text-[var(--color-text-muted)] mt-1.5 italic">
						READY only records this — DOING performs the split.
					</p>
				</div>
			{/if}

			{#if openQuestions.length > 0}
				<div>
					<h4 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
						Open questions
					</h4>
					<ul class="list-disc pl-5 space-y-0.5">
						{#each openQuestions as q, i (i)}
							<li class="text-[var(--color-text-muted)]">{q}</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if brief.approval_ref}
				<div>
					<h4 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
						Approval
					</h4>
					<a
						href={`/approvals/${encodeURIComponent(brief.approval_ref)}`}
						class="text-[var(--color-accent)] hover:underline"
					>
						approval {brief.approval_ref} →
					</a>
				</div>
			{/if}

			{#if sparse.length > 0}
				<p class="text-xs text-[var(--color-text-muted)]">
					Sparse dimensions at READY: <span class="font-mono">{sparse.join(' · ')}</span>
				</p>
			{/if}
		</div>
	{/if}
</div>
