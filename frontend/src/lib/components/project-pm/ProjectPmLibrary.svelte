<!--
  ProjectPmLibrary — the project's READ-ONLY PM library (fr-agui SPEC §16 D12,
  §13 P2-b), sourced from requirements_management via
  GET /api/projects/:id/pm/{projects,programmes,risks}.
  No write controls: catalogue editing stays in RM. Each section renders its own
  loading / error / empty state (lib/components/project-pm/pm-library.ts).
-->
<script lang="ts">
	import { onInvalidate } from '$lib/agent/invalidation';
	import {
		PM_COLUMNS,
		PM_SECTIONS,
		loadPmLibrary,
		pmCell,
		type PmSectionKey,
		type PmSectionState
	} from './pm-library';

	let { projectId }: { projectId: string } = $props();

	let sections = $state<Record<PmSectionKey, PmSectionState> | null>(null);

	async function load(id: string): Promise<void> {
		sections = null;
		sections = await loadPmLibrary(id);
	}

	$effect(() => {
		const id = projectId;
		if (!id) return;
		void load(id);
		return onInvalidate([`project:${id}`, `assets:${id}`], () => void load(id));
	});
</script>

<div class="flex flex-col gap-6" data-testid="project-pm-library">
	<p class="text-xs text-[var(--color-text-muted)]">
		Read-only. These records are kept in requirements management; edit them there.
	</p>
	{#if !sections}
		<p class="text-sm text-[var(--color-text-muted)]" data-testid="project-pm-loading">Loading the PM library…</p>
	{:else}
		{#each PM_SECTIONS as s (s.key)}
			{@const sec = sections[s.key]}
			<section data-testid={`project-pm-section-${s.key}`} aria-labelledby={`pm-h-${s.key}`}>
				<h2 id={`pm-h-${s.key}`} class="mb-2 text-sm font-semibold text-[var(--color-text)]">{s.title}</h2>
				{#if sec.status === 'error'}
					<p class="text-sm text-[var(--color-danger-text)]" role="alert" data-testid={`project-pm-error-${s.key}`}>
						Could not load {s.title.toLowerCase()}: {sec.message}
					</p>
				{:else if sec.rows.length === 0}
					<p class="text-sm text-[var(--color-text-muted)]" data-testid={`project-pm-empty-${s.key}`}>{s.empty}</p>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full min-w-[36rem] text-left text-xs">
							<thead>
								<tr class="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
									{#each PM_COLUMNS[s.key] as [label] (label)}
										<th scope="col" class="px-2 py-1 font-medium">{label}</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each sec.rows as row, i (String(row.id ?? i))}
									<tr class="border-b border-[var(--color-border)]" data-testid={`project-pm-row-${s.key}`}>
										{#each PM_COLUMNS[s.key] as [label, field] (label)}
											<td class="px-2 py-1 text-[var(--color-text)]">{pmCell(row, field)}</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		{/each}
	{/if}
</div>
