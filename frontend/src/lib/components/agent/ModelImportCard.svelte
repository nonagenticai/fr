<!--
  ModelImportCard — the card of `architecture.import_model_exchange`.

  The agent PROPOSED an import; nothing has run and the agent holds no file. The
  human picks the ArchiMate exchange file (.xml) HERE; it goes from the browser,
  under the human's session, to the Models page's own import route — into the
  model the proposal names (`model_id`), or as a new model of this project. The
  bytes never touch the agent, the LLM or the thread.

  Nothing is written to the model by the import: the card then shows the staged
  changes (what the file would change, what the format could not carry, any
  problems) with Apply / Reject — the same panel as the model page.
-->
<script lang="ts">
	import type { AgentProposal } from '$lib/agui/types';
	import ExchangeImport from '$lib/components/modeling/ExchangeImport.svelte';
	import { scrubString } from '$lib/api/agent-redact';
	import { raiseInvalidate } from '$lib/agent/invalidation';
	import { isModelImportProposal } from './proposal-cards';

	let { proposal }: { proposal: AgentProposal } = $props();

	const importable = $derived(isModelImportProposal(proposal));
	const projectId = $derived(typeof proposal.input.project_id === 'string' ? proposal.input.project_id : undefined);
	const modelId = $derived(typeof proposal.input.model_id === 'string' && proposal.input.model_id ? proposal.input.model_id : undefined);
	const purpose = $derived(typeof proposal.input.purpose === 'string' ? scrubString(proposal.input.purpose) : null);
	let createdModel = $state<string | null>(null);
</script>

<div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" data-testid="model-import-card" data-agent-surface="card">
	<p class="font-semibold text-[var(--color-text)]">{modelId ? 'Import a file into a model' : 'Create a model from a file'}</p>
	{#if purpose}<p class="mt-0.5 text-xs text-[var(--color-text-muted)]">{purpose}</p>{/if}
	{#if !importable}
		<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="model-import-card-refused">
			This proposal does not name the import route, so it cannot be used here.
		</p>
	{:else}
		<div class="mt-2">
			<ExchangeImport
				{modelId}
				{projectId}
				onImported={(r) => {
					if (r.model_created) createdModel = r.model_id;
					if (projectId) raiseInvalidate([`assets:${projectId}`]);
				}}
				onChange={() => projectId && raiseInvalidate([`assets:${projectId}`])}
			/>
		</div>
		{#if createdModel}
			<a class="mt-2 inline-block text-xs text-[var(--color-link)] underline" href={`/library/architecture/models/${encodeURIComponent(createdModel)}`} data-testid="model-import-card-open">Open the new model</a>
		{/if}
	{/if}
</div>
