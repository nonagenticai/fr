<!--
  DocumentUploadPanel — upload + live-status list for KAG knowledge documents.

  The single implementation behind both the `/documents` route and the
  KAG-library hub (`/library/kag` → Documents tab). Uploads go through the
  DIRECT path `apiClient.documents.upload` → POST /api/documents/upload (NOT the
  `$lib/api/kag` approval-bus path), so a logged-in user's own knowledge is
  ingested immediately rather than parked as a pending action.

  Scope: the upload target defaults to "Workspace (all projects)" — the doc
  becomes tenant-wide knowledge usable by every workflow. Picking a project
  additionally pins the fr-side row to that project.
-->
<script lang="ts" module>
	// Pure status/degradation derivation, exported from a `<script module>` block
	// so it is unit-testable in node without mounting the panel — the
	// describeLifecycleStatus() idiom from coding/ContainerLifecycleFeed.svelte.
	//
	// This is where karma PR #127's "partial credit" stops being invisible: a job
	// that indexed 18 of 137 chunks now reaches status='completed', and the row
	// used to render a clean green pill over an 86%-missing graph.
	import type { Document, DocumentStatus } from '$lib/types/api';
	import { degradationLine, DEGRADED_GENERIC } from '$lib/components/kag/degradation';

	export type DocumentStatusTone =
		| 'neutral'
		| 'accent'
		| 'success'
		| 'warning'
		| 'danger'
		| 'info';

	export interface DocumentStatusView {
		label: string;
		tone: DocumentStatusTone;
	}

	/** The minimum a row needs to describe itself — keeps the pure tests cheap. */
	export type DocumentStatusInput = Pick<Document, 'status'> &
		Partial<
			Pick<
				Document,
				'kag_degraded' | 'kag_degraded_reason' | 'chunks_indexed' | 'chunks_failed' | 'chunks_total'
			>
		>;

	/**
	 * Pure. Maps a row to its pill label + tone.
	 *
	 * 🔴 The degradation predicate is `=== true` — NOT truthiness, NOT `!== false`.
	 * `kag_degraded` is three-valued (see DocumentDegradationFields): `null` means
	 * UNKNOWN, and 4 legacy prod rows plus every parse-only upload carry NULL
	 * forever. Those must render EXACTLY as they did before this feature landed.
	 * A truthiness test would be equivalent here today but would start lying the
	 * first time the backend sends `0`/`''`; `!== false` would repaint every
	 * legacy row warning-orange on no evidence at all. This one line IS the
	 * backwards-compatibility contract.
	 */
	export function describeDocumentStatus(doc: DocumentStatusInput): DocumentStatusView {
		if (doc.status === 'completed' && doc.kag_degraded === true) {
			return { label: 'Partially indexed', tone: 'warning' };
		}
		switch (doc.status as DocumentStatus) {
			case 'completed':
				return { label: 'completed', tone: 'success' };
			case 'processing':
				return { label: 'processing', tone: 'accent' };
			case 'pending':
				return { label: 'pending', tone: 'warning' };
			case 'failed':
				return { label: 'failed', tone: 'danger' };
			case 'parsed':
				// Opt-out path (send_to_kag=false): parsed but NOT indexed in KAG.
				return { label: 'parsed', tone: 'info' };
			default:
				return { label: doc.status, tone: 'neutral' };
		}
	}

	/**
	 * Pure. The counts sub-line for a degraded row, or `null` when the row is not
	 * known-degraded. Delegates the no-fabrication rule to
	 * `$lib/components/kag/degradation` (never invents a denominator, never
	 * renders "18 of 18" for the chunks_failed===0 shape).
	 */
	export function describeDegradation(doc: DocumentStatusInput): string | null {
		if (doc.kag_degraded !== true) return null;
		return degradationLine({
			chunksIndexed: doc.chunks_indexed,
			chunksFailed: doc.chunks_failed,
			chunksTotal: doc.chunks_total,
		});
	}
</script>

