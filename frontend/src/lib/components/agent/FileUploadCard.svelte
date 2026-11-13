<!--
  FileUploadCard — the FileCard (fr-agui SPEC §5.5, §13 P2-b) for the agent's
  `documents.upload` proposal.

  The agent PROPOSED an upload; nothing has run and the agent holds no file. The
  human picks the file HERE and, on Upload, this card posts it from the browser
  straight to the project's own upload route, `POST /api/documents/upload`
  (multipart, `project_id` = the project the server bound, under the HUMAN's
  session) — the same route the Knowledge page uses, where kag/ClamAV scan the
  bytes fail-closed before any parse or index. The route's size/type limits and
  refusals apply verbatim (SPEC §5.6). The bytes never touch the agent, the LLM
  or the thread: the card shows only {fileName, size, mime, documentId}.

  A double click uploads once (`submitting` / `done` guard). The binding is not
  editable. The project's assets are invalidated so its views re-fetch.
-->
<script lang="ts">
	import { apiClient } from '$lib/api/unified-client';
	import type { AgentProposal } from '$lib/agui/types';
	import { activeProject } from '$lib/stores/activeProject.svelte';
	import { raiseInvalidate } from '$lib/agent/invalidation';
	import { scrubString } from '$lib/api/agent-redact';
	import {
		humanSize,
		isFileUploadProposal,
		uploadedFileSummary,
		verbatimErrorText,
		type UploadedFileSummary
	} from './proposal-cards';

	let { proposal }: { proposal: AgentProposal } = $props();

	const uploadable = $derived(isFileUploadProposal(proposal));
	const projectId = $derived(typeof proposal.input.project_id === 'string' ? proposal.input.project_id : null);
	const projectName = $derived(
		projectId ? (activeProject.projects.find((p) => p.id === projectId)?.name ?? (activeProject.active?.id === projectId ? activeProject.active?.name : null)) : null
	);
	const purpose = $derived(typeof proposal.input.purpose === 'string' ? scrubString(proposal.input.purpose) : null);
	const sendToKag = $derived(proposal.input.send_to_kag !== false);

	let file = $state<File | null>(null);
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let done = $state<UploadedFileSummary | null>(null);

	function pick(e: Event): void {
		const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
		file = f;
		submitError = null;
	}

	async function upload(): Promise<void> {
		if (!uploadable || !projectId || submitting || done) return;
		if (!file) {
			submitError = 'Choose a file first.';
			return;
		}
		submitting = true;
		submitError = null;
		const picked = file;
		try {
			const res = await apiClient.documents.upload(projectId, picked, { sendToKag });
			done = uploadedFileSummary(res, picked);
			raiseInvalidate([`assets:${projectId}`, `project:${projectId}`]);
		} catch (err) {
			submitError = verbatimErrorText(err);
		} finally {
			submitting = false;
		}
	}
</script>

<div
	class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
	data-testid="file-upload-card"
	data-agent-surface="card"
>
	<p class="font-semibold text-[var(--color-text)]">Upload a file to this project</p>
	{#if projectId}
		<p class="mt-0.5 text-xs text-[var(--color-text-muted)]" data-testid="file-upload-card-project">
			Project: {projectName ?? projectId}
		</p>
	{/if}
	{#if purpose}
		<p class="mt-1 text-xs text-[var(--color-text)]" data-testid="file-upload-card-purpose">{purpose}</p>
	{/if}
	{#if !uploadable}
		<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="file-upload-card-refused">
			This proposal does not name the project upload route, so no file can be sent from here.
		</p>
	{:else if done}
		<p class="mt-2 text-[var(--color-text)]" data-testid="file-upload-card-done">
			Uploaded {done.fileName} ({humanSize(done.size)}, {done.mime}) — {done.status}. It is virus-scanned before it is indexed.
		</p>
	{:else}
		<p class="mt-1 text-xs text-[var(--color-text-muted)]">
			The agent proposed this and never sees the file. It is virus-scanned before it is indexed{sendToKag ? '' : ' (stored only, not indexed as knowledge)'}.
		</p>
		<label class="mt-2 block text-xs text-[var(--color-text-muted)]" for={`upload-${proposal.proposalId}`}>File</label>
		<input
			id={`upload-${proposal.proposalId}`}
			type="file"
			data-testid="file-upload-card-input"
			onchange={pick}
			class="mt-1 block w-full text-xs"
		/>
		{#if file}
			<p class="mt-1 text-xs text-[var(--color-text-muted)]" data-testid="file-upload-card-picked">
				{file.name} · {humanSize(file.size)}
			</p>
		{/if}
		{#if submitError}
			<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="file-upload-card-error">{submitError}</p>
		{/if}
		<button
			type="button"
			data-testid="file-upload-card-confirm"
			disabled={submitting}
			onclick={upload}
			class="mt-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg)] disabled:opacity-50"
		>
			{submitting ? 'Uploading…' : 'Upload'}
		</button>
	{/if}
</div>
