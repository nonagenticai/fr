<!--
  /library/architecture/models/[id]/versions/[rid] — one saved version of a
  model: what it holds, its diagrams (as they were when saved), its rule checks,
  its reviews (approve / reject with a reason), publishing, and export.

  fr facilitates: the review DECISION is the reviewer's own click; whether the
  version may be published is requirements_management's rule — a refusal is
  shown in plain words with the way forward (e.g. "Check this version").
-->
<script lang="ts">
  import { page } from '$app/state';
  import { Pill } from '$lib/components/ui';
  import DiagramViewer from '$lib/components/modeling/DiagramViewer.svelte';
  import ModelExports from '$lib/components/modeling/ModelExports.svelte';
  import RunVerdict from '$lib/components/modeling/RunVerdict.svelte';
  import {
    ModelingError,
    getModel,
    getRevision,
    listReviews,
    listValidationRuns,
    publishRevision,
    reviewRevision,
    runValidation,
    type ArchitectureModel,
    type ModelReview,
    type ModelRevision,
    type ValidationRun,
  } from '$lib/api/modeling';
  import { plural, versionName, when } from '$lib/modeling/explain';
  import { personLabel } from '$lib/modeling/people';

  const modelId = $derived(decodeURIComponent(page.params.id ?? ''));
  const revisionId = $derived(decodeURIComponent(page.params.rid ?? ''));
  const modelHref = $derived(`/library/architecture/models/${encodeURIComponent(modelId)}`);

  let model = $state<ArchitectureModel | null>(null);
  let revision = $state<ModelRevision | null>(null);
  let reviews = $state<ModelReview[]>([]);
  let runs = $state<ValidationRun[]>([]);
  let loadError = $state<string | null>(null);
  let notFound = $state(false);
  let reviewsError = $state<string | null>(null);
  let runsError = $state<string | null>(null);

  async function loadReviews(): Promise<void> {
    reviewsError = null;
    try {
      reviews = await listReviews(modelId, revisionId);
    } catch (e) {
      reviewsError = e instanceof Error ? e.message : String(e);
    }
  }
  async function loadRuns(): Promise<void> {
    runsError = null;
    try {
      runs = await listValidationRuns(modelId);
    } catch (e) {
      runsError = e instanceof Error ? e.message : String(e);
    }
  }

  async function load(): Promise<void> {
    loadError = null;
    notFound = false;
    try {
      [model, revision] = await Promise.all([getModel(modelId), getRevision(modelId, revisionId)]);
      await Promise.all([loadReviews(), loadRuns()]);
    } catch (e) {
      if (e instanceof ModelingError && e.status === 404) notFound = true;
      else loadError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void modelId;
    void revisionId;
    load();
  });

  const isUml = $derived(model?.language === 'uml');
  // ArchiMate versions hold views; UML versions hold diagrams. Either is drawn from the version itself.
  const views = $derived(
    (isUml ? ((revision?.manifest?.diagrams as Array<{ id: string; name?: string }> | undefined) ?? []) : (revision?.manifest?.views ?? [])) as Array<{ id: string; name?: string }>,
  );
  const elementCount = $derived(isUml ? ((revision?.manifest?.elements as unknown[] | undefined)?.length ?? 0) : (revision?.manifest?.concepts?.length ?? 0));
  const relationshipCount = $derived(revision?.manifest?.relationships?.length ?? 0);
  let selectedView = $state('');
  $effect(() => {
    if (!selectedView && views.length > 0) selectedView = views[0]!.id;
  });
  const selected = $derived(views.find((v) => v.id === selectedView));

  /** Checks of exactly this content: of this version, or of a draft that held identical content. */
  const contentRuns = $derived(revision ? runs.filter((r) => r.revision_id === revision!.revision_id || r.content_hash === revision!.content_hash) : []);
  const decision = $derived(reviews[0] ?? null);
  const isPublished = $derived(!!model && model.published_revision_id === revisionId);

  // --- Review ------------------------------------------------------------------
  let reviewReason = $state('');
  let reviewBusy = $state<'approve' | 'reject' | null>(null);
  let reviewError = $state<string | null>(null);

  async function review(choice: 'approve' | 'reject'): Promise<void> {
    if (choice === 'reject' && !reviewReason.trim()) {
      reviewError = 'Please say why you are rejecting this version.';
      return;
    }
    reviewBusy = choice;
    reviewError = null;
    try {
      await reviewRevision(modelId, revisionId, choice, reviewReason.trim() || undefined);
      reviewReason = '';
      await loadReviews();
    } catch (e) {
      reviewError = e instanceof Error ? e.message : String(e);
    } finally {
      reviewBusy = null;
    }
  }

  // --- Publish -----------------------------------------------------------------
  let publishing = $state(false);
  let publishError = $state<{ message: string; code?: string } | null>(null);

  async function publish(): Promise<void> {
    publishing = true;
    publishError = null;
    try {
      await publishRevision(modelId, revisionId);
      model = await getModel(modelId);
    } catch (e) {
      publishError = { message: e instanceof Error ? e.message : String(e), ...(e instanceof ModelingError && e.code ? { code: e.code } : {}) };
    } finally {
      publishing = false;
    }
  }

  // --- Check this version -------------------------------------------------------
  let validating = $state(false);
  let validateError = $state<string | null>(null);
  async function validateVersion(): Promise<void> {
    validating = true;
    validateError = null;
    try {
      await runValidation(modelId, revisionId);
      publishError = null;
      await loadRuns();
    } catch (e) {
      validateError = e instanceof Error ? e.message : String(e);
    } finally {
      validating = false;
    }
  }

  const card = 'flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4';
  const primary = 'rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] disabled:opacity-50';
  const secondary = 'rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50';
  const retry = 'text-sm font-medium text-[var(--color-link)] underline';
