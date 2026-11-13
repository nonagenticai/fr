<!--
  DiagramDownloadCard — the card of `architecture.download_diagram_png`. The
  agent named which diagram; the PNG goes from fr to THIS browser under the
  person's session (the same download as the diagram's page). The agent and the
  thread never hold the file. A failure says why and the button stays usable.
-->
<script lang="ts">
	import { downloadDiagram, fileNameOf, saveFile } from '$lib/api/modeling';
	import type { DiagramPngCard } from './proposal-cards';

	let { card }: { card: DiagramPngCard } = $props();
	let busy = $state(false);
	let done = $state(false);
	let error = $state<string | null>(null);

	async function download(): Promise<void> {
		busy = true;
		error = null;
		try {
			const blob = await downloadDiagram(
				{
					...(card.kind === 'uml_diagram' ? { umlDiagramId: card.id } : { viewId: card.id }),
					...(card.model_id && card.revision_id ? { modelId: card.model_id, revisionId: card.revision_id } : {})
				},
				'png'
			);
			saveFile(blob, fileNameOf(card.title, '.png'));
			done = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" data-testid="diagram-download-card" data-agent-surface="card">
	<p class="font-semibold text-[var(--color-text)]">{card.title} (PNG)</p>
	{#if card.revision_id}<p class="text-xs text-[var(--color-text-muted)]">As it was in a saved version</p>{/if}
	{#if error}<p class="mt-1 text-xs text-[var(--color-danger)]" data-testid="diagram-download-card-error">{error}</p>{/if}
	<button
		type="button"
		class="mt-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] disabled:opacity-50"
		disabled={busy}
		onclick={download}
		data-testid="diagram-download-card-button"
	>
		{busy ? 'Preparing…' : done ? 'Download again' : 'Download the picture'}
	</button>
</div>
