<!--
  IngestionProgress — staged stepper for an in-flight document upload.

  Upload is an async ~8-min pipeline (parse → KARMA entity extraction → HiRAG
  hierarchy → KAG graph write) and the document is only queryable once HiRAG
  finishes. Without feedback a working upload looks broken. This renders the
  backend's `IngestionProgress` (see integrations/kag.ts deriveIngestionProgress)
  as Uploaded → Parsed → Extracting knowledge → Building hierarchy → Indexed,
  each with a state icon + live counts, an overall % bar, and a collapsible
  operator-grade Details panel exposing the upload's tenant_id (the
  tenant-fragmentation diagnostic) + job ids.

  Design tokens only (both fr + kag run a design-token lint).
-->
<script lang="ts">
	import type { IngestionProgress, IngestionStageState } from '$lib/types/api';
	import { formatChunkRatio } from '$lib/components/kag/degradation';

	let { progress }: { progress: IngestionProgress | null } = $props();

	let showDetails = $state(false);

	// Icon glyph per stage state. Active uses an animated spinner (rendered
	// separately below); the others are static glyphs.
	function glyph(state: IngestionStageState): string {
		switch (state) {
			case 'done':
				return '✓'; // ✓
			case 'failed':
				return '✕'; // ✕
			case 'skipped':
				return '–'; // –
			default:
				return '○'; // ○ (pending)
		}
	}

	function dotClass(state: IngestionStageState): string {
		switch (state) {
			case 'done':
				return 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success)]';
			case 'failed':
				return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border-[var(--color-danger)]';
			case 'active':
				return 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent)]';
			case 'skipped':
				return 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)]';
			default:
				return 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)]';
		}
	}

	function fmtDuration(ms?: number): string | null {
		if (!ms || ms <= 0) return null;
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		return `${m}m ${s % 60}s`;
	}

	async function copy(text: string | null) {
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			/* clipboard blocked — non-fatal */
		}
	}

	let pct = $derived(progress ? Math.max(0, Math.min(100, progress.percentComplete)) : 0);
	let isFailed = $derived(progress?.terminal === 'failed');
	// TERMINAL-BUT-INCOMPLETE (karma PR #127 partial credit): the job finished,
	// the graph did not. Distinct from `failed` — the document IS searchable,
	// just not in full — so this is warning-toned, never danger-toned.
	let isDegraded = $derived(progress?.terminal === 'degraded');
	// Ratio for the terminal degraded block. `formatChunkRatio` returns null
	// rather than inventing a denominator or printing "18 of 18".
	let degradedRatio = $derived(
		progress?.degradation ? formatChunkRatio(progress.degradation) : null,
	);
</script>

