<!--
  CardPrioritySelect — the priority control on a card.

  The options are the workspace's requirements_management priority levels
  (GET /api/conveyor/priority-levels, ordered by rank) — fr holds no P0..P3
  list. Reads the stored value from `card.groups.Metadata.priority` (the
  level's text, matched to a level by name); writes the level ID through
  PATCH /api/projects/:projectId/cards/:cardId/priority. The server's answer is
  what is shown after a save (never the optimistic pick), and a refusal is
  printed inline — known codes as readable text (`priorityErrorMessage`) — and
  the select snaps back to the stored value: a failed save must never look like
  a saved one. A failed level load is shown, never an empty picker.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import { apiClient } from '$lib/api/unified-client';
	import { listTenantPriorityLevels } from '$lib/api/conveyor-catalogue';
	import {
		priorityOptions,
		storedPriorityLevel,
		toSelectValue,
		fromSelectValue,
		priorityErrorMessage,
		type PriorityLevel,
		type PrioritySelectValue
	} from '$lib/priority/priority';

	let {
		cardId,
		projectId,
		priority
	}: { cardId: string; projectId: string; priority: unknown } = $props();

	let levels = $state<PriorityLevel[]>([]);
	let levelsError = $state<string | null>(null);
	let levelsLoaded = $state(false);
	// What the server last told us (the stored text). Resynced whenever the card
	// prop changes (the card page polls), overwritten by a successful save.
	let savedText = $state<unknown>(null);
	let draft = $state<PrioritySelectValue>('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	const saved = $derived(storedPriorityLevel(levels, { text: savedText }));

	$effect.pre(() => {
		savedText = priority;
	});
	$effect.pre(() => {
		draft = toSelectValue(saved);
	});

	onMount(async () => {
		const r = await listTenantPriorityLevels();
		if (r.ok) levels = r.data;
		else levelsError = r.message;
		levelsLoaded = true;
	});

	async function onchange(e: Event) {
		const next = fromSelectValue((e.currentTarget as HTMLSelectElement).value);
		if (!projectId || next === (saved?.id ?? null)) return;
		saving = true;
		error = null;
		try {
			const res = await apiClient.projects.setCardPriority(projectId, cardId, next);
			savedText = res?.priority ?? null;
			draft = toSelectValue(storedPriorityLevel(levels, { id: res?.priority_level_id, text: res?.priority }));
		} catch (err) {
			draft = toSelectValue(saved);
			error = priorityErrorMessage(err);
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex flex-wrap items-center gap-2" data-testid="card-priority">
	<label for={`card-priority-${cardId}`} class="text-[var(--color-text-muted)]">priority:</label>
	<Select
		id={`card-priority-${cardId}`}
		options={priorityOptions(levels)}
		bind:value={draft}
		{onchange}
		disabled={saving || !projectId || !levelsLoaded || levelsError !== null}
		class="h-8 py-0 text-xs"
	/>
	{#if !projectId}
		<span class="text-[var(--color-text-muted)]" data-testid="card-priority-no-project">
			No project on this card — priority cannot be set here.
		</span>
	{/if}
	{#if levelsError}
		<span class="text-[var(--color-danger-text)]" role="alert" data-testid="card-priority-levels-error">
			Priority levels unavailable: {levelsError}
		</span>
	{/if}
	{#if error}
		<span class="text-[var(--color-danger-text)]" role="alert" data-testid="card-priority-error">
			Priority not saved: {error}
		</span>
	{/if}
</div>