</script>

<div class="flex flex-col gap-4 px-6 py-4" data-testid="version-page">
  <a href={modelHref} class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">← {model?.title ?? 'Model'}</a>

  {#if notFound}
    <div class={card} data-testid="version-not-found">
      <p class="text-sm text-[var(--color-text)]">This version does not exist, or you do not have access to it.</p>
      <a class={retry} href={modelHref}>Back to the model</a>
    </div>
  {:else if loadError}
    <div class="flex flex-wrap items-center gap-2" data-testid="version-error">
      <p class="text-sm text-[var(--color-danger)]">This version could not be loaded: {loadError}</p>
      <button type="button" class={retry} onclick={load}>Try again</button>
    </div>
  {:else if !model || !revision}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the version…</p>
  {:else}
    <header class="flex flex-col gap-1">
      <h1 class="text-2xl font-semibold text-[var(--color-text)]" data-testid="version-title">{versionName(revision)}</h1>
      <div class="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <span>Saved {when(revision.sealed_at)} by {personLabel(revision.sealed_by)}</span>
        <span>·</span>
        <span data-testid="version-summary">{plural(elementCount, 'element')}, {plural(relationshipCount, 'relationship')}, {plural(views.length, isUml ? 'diagram' : 'view')}</span>
        {#if isPublished}<Pill tone="success">Published</Pill>{/if}
      </div>
    </header>

    <!-- Diagrams -->
    {#if views.length > 0}
      <section class="flex flex-col gap-2" data-testid="version-diagrams">
        {#if views.length > 1}
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            {isUml ? 'Diagram' : 'View'}
            <select class="max-w-md rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]" bind:value={selectedView} data-testid="version-view-select">
              {#each views as v (v.id)}<option value={v.id}>{v.name || 'Untitled view'}</option>{/each}
            </select>
          </label>
        {/if}
        {#if selected}
          {#key selected.id}
            {#if isUml}
              <DiagramViewer umlDiagramId={selected.id} {modelId} {revisionId} title={selected.name || 'Untitled diagram'} />
            {:else}
              <DiagramViewer viewId={selected.id} {modelId} {revisionId} title={selected.name || 'Untitled view'} />
            {/if}
          {/key}
        {/if}
      </section>
    {:else}
      <p class="text-sm text-[var(--color-text-muted)]">This version has no {isUml ? 'diagrams' : 'views'} to draw.</p>
    {/if}

    <!-- Rule checks of this content -->
    <section class={card} data-testid="version-validation">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Rule checks of this version</h2>
        <button type="button" class={secondary} onclick={validateVersion} disabled={validating} data-testid="version-validate">{validating ? 'Checking…' : 'Check this version'}</button>
      </div>
      {#if validateError}<p class="text-sm text-[var(--color-danger)]">{validateError}</p>{/if}
      {#if runsError}
        <div class="flex flex-wrap items-center gap-2"><p class="text-sm text-[var(--color-danger)]">The checks could not be loaded: {runsError}</p><button type="button" class={retry} onclick={loadRuns}>Try again</button></div>
      {:else if contentRuns.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">This version has not been checked yet. A version needs a complete check without errors before it can be published.</p>
      {:else}
        <ul class="flex flex-col divide-y divide-[var(--color-border)]">
          {#each contentRuns as r (r.run_id)}
            <li class="flex flex-wrap items-start justify-between gap-3 py-2">
              <a class="text-[var(--color-link)] hover:underline" href={`${modelHref}/validation/${encodeURIComponent(r.run_id)}`}>
                {r.target === 'revision' ? 'Check of this version' : 'Check of the draft (same content)'} — {when(r.finished_at ?? r.started_at)}
              </a>
              <RunVerdict run={r} explain={false} />
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Review and publish -->
    <section class={card} data-testid="version-review">
      <h2 class="text-base font-semibold text-[var(--color-text)]">Review and publish</h2>
      <p class="text-sm text-[var(--color-text)]" data-testid="version-decision">
        {#if decision}
          Current decision: <strong>{decision.decision === 'approve' ? 'approved' : 'rejected'}</strong> by {personLabel(decision.actor)}, {when(decision.created_at)}{decision.reason ? ` — “${decision.reason}”` : ''}.
        {:else}
          Nobody has reviewed this version yet.
        {/if}
      </p>
      {#if reviewsError}
        <div class="flex flex-wrap items-center gap-2"><p class="text-sm text-[var(--color-danger)]">The reviews could not be loaded: {reviewsError}</p><button type="button" class={retry} onclick={loadReviews}>Try again</button></div>
      {/if}
      <label class="flex max-w-2xl flex-col gap-1 text-sm text-[var(--color-text)]">
        Your review comment <span class="text-xs text-[var(--color-text-muted)]">Required when you reject</span>
        <textarea class="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]" rows="2" bind:value={reviewReason} data-testid="version-review-reason"></textarea>
      </label>
      <div class="flex flex-wrap gap-2">
        <button type="button" class={primary} disabled={reviewBusy !== null} onclick={() => review('approve')} data-testid="version-approve">{reviewBusy === 'approve' ? 'Approving…' : 'Approve'}</button>
        <button type="button" class="rounded-md border border-[var(--color-danger-border)] px-3 py-1.5 text-sm font-semibold text-[var(--color-danger)] disabled:opacity-50" disabled={reviewBusy !== null} onclick={() => review('reject')} data-testid="version-reject">{reviewBusy === 'reject' ? 'Rejecting…' : 'Reject'}</button>
      </div>
      {#if reviewError}<p class="text-sm text-[var(--color-danger)]" data-testid="version-review-error">{reviewError}</p>{/if}
      {#if reviews.length > 1}
        <details class="text-sm">
          <summary class="cursor-pointer text-[var(--color-text)]">Earlier reviews ({reviews.length - 1})</summary>
          <ul class="mt-1 flex flex-col gap-1">
            {#each reviews.slice(1) as r (r.id)}
              <li class="text-[var(--color-text-muted)]">{r.decision === 'approve' ? 'Approved' : 'Rejected'} by {personLabel(r.actor)}, {when(r.created_at)}{r.reason ? ` — “${r.reason}”` : ''}</li>
            {/each}
          </ul>
        </details>
      {/if}

      <div class="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
        {#if isPublished}
          <p class="text-sm text-[var(--color-text)]" data-testid="version-is-published">This is the published version of the model.</p>
        {:else}
          <p class="text-sm text-[var(--color-text-muted)]">Publishing needs an approval and a complete rule check of this version without errors.</p>
          <button type="button" class="{primary} self-start" disabled={publishing} onclick={publish} data-testid="version-publish">{publishing ? 'Publishing…' : 'Publish this version'}</button>
        {/if}
        {#if publishError}
          <div class="flex flex-wrap items-center gap-2" data-testid="version-publish-error">
            <p class="text-sm text-[var(--color-danger)]">{publishError.message}</p>
            {#if publishError.code === 'revision_not_validated'}
              <button type="button" class={retry} onclick={validateVersion} disabled={validating}>Check this version now</button>
            {/if}
          </div>
        {/if}
      </div>
    </section>

    <!-- Export: every view / diagram as PDF or SVG, and the language's exchange format -->
    <section class={card} data-testid="version-export">
      <h2 class="text-base font-semibold text-[var(--color-text)]">Export</h2>
      <ModelExports {modelId} {revisionId} language={model?.language} fileTitle={`${model?.title ?? 'model'} version ${revision.seq}`} />
    </section>
  {/if}
</div>