{#if progress}
	<div
		class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
		data-testid="ingestion-progress"
	>
		<!-- Overall bar -->
		<div class="mb-3 flex items-center gap-3">
			<div
				class="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-bg)] dark:bg-[var(--color-bg)]"
			>
				<div
					class="h-full rounded-full transition-all duration-500 {isFailed
						? 'bg-[var(--color-danger)]'
						: isDegraded
							? 'bg-[var(--color-warning)]'
							: 'bg-[var(--color-accent)]'}"
					style="width: {pct}%"
					data-testid="ingestion-progress-bar"
				></div>
			</div>
			<span class="text-xs font-medium text-[var(--color-text-muted)]" data-testid="ingestion-progress-pct">
				{pct}%
			</span>
		</div>

		<!-- "keep waiting" hint. Must be suppressed on EVERY terminal, degraded
		     included: a finished-but-partial job is not going to improve, and
		     telling the researcher to wait for "Ready" hides that. -->
		{#if !isFailed && !isDegraded && progress?.terminal !== 'ready'}
			<p class="mb-3 text-xs text-[var(--color-text-muted)]">
				Indexing usually takes a few minutes. The document is searchable only once it shows
				<strong class="text-[var(--color-text)]">Ready</strong>.
			</p>
		{/if}

		<!-- Stepper -->
		<ol class="space-y-2">
			{#each progress?.stages ?? [] as stage (stage.key)}
				<li class="flex items-center gap-3" data-testid="ingestion-stage-{stage.key}" data-state={stage.state}>
					<span
						class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-xs {dotClass(
							stage.state,
						)}"
						aria-hidden="true"
					>
						{#if stage.state === 'active'}
							<span
								class="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent"
							></span>
						{:else}
							{glyph(stage.state)}
						{/if}
					</span>
					<span
						class="text-sm {stage.state === 'pending' || stage.state === 'skipped'
							? 'text-[var(--color-text-muted)]'
							: 'text-[var(--color-text)]'} {stage.state === 'failed' ? 'text-[var(--color-danger)]' : ''}"
					>
						{stage.label}
					</span>
					{#if stage.detail}
						<span class="text-xs text-[var(--color-text-muted)]">· {stage.detail}</span>
					{/if}
					{#if fmtDuration(stage.durationMs)}
						<span class="text-xs text-[var(--color-text-muted)]">· {fmtDuration(stage.durationMs)}</span>
					{/if}
					<!-- A degraded stage keeps data-state="done" — it DID complete. The
					     chip is what says the completion was partial, so the stepper
					     names which stage lost data instead of just flagging the job. -->
					{#if stage.degraded}
						<span
							class="rounded-full border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-1.5 text-[11px] font-semibold text-[var(--color-warning-text)]"
							data-testid="ingestion-stage-{stage.key}-degraded"
							title={stage.degradedReason ?? undefined}
						>
							· partial
						</span>
					{/if}
				</li>
			{/each}
			<!-- Terminal cap — THREE-way. `degraded` is its own outcome: neither the
			     green "Ready" (a lie: the graph is incomplete) nor a pending "not
			     there yet" (also a lie: nothing more is coming). -->
			<li
				class="flex items-center gap-3"
				data-testid="ingestion-stage-ready"
				data-state={isDegraded ? 'degraded' : progress?.terminal === 'ready' ? 'done' : 'pending'}
			>
				<span
					class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-xs {isDegraded
						? 'border-[var(--color-warning)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]'
						: dotClass(progress?.terminal === 'ready' ? 'done' : 'pending')}"
					aria-hidden="true"
				>
					{#if isDegraded}
						&#9888;
					{:else}
						{glyph(progress?.terminal === 'ready' ? 'done' : 'pending')}
					{/if}
				</span>
				<span
					class="text-sm font-medium {isDegraded
						? 'text-[var(--color-warning-text)]'
						: progress?.terminal === 'ready'
							? 'text-[var(--color-success-text)]'
							: 'text-[var(--color-text-muted)]'}"
				>
					{isDegraded ? 'Ready — partially indexed' : 'Ready'}
				</span>
			</li>
		</ol>

		{#if isDegraded}
			<div
				class="mt-3 rounded-md border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2"
				data-testid="ingestion-degraded"
			>
				<p class="text-xs font-medium text-[var(--color-warning-text)]">
					&#9888; Partial / degraded indexing — this document is only partly in the graph
				</p>
				{#if progress?.degradation?.reason}
					<p class="mt-1 text-xs text-[var(--color-warning-text)]">{progress?.degradation?.reason}</p>
				{/if}
				<!-- Ratio only when the backend reported one that is not fabricated. -->
				{#if degradedRatio}
					<p class="mt-1 text-xs text-[var(--color-warning-text)]">{degradedRatio}</p>
				{/if}
			</div>
		{/if}

		{#if isFailed && progress?.errorMessage}
			<p class="mt-3 text-sm text-[var(--color-danger)]" data-testid="ingestion-error">
				{progress?.errorMessage}
			</p>
		{/if}

		<!-- Operator details (debug) — collapsed by default. -->
		<div class="mt-3 border-t border-[var(--color-border)] pt-2">
			<button
				type="button"
				class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
				onclick={() => (showDetails = !showDetails)}
				data-testid="ingestion-details-toggle"
			>
				{showDetails ? '▾' : '▸'} Details
			</button>
			{#if showDetails}
				<dl class="mt-2 space-y-1 text-xs" data-testid="ingestion-details">
					{#each [['Tenant', progress?.ids.tenantId, 'ingestion-tenant'], ['Ingestion job', progress?.ids.ingestionJobId, 'ingestion-job'], ['Orchestrator job', progress?.ids.orchestratorJobId, 'ingestion-orch']] as [label, value, tid]}
						<div class="flex items-center gap-2">
							<dt class="w-28 flex-shrink-0 text-[var(--color-text-muted)]">{label}</dt>
							<dd class="flex items-center gap-2 font-mono text-[var(--color-text)]">
								<span class="truncate" data-testid={tid}>{value ?? '—'}</span>
								{#if value}
									<button
										type="button"
										class="text-[var(--color-accent)] hover:text-[var(--color-accent-strong)]"
										onclick={() => copy(value)}
										title="Copy"
										aria-label="Copy {label}"
									>
										{'⧉'}
									</button>
								{/if}
							</dd>
						</div>
					{/each}
				</dl>
			{/if}
		</div>
	</div>
{/if}
