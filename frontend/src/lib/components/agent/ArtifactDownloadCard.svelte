<!--
  ArtifactDownloadCard — the FileCard of `artifacts.download` (fr-agui P2-c2,
  SPEC §5.5 / review F15). The agent answered WHICH file it is and that it is
  `revealable`; it never saw a download link or token. The Download button mints
  the single-use URL in the browser, under the HUMAN's session, fetches the file
  once and saves it (lib/agent/artifact-download.ts) — the token is never shown,
  stored, or sent back to the agent.
-->
<script lang="ts">
	import { downloadArtifactFile } from '$lib/agent/artifact-download';
	import { humanSize, type FileCardFile } from './proposal-cards';

	let { file }: { file: FileCardFile } = $props();

	let downloading = $state(false);
	let error = $state<string | null>(null);
	let saved = $state(false);

	async function download(): Promise<void> {
		if (downloading) return;
		error = null;
		downloading = true;
		const out = await downloadArtifactFile(file.artifact_id, file.project_id, file.filename);
		downloading = false;
		if (out.ok) saved = true;
		else error = out.message;
	}
</script>

<div
	class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
	data-testid="artifact-file-card"
	data-agent-surface="card"
>
	<p class="font-semibold text-[var(--color-text)]" data-testid="artifact-file-card-name">{file.filename ?? file.artifact_id}</p>
	<p class="mt-0.5 text-xs text-[var(--color-text-muted)]">
		{[file.mime, humanSize(file.size)].filter(Boolean).join(' · ')}
	</p>
	{#if error}
		<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="artifact-file-card-error">{error}</p>
	{/if}
	<button
		type="button"
		data-testid="artifact-file-card-download"
		disabled={downloading}
		onclick={download}
		class="mt-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg)] disabled:opacity-50"
	>
		{downloading ? 'Downloading…' : saved ? 'Download again' : 'Download'}
	</button>
</div>