<script lang="ts">
	import { apiClient } from '$lib/api/unified-client';
	import { displayName } from '$lib/utils/displayName';
	import type { Project, IngestionProgress as IngestionProgressData } from '$lib/types/api';
	import { isRealProject } from '$lib/projects/is-real-project';
	import { onMount, onDestroy } from 'svelte';
	import { usePoll, type PollHandle } from '$lib/net/poll';
	import { Skeleton, EmptyState, ErrorState } from '$lib/components/ui';
	import Tag from '$lib/components/ui/Tag.svelte';
	import IngestionProgress from '$lib/components/kag/IngestionProgress.svelte';
	import DocumentJobQueue from '$lib/components/kag/DocumentJobQueue.svelte';

	// Inside a project page the panel is pinned to that project: it lists the
	// project's documents and uploads into it, and the project selectors hide.
	let { projectId = null }: { projectId?: string | null } = $props();

	// State management
	let files: FileList | null = $state(null);
	// Ref to the hidden <input type=file> so the whole drop-zone (not just the
	// small label) can open the picker; + drag-over highlight state.
	let fileInput: HTMLInputElement | undefined = $state(undefined);
	let isDragging = $state(false);
	let uploading = $state(false);
	let uploadProgress = $state(0);
	let uploadStatus = $state('');
	let uploadError = $state('');
	// "Send to KAG" toggle — default ON. When OFF the upstream parses the
	// document but skips graph ingestion (status='parsed'); the file is still
	// stored + listed here so n8n/kanban workflows can consume it without it
	// joining the tenant/project knowledge base.
	let sendToKag = $state(true);

	// Projects state
	let projects: Project[] = $state([]);
	// null = workspace-scoped (default). A project id pins the doc to a project.
	// svelte-ignore state_referenced_locally — the pin is fixed for the page's lifetime.
	let selectedProjectId = $state<string | null>(projectId);
	// svelte-ignore state_referenced_locally
	let filterProjectId = $state<string | null>(projectId);
	let loadingProjects = $state(false);
	let projectsError = $state('');

	// Documents state
	let documents: Document[] = $state([]);
	let loadingDocuments = $state(false);
	let documentsError = $state('');
	// Per-document staged ingestion progress, keyed by doc id — populated from
	// the status poll while a doc is in-flight; drives the <IngestionProgress>
	// stepper under each processing row.
	let progressByDoc = $state<Record<string, IngestionProgressData | null>>({});
	// Per-document status-poll health. A row whose status endpoint keeps failing
	// would otherwise sit on 'processing' forever with nothing said anywhere.
	// PERSISTENT vs TRANSIENT: one miss is normal (a rolled pod, a dropped
	// connection) and the next tick 5s later usually settles it, so nothing is
	// shown until the SECOND CONSECUTIVE failure for that document; any success
	// clears both the counter and the message.
	const POLL_FAILURES_BEFORE_SURFACING = 2;
	let statusPollFailures: Record<string, number> = {};
	let statusPollErrors = $state<Record<string, string>>({});

	// Polling handle — single-flight, exponential backoff on failure,
	// pauses when the tab is hidden. Started/stopped by the $effect below.
	const pollHandle: PollHandle = usePoll(pollDocumentStatuses, { intervalMs: 5000 });

	let processingDocuments = $derived(
		documents.filter((doc) => doc.status === 'processing' || doc.status === 'pending')
	);

	let hasProcessingDocs = $derived(processingDocuments.length > 0);

	// Load data on mount
	onMount(async () => {
		await Promise.all([loadProjects(), loadDocuments()]);
	});

	// Cleanup polling on unmount
	onDestroy(() => {
		pollHandle.stop();
	});

	// Effect: Reload documents when filter changes
	$effect(() => {
		// Track filterProjectId to trigger reload
		const _filter = filterProjectId;
		loadDocuments();
	});

	// Effect: Start/stop polling based on processing documents
	$effect(() => {
		if (hasProcessingDocs) {
			if (!pollHandle.isRunning()) {
				pollHandle.start();
			}
		} else {
			if (pollHandle.isRunning()) {
				pollHandle.stop();
			}
		}
	});

	/**
	 * Load all projects
	 */
	async function loadProjects() {
		loadingProjects = true;
		projectsError = '';

		try {
			const response = await apiClient.projects.list();
			// Stream-backed entries are not upload targets: they are not rows in
			// `projects`, so attaching a document to one cannot resolve. Filtered
			// here, at the assignment, so the picker can never offer one.
			projects = (response.items || []).filter(isRealProject);
		} catch (error) {
			projectsError = error instanceof Error ? error.message : 'Failed to load projects';
			console.error('Failed to load projects:', error);
		} finally {
			loadingProjects = false;
		}
	}

	/**
	 * Load documents — all user documents, optionally filtered by project
	 */
	async function loadDocuments() {
		loadingDocuments = true;
		documentsError = '';

		try {
			const response = filterProjectId
				? await apiClient.documents.list(filterProjectId)
				: await apiClient.documents.list();
			documents = response.items || [];
			// Authoritative re-read: any earlier poll complaint is stale now.
			statusPollFailures = {};
			statusPollErrors = {};
		} catch (error) {
			documentsError = error instanceof Error ? error.message : 'Failed to load documents';
			console.error('Failed to load documents:', error);
		} finally {
			loadingDocuments = false;
		}
	}

	/**
	 * Poll status for processing documents. Copies the settled status AND the
	 * page/entity counts the backend reconcile fills on completion, so the row
	 * detail updates in place without a full list reload.
	 *
	 * 🔴 The six degradation fields are copied here too. A document can flip to
	 * degraded WHILE THE USER IS WATCHING (the poll is the only read between
	 * upload and reload); without this copy the row would keep a green
	 * `completed` pill until a manual refresh — i.e. exactly the silent
	 * incomplete graph this feature exists to prevent.
	 */
	async function pollDocumentStatuses() {
		if (processingDocuments.length === 0) return;

		try {
			const statusPromises = processingDocuments.map(async (doc) => {
				try {
					const statusResponse = await apiClient.documents.getStatus(doc.id);
					// A good read clears the row's failure streak and any message.
					if (statusPollFailures[doc.id]) {
						statusPollFailures[doc.id] = 0;
						delete statusPollErrors[doc.id];
					}
					return {
						docId: doc.id,
						status: statusResponse.status,
						pages_detected: statusResponse.pages_detected,
						entities_extracted: statusResponse.entities_extracted,
						error_message: statusResponse.error_message,
						kag_degraded: statusResponse.kag_degraded,
						kag_degraded_reason: statusResponse.kag_degraded_reason,
						kag_degraded_stage: statusResponse.kag_degraded_stage,
						chunks_indexed: statusResponse.chunks_indexed,
						chunks_failed: statusResponse.chunks_failed,
						chunks_total: statusResponse.chunks_total,
						progress: statusResponse.progress ?? null,
					};
				} catch (error) {
					console.error(`Failed to poll status for document ${doc.id}:`, error);
					const failures = (statusPollFailures[doc.id] ?? 0) + 1;
					statusPollFailures[doc.id] = failures;
					// Only a persistent failure is worth alarming the user with —
					// see POLL_FAILURES_BEFORE_SURFACING above.
					if (failures >= POLL_FAILURES_BEFORE_SURFACING) {
						statusPollErrors[doc.id] =
							error instanceof Error ? error.message : String(error);
					}
					return null;
				}
			});

			const statuses = await Promise.all(statusPromises);

			statuses.forEach((result) => {
				if (result) {
					// Stash the staged progress for the stepper (null once terminal).
					progressByDoc[result.docId] = result.progress;
					const docIndex = documents.findIndex((d) => d.id === result.docId);
					if (docIndex !== -1) {
						const target = documents[docIndex];
						if (target) {
							target.status = result.status;
							if (result.pages_detected != null) target.pages_detected = result.pages_detected;
							if (result.entities_extracted != null)
								target.entities_extracted = result.entities_extracted;
							if (result.error_message != null) target.error_message = result.error_message;
							// `!== undefined`, NOT `!= null`: an explicit `false` (backend
							// evaluated the job and found it clean) and an explicit `null`
							// (UNKNOWN) are both real answers that must land on the row. A
							// `!= null` guard would pin a stale `true` forever once a
							// re-reconcile cleared it.
							if (result.kag_degraded !== undefined) target.kag_degraded = result.kag_degraded;
							if (result.kag_degraded_reason !== undefined)
								target.kag_degraded_reason = result.kag_degraded_reason;
							if (result.kag_degraded_stage !== undefined)
								target.kag_degraded_stage = result.kag_degraded_stage;
							if (result.chunks_indexed !== undefined) target.chunks_indexed = result.chunks_indexed;
							if (result.chunks_failed !== undefined) target.chunks_failed = result.chunks_failed;
							if (result.chunks_total !== undefined) target.chunks_total = result.chunks_total;
						}
					}
				}
			});

			documents = [...documents];
			progressByDoc = { ...progressByDoc };
		} catch (error) {
			console.error('Failed to poll document statuses:', error);
			// The whole tick died (not one row) — apply the same persistence rule
			// to every in-flight row so none of them silently freezes.
			const message = error instanceof Error ? error.message : String(error);
			for (const doc of processingDocuments) {
				const failures = (statusPollFailures[doc.id] ?? 0) + 1;
				statusPollFailures[doc.id] = failures;
				if (failures >= POLL_FAILURES_BEFORE_SURFACING) statusPollErrors[doc.id] = message;
			}
		}
	}

	/**
	 * Handle file upload
	 */
	// Drop a file onto the dashed zone → select it (mirrors the picker).
	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		if (uploading) return;
		const dropped = e.dataTransfer?.files;
		if (dropped && dropped.length > 0) {
			files = dropped;
			uploadError = '';
		}
	}

	async function handleUpload() {
		if (!files || files.length === 0) {
			uploadError = 'Please select a file first';
			return;
		}

		uploading = true;
		uploadProgress = 0;
		uploadStatus = 'Uploading...';
		uploadError = '';

		try {
			const file = files[0];
			if (!file) {
				throw new Error('No file selected');
			}

			const progressInterval = setInterval(() => {
				uploadProgress = Math.min(uploadProgress + 10, 90);
			}, 200);

			// selectedProjectId may be null → workspace-scoped knowledge.
			const response = await apiClient.documents.upload(selectedProjectId, file, { sendToKag });

			clearInterval(progressInterval);
			uploadProgress = 100;
			uploadStatus = 'Upload successful! Processing document...';

			files = null;

			await loadDocuments();

			setTimeout(() => {
				uploadStatus = '';
				uploadProgress = 0;
			}, 3000);
		} catch (error) {
			uploadError = error instanceof Error ? error.message : 'Upload failed';
			uploadStatus = '';
			uploadProgress = 0;
			console.error('Upload failed:', error);
		} finally {
			uploading = false;
		}
	}

	/**
	 * Delete a document
	 */
	async function handleDelete(doc: Document) {
		if (!confirm(`Are you sure you want to delete "${doc.filename}"?`)) {
			return;
		}

		try {
			await apiClient.documents.delete(doc.id);
			documents = documents.filter((d) => d.id !== doc.id);
			// Drop this row's poll-failure state with the row itself. Both maps are
			// keyed by document id, and loadDocuments() wipes them wholesale, so a
			// stale entry is only session-bounded — but if the id were ever reused
			// the new row would inherit the old row's streak and surface a warning
			// it never earned.
			delete statusPollFailures[doc.id];
			delete statusPollErrors[doc.id];
		} catch (error) {
			console.error('Failed to delete document:', error);
			alert('Failed to delete document: ' + (error instanceof Error ? error.message : 'Unknown error'));
		}
	}

	function formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 Bytes';
		const k = 1024;
		const sizes = ['Bytes', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
	}

	function formatDate(date: string | Date): string {
		return new Date(date).toLocaleString();
	}

	function getProjectName(projectId: string | null | undefined): string {
		if (!projectId) return 'Workspace';
		const project = projects.find((p) => p.id === projectId);
		return project ? displayName(project.name, project.id) : 'Unknown';
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Documents</h2>
			<p class="mt-2 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Upload documents to ingest as knowledge your workflows can use</p>
		</div>

		<!-- Polling indicator -->
		{#if hasProcessingDocs}
			<div class="flex items-center gap-2 px-4 py-2 bg-[var(--color-accent)] rounded-lg border border-[var(--color-accent)] dark:bg-[var(--color-accent-strong)]/20">
				<div class="animate-spin h-4 w-4 border-2 border-[var(--color-accent)] border-t-transparent rounded-full"></div>
				<span class="text-sm text-[var(--color-accent-strong)] dark:text-[var(--color-accent)]">Polling {processingDocuments.length} processing document{processingDocuments.length !== 1 ? 's' : ''}...</span>
			</div>
		{/if}
	</div>

	<!-- Filter & Upload Section -->
	<div class="bg-[var(--color-bg)] rounded-lg shadow p-6 dark:bg-[var(--color-surface)]">
		<div class="flex items-center gap-4 mb-4">
			<h2 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Filter & Upload</h2>
		</div>

		{#if projectId}
			<p class="text-sm text-[var(--color-text-muted)]" data-testid="kag-upload-project-pinned">
				Showing this project's documents. Uploads are added to this project.
			</p>
		{:else if loadingProjects}
			<Skeleton variant="text" count={2} height="2.5rem" />
		{:else if projectsError}
			<ErrorState error={projectsError} title="Error loading projects" onRetry={loadProjects} />
		{:else}
			<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
				<!-- Filter by project -->
				<div>
					<label for="filter-project" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Filter by Project</label>
					<select
						id="filter-project"
						bind:value={filterProjectId}
						class="w-full px-4 py-2 border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
					>
						<option value={null}>All Projects</option>
						{#each projects as project}
							<option value={project.id}>{displayName(project.name, project.id)}</option>
						{/each}
					</select>
				</div>

				<!-- Upload target -->
				<div>
					<label for="upload-project" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Upload to</label>
					<select
						id="upload-project"
						bind:value={selectedProjectId}
						class="w-full px-4 py-2 border border-[var(--color-border-strong)] rounded-lg focus:ring-2 focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
					>
						<option value={null}>Workspace (available to all projects)</option>
						{#each projects as project}
							<option value={project.id}>Project: {displayName(project.name, project.id)}</option>
						{/each}
					</select>
				</div>
			</div>
		{/if}
	</div>

	<!-- Upload Section -->
	<div class="bg-[var(--color-bg)] rounded-lg shadow p-6 dark:bg-[var(--color-surface)]">
		<h2 class="text-xl font-semibold text-[var(--color-text)] mb-4 dark:text-[var(--color-text)]">Upload New Document</h2>

		<div
			class="border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer {isDragging ? 'border-[var(--color-accent)] bg-[var(--color-surface)]' : 'border-[var(--color-border-strong)] hover:border-[var(--color-accent)]'}"
			role="button"
			tabindex="0"
			aria-label="Choose a file or drag and drop to upload"
			onclick={() => { if (!uploading) fileInput?.click(); }}
			onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!uploading) fileInput?.click(); } }}
			ondragover={(e) => { e.preventDefault(); isDragging = true; }}
			ondragleave={(e) => { e.preventDefault(); isDragging = false; }}
			ondrop={handleDrop}
		>
			<span class="text-6xl mb-4 block">&#128196;</span>

			<span class="text-[var(--color-accent)] hover:text-[var(--color-accent-strong)] font-medium text-lg">
				{files && files.length > 0 ? 'Change file' : 'Choose a file or drag & drop'}
			</span>
			<input
				bind:this={fileInput}
				type="file"
				accept=".pdf,.doc,.docx,.txt"
				bind:files
				class="hidden"
				disabled={uploading}
			/>

			{#if files && files.length > 0}
				<div class="mt-4 p-3 bg-[var(--color-surface)] rounded-lg inline-block dark:bg-[var(--color-bg)]">
					<p class="text-sm font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">Selected: {files[0].name}</p>
					<p class="text-xs text-[var(--color-text-muted)] mt-1 dark:text-[var(--color-text-muted)]">{formatFileSize(files[0].size)}</p>
				</div>
			{/if}

			<!-- Send-to-KAG toggle. Default ON. When OFF, the document is parsed
			     but not ingested into the knowledge graph — useful when
			     you want n8n/kanban workflows to consume the file directly. -->
			<label
				class="mt-6 inline-flex items-start gap-3 cursor-pointer select-none text-left max-w-md mx-auto"
				onclick={(e) => e.stopPropagation()}
			>
				<input
					type="checkbox"
					bind:checked={sendToKag}
					disabled={uploading}
					class="mt-0.5 h-4 w-4 rounded border-[var(--color-border-strong)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
				/>
				<span class="text-sm">
					<span class="font-medium text-[var(--color-text)] block">
						Add to knowledge (KAG)
					</span>
					<span class="text-xs text-[var(--color-text-muted)] block">
						{#if sendToKag}
							Document will be parsed and indexed so workflows can answer questions about it.
						{:else}
							Document will be parsed but kept out of the knowledge base — useful when n8n / kanban workflows need the file directly.
						{/if}
					</span>
				</span>
			</label>

			<button
				onclick={(e) => { e.stopPropagation(); handleUpload(); }}
				disabled={!files || files.length === 0 || uploading}
				class="mt-6 px-8 py-3 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
			>
				{uploading ? 'Uploading...' : 'Upload Document'}
			</button>

			{#if uploading && uploadProgress > 0}
				<div class="mt-4">
					<div class="w-full bg-[var(--color-surface-strong)] rounded-full h-2.5 dark:bg-[var(--color-surface-strong)]">
						<div
							class="bg-[var(--color-accent)] h-2.5 rounded-full transition-all duration-300"
							style="width: {uploadProgress}%"
						></div>
					</div>
					<p class="text-sm text-[var(--color-text)] mt-2 dark:text-[var(--color-text-muted)]">{uploadProgress}% complete</p>
				</div>
			{/if}

			{#if uploadStatus}
				<div class="mt-4 p-3 bg-[var(--color-success-bg)] border border-[var(--color-success-border)] rounded-lg">
					<p class="text-sm text-[var(--color-success-text)]">{uploadStatus}</p>
				</div>
			{/if}

			{#if uploadError}
				<div class="mt-4 p-3 bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg dark:bg-[var(--color-danger-bg)]/20">
					<p class="text-sm text-[var(--color-danger-text)]">{uploadError}</p>
				</div>
			{/if}
		</div>

		<p class="mt-4 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
			Supported formats: PDF, Word (.doc, .docx), Text (.txt)
		</p>
	</div>

	<!-- Documents List -->
	<div class="bg-[var(--color-bg)] rounded-lg shadow p-6 dark:bg-[var(--color-surface)]">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">
				{filterProjectId ? 'Project Documents' : 'All Documents'}
			</h2>
			<button
				onclick={loadDocuments}
				disabled={loadingDocuments}
				class="px-4 py-2 text-sm text-[var(--color-accent)] hover:text-[var(--color-accent-strong)] font-medium disabled:opacity-50"
			>
				{loadingDocuments ? 'Refreshing...' : 'Refresh'}
			</button>
		</div>

		{#if loadingDocuments}
			<Skeleton variant="text" count={5} height="3rem" />
		{:else if documentsError}
			<ErrorState error={documentsError} title="Error loading documents" onRetry={loadDocuments} />
		{:else if documents.length === 0}
			<EmptyState title="No documents found" body="Upload your first document to get started" />
		{:else}
			<div class="space-y-3">
				{#each documents as doc}
					{@const statusView = describeDocumentStatus(doc)}
					{@const degradationText = describeDegradation(doc)}
					<div class="p-4 border border-[var(--color-border)] rounded-lg hover:border-[var(--color-border-strong)] transition-colors dark:border-[var(--color-border)] dark:hover:border-[var(--color-border-strong)]">
					<div class="flex items-center justify-between">
						<!-- Document Info -->
						<div class="flex items-center gap-4 flex-1 min-w-0">
							<span class="text-3xl flex-shrink-0">&#128196;</span>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 mb-1">
									<p class="font-medium text-[var(--color-text)] truncate dark:text-[var(--color-text)]">{doc.filename}</p>
									<!-- The testid + data-degraded live on the wrapper, not on <Tag>:
									     Tag is the shared kit component and does not spread rest props,
									     and widening it for one caller is not worth the blast radius. -->
									<span
										class="flex-shrink-0"
										data-testid="document-status"
										data-degraded={doc.kag_degraded === true}
									>
										<Tag tone={statusView.tone}>{statusView.label}</Tag>
									</span>
								</div>
								<div class="flex items-center gap-4 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
									<span>{formatFileSize(doc.file_size)}</span>
									<span>&#8226;</span>
									<span>{formatDate(doc.created_at)}</span>
									<span>&#8226;</span>
									<span class="text-[var(--color-accent)]">{getProjectName(doc.project_id)}</span>
									{#if doc.pages_detected}
										<span>&#8226;</span>
										<span>{doc.pages_detected} page{doc.pages_detected !== 1 ? 's' : ''}</span>
									{/if}
									{#if doc.entities_extracted}
										<span>&#8226;</span>
										<span>{doc.entities_extracted} entities</span>
									{/if}
								</div>
								<!-- Degraded note — mirrors the CodingJobView "Partial / degraded
								     scan" banner (headline + metrics sub-line). Gated on
								     `=== true`, so an UNKNOWN (null) row renders exactly as
								     before this feature existed. -->
								{#if doc.kag_degraded === true}
									<div
										class="mt-2 rounded-md border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2"
										data-testid="document-degraded-note"
									>
										<p class="text-xs font-medium text-[var(--color-warning-text)]">
											&#9888; Partial / degraded indexing — this document is only partly in the graph
										</p>
										<!-- Skip the sub-line when it would only restate the headline
										     (no honest ratio available); never fabricate a denominator. -->
										{#if degradationText && degradationText !== DEGRADED_GENERIC}
											<p class="mt-1 text-xs text-[var(--color-warning-text)]">{degradationText}</p>
										{/if}
									</div>
									{#if doc.kag_degraded_reason}
										<!-- Mirrors the error_message line below, warning-toned. `title`
										     carries the full string when the reason is truncated. -->
										<p
											class="mt-1 truncate text-sm text-[var(--color-warning-text)]"
											data-testid="document-degraded-reason"
											title={doc.kag_degraded_reason}
										>
											Reason: {doc.kag_degraded_reason}
										</p>
									{/if}
								{/if}
								{#if doc.error_message}
									<p class="text-sm text-[var(--color-danger)] mt-1">Error: {doc.error_message}</p>
								{/if}
								<!-- Status updates are stuck. The pill above is the LAST KNOWN
								     status, not the current one — say so rather than let the row
								     sit on 'processing' forever. Only shown after repeated
								     consecutive failures (see POLL_FAILURES_BEFORE_SURFACING). -->
								{#if statusPollErrors[doc.id]}
									<p
										class="mt-1 text-sm text-[var(--color-warning-text)]"
										data-testid="document-status-poll-error"
										title={statusPollErrors[doc.id]}
									>
										&#9888; Status updates are failing — this status may be out of date: {statusPollErrors[doc.id]}
									</p>
								{/if}
							</div>
						</div>

						<!-- Actions. No "Download": fr/kag stream the uploaded BYTES straight
						     to KAG and persist only metadata + kag_ingestion_id (no file_path,
						     no blob store), so the original file is not retrievable here. -->
						<div class="flex items-center gap-2 flex-shrink-0 ml-4">
							<button
								onclick={() => handleDelete(doc)}
								class="px-4 py-2 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] rounded-lg transition-colors font-medium"
								title="Delete document"
							>
								Delete
							</button>
						</div>
					</div>

					<!-- Staged ingestion progress — shown while in-flight (or on a
					     terminal failure) so the user sees the ~8-min pipeline advance.
					     A `degraded` terminal keeps the stepper up too: it is the only
					     surface that names WHICH stage lost data, and collapsing it
					     would leave the researcher with a warning and no detail. -->
					{#if progressByDoc[doc.id] && (doc.status === 'processing' || doc.status === 'pending' || progressByDoc[doc.id]?.terminal === 'failed' || progressByDoc[doc.id]?.terminal === 'degraded')}
						<div class="mt-3">
							<IngestionProgress progress={progressByDoc[doc.id]} />
						</div>
					{/if}
					</div>
				{/each}
			</div>

			<!-- Document count -->
			<div class="mt-4 pt-4 border-t border-[var(--color-border)] dark:border-[var(--color-border)]">
				<p class="text-sm text-[var(--color-text-muted)] text-center dark:text-[var(--color-text-muted)]">
					Showing {documents.length} document{documents.length !== 1 ? 's' : ''}
					{#if hasProcessingDocs}
						({processingDocuments.length} processing)
					{/if}
				</p>
			</div>
		{/if}
	</div>

	<!-- Ingestion job queue (PR-F P2-2) — async gateway job control, distinct
	     from the fr `documents` rows above. -->
	<div class="mt-6">
		<DocumentJobQueue />
	</div>
</div>
