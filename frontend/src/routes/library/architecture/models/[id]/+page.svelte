<!--
  /library/architecture/models/[id] — one ArchiMate model: its details (edit
  title / description / who can see it), saved versions, rule checks, imported
  changes, export, publication history and deletion — one page, in sections
  (the nav standard forbids menus inside a page).

  Concurrency: the model has a draft "head"; edits and saving a version send the
  head the user last saw, so a change someone else made in between is refused
  (412) with a Reload instead of being silently overwritten.

  fr facilitates: rule-check verdicts, change-set status and publication state
  are requirements_management's, shown as stored.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Pill } from '$lib/components/ui';
  import ExchangeImport from '$lib/components/modeling/ExchangeImport.svelte';
  import ModelTraceLinks from '$lib/components/modeling/ModelTraceLinks.svelte';
  import ModelExports from '$lib/components/modeling/ModelExports.svelte';
  import UmlModelContents from '$lib/components/modeling/UmlModelContents.svelte';
  import ArchimateModelContents from '$lib/components/modeling/ArchimateModelContents.svelte';
  import RunVerdict from '$lib/components/modeling/RunVerdict.svelte';
  import {
    ModelingError,
    deleteModel,
    getModel,
    listChangeSets,
    listPublications,
    listRevisions,
    listValidationRuns,
    runValidation,
    sealRevision,
    updateModel,
    type ArchitectureModel,
    type ChangeSet,
    type ModelPatch,
    type ModelPublication,
    type ModelRevision,
    type ModelVisibility,
    type ValidationRun,
  } from '$lib/api/modeling';
  import { changeSetStatus, opsSummary, versionName, visibilityLabel, when } from '$lib/modeling/explain';
  import { personLabel } from '$lib/modeling/people';
  import { activeProject } from '$lib/stores/activeProject.svelte';

  const id = $derived(decodeURIComponent(page.params.id ?? ''));
  const base = $derived(`/library/architecture/models/${encodeURIComponent(id)}`);

  let model = $state<ArchitectureModel | null>(null);
  let loadError = $state<string | null>(null);
  let notFound = $state(false);
  let revisions = $state<ModelRevision[]>([]);
  let runs = $state<ValidationRun[]>([]);
  let changeSets = $state<ChangeSet[]>([]);
  let publications = $state<ModelPublication[]>([]);
  let sectionErrors = $state<Record<string, string>>({});
  // Applying imported changes alters the contents: the contents panel reads them again.
  let contentsKey = $state(0);

  async function loadModel(): Promise<void> {
    loadError = null;
    notFound = false;
    try {
      model = await getModel(id);
    } catch (e) {
      model = null;
      if (e instanceof ModelingError && e.status === 404) notFound = true;
      else loadError = e instanceof Error ? e.message : String(e);
    }
  }

  async function section<T>(key: string, run: () => Promise<T>, set: (v: T) => void): Promise<void> {
    try {
      set(await run());
      const { [key]: _drop, ...rest } = sectionErrors;
      sectionErrors = rest;
    } catch (e) {
      sectionErrors = { ...sectionErrors, [key]: e instanceof Error ? e.message : String(e) };
    }
  }
  const loadRevisions = () => section('revisions', () => listRevisions(id), (v) => (revisions = v));
  const loadRuns = () => section('runs', () => listValidationRuns(id), (v) => (runs = v));
  const loadChangeSets = () => section('changes', () => listChangeSets(id), (v) => (changeSets = v));
  const loadPublications = () => section('publications', () => listPublications(id), (v) => (publications = v));

  async function loadAll(): Promise<void> {
    await loadModel();
    if (model) await Promise.all([loadRevisions(), loadRuns(), loadChangeSets(), loadPublications()]);
  }

  $effect(() => {
    void id;
    loadAll();
  });
  $effect(() => {
    if (!activeProject.loaded) void activeProject.load();
  });

  const projectName = $derived(
    model?.project_id ? (activeProject.projects.find((p) => p.id === model!.project_id)?.name ?? 'A project you cannot see') : null,
  );
  const revisionById = $derived(new Map(revisions.map((r) => [r.revision_id, r])));

  // --- Edit details -----------------------------------------------------------
  let editing = $state(false);
  let editTitle = $state('');
  let editDescription = $state('');
  let editVisibility = $state<ModelVisibility>('tenant');
  let editHead = $state<number | undefined>(undefined);
  let saving = $state(false);
  let editError = $state<string | null>(null);
  let editStale = $state(false);

  function startEdit(): void {
    if (!model) return;
    editTitle = model.title;
    editDescription = model.description ?? '';
    editVisibility = model.visibility === 'user' ? 'user' : 'tenant';
    editHead = model.head;
    editError = null;
    editStale = false;
    editing = true;
  }

  async function saveEdit(e: Event): Promise<void> {
    e.preventDefault();
    if (!model) return;
    if (!editTitle.trim()) {
      editError = 'A model needs a title.';
      return;
    }
    const patch: ModelPatch = {};
    if (editTitle.trim() !== model.title) patch.title = editTitle.trim();
    if ((editDescription.trim() || null) !== (model.description ?? null)) patch.description = editDescription.trim() || null;
    if (editVisibility !== model.visibility) patch.visibility = editVisibility;
    if (Object.keys(patch).length === 0) {
      editing = false;
      return;
    }
    saving = true;
    editError = null;
    editStale = false;
    try {
      model = await updateModel(id, patch, editHead);
      editing = false;
    } catch (err) {
      if (err instanceof ModelingError && err.code === 'stale_head') editStale = true;
      editError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  async function reloadAfterStale(): Promise<void> {
    await loadAll();
    if (model) startEdit();
  }

  // --- Save a version -----------------------------------------------------------
  let sealLabel = $state('');
  let sealing = $state(false);
  let sealError = $state<string | null>(null);
  let sealStale = $state(false);

  async function seal(e: Event): Promise<void> {
    e.preventDefault();
    if (!model) return;
    sealing = true;
    sealError = null;
    sealStale = false;
    try {
      const rev = await sealRevision(id, sealLabel.trim() || undefined, model.head);
      sealLabel = '';
      await Promise.all([loadModel(), loadRevisions()]);
      await goto(`${base}/versions/${encodeURIComponent(rev.revision_id)}`);
    } catch (err) {
      if (err instanceof ModelingError && err.code === 'stale_head') sealStale = true;
      sealError = err instanceof Error ? err.message : String(err);
    } finally {
      sealing = false;
    }
  }

  // --- Rule checks ------------------------------------------------------------
  let validating = $state(false);
  let validateError = $state<string | null>(null);

  async function validateDraft(): Promise<void> {
    validating = true;
    validateError = null;
    try {
      const run = await runValidation(id);
      await goto(`${base}/validation/${encodeURIComponent(run.run_id)}`);
    } catch (err) {
      validateError = err instanceof Error ? err.message : String(err);
    } finally {
      validating = false;
    }
  }

  function runTarget(r: ValidationRun): string {
    if (r.target === 'draft_head') return 'Current draft';
    const rev = r.revision_id ? revisionById.get(r.revision_id) : undefined;
    return rev ? versionName(rev) : 'A saved version';
  }

  // --- Delete ------------------------------------------------------------------
  let deleting = $state(false);
  let confirmTitle = $state('');
  let deleteBusy = $state(false);
  let deleteError = $state<string | null>(null);
  let needsForce = $state(false);
  const titleMatches = $derived(!!model && confirmTitle.trim() === model.title.trim());

  async function remove(force: boolean): Promise<void> {
    if (!titleMatches) return;
    deleteBusy = true;
    deleteError = null;
    try {
      await deleteModel(id, force);
      await goto('/library/architecture/models');
    } catch (err) {
      if (err instanceof ModelingError && err.code === 'model_has_revisions') needsForce = true;
      deleteError = err instanceof Error ? err.message : String(err);
    } finally {
      deleteBusy = false;
    }
  }

  const card = 'flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4';
  const field = 'w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]';
  const primary = 'rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] disabled:opacity-50';
  const secondary = 'rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50';
  const retry = 'text-sm font-medium text-[var(--color-link)] underline';
</script>

<div class="flex flex-col gap-4 px-6 py-4" data-testid="model-page">
  <a href="/library/architecture/models" class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">← Architecture models</a>

  {#if notFound}
    <div class={card} data-testid="model-not-found">
      <p class="text-sm text-[var(--color-text)]">This model does not exist, or you do not have access to it. It may have been deleted.</p>
      <a class={retry} href="/library/architecture/models">Back to all models</a>
    </div>
  {:else if loadError}
    <div class="flex flex-wrap items-center gap-2" data-testid="model-error">
      <p class="text-sm text-[var(--color-danger)]">The model could not be loaded: {loadError}</p>
      <button type="button" class={retry} onclick={loadAll}>Try again</button>
    </div>
  {:else if !model}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the model…</p>
  {:else}
    <header class="flex flex-col gap-1">
      <h1 class="text-2xl font-semibold text-[var(--color-text)]" data-testid="model-title">{model.title}</h1>
      <div class="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <span>{model.language === 'uml' ? 'UML' : 'ArchiMate'} {model.language_version}</span>
        <span>·</span>
        <span>{visibilityLabel(model.visibility)}</span>
        {#if projectName}<span>·</span><span>Project: {projectName}</span>{/if}
        {#if model.published_revision_id}
          <Pill tone="success">Published: {revisionById.get(model.published_revision_id) ? versionName(revisionById.get(model.published_revision_id)!) : 'a saved version'}</Pill>
        {/if}
      </div>
      {#if model.description}<p class="max-w-3xl text-sm text-[var(--color-text)]">{model.description}</p>{/if}
    </header>

    <!-- Details -->
    <section class={card} data-testid="model-details">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Details</h2>
        {#if !editing}<button type="button" class={secondary} onclick={startEdit} data-testid="model-edit">Edit</button>{/if}
      </div>
      {#if editing}
        <form class="flex max-w-2xl flex-col gap-3" onsubmit={saveEdit} data-testid="model-edit-form">
          <label class="flex flex-col gap-1 text-sm text-[var(--color-text)]">Title<input class={field} bind:value={editTitle} maxlength="300" data-testid="model-edit-title" /></label>
          <label class="flex flex-col gap-1 text-sm text-[var(--color-text)]">Description<textarea class={field} rows="3" bind:value={editDescription} data-testid="model-edit-description"></textarea></label>
          <fieldset class="flex flex-col gap-1 text-sm text-[var(--color-text)]" disabled={model.is_default}>
            <legend class="mb-1">Who can see it</legend>
            <label class="flex items-center gap-2"><input type="radio" bind:group={editVisibility} value="tenant" /> Everyone in the workspace</label>
            <label class="flex items-center gap-2"><input type="radio" bind:group={editVisibility} value="user" /> Only the owner</label>
            {#if model.is_default}<span class="text-xs text-[var(--color-text-muted)]">This is the workspace's default model; who can see it is fixed.</span>{/if}
          </fieldset>
          {#if editError}
            <div class="flex flex-wrap items-center gap-2" data-testid="model-edit-error">
              <p class="text-sm text-[var(--color-danger)]">{editError}</p>
              {#if editStale}<button type="button" class={retry} onclick={reloadAfterStale} data-testid="model-edit-reload">Reload the latest version</button>{/if}
            </div>
          {/if}
          <div class="flex gap-2">
            <button type="submit" class={primary} disabled={saving} data-testid="model-edit-save">{saving ? 'Saving…' : 'Save'}</button>
            <button type="button" class="px-3 py-1.5 text-sm text-[var(--color-text-muted)]" onclick={() => (editing = false)}>Cancel</button>
          </div>
        </form>
      {:else}
        <dl class="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-sm">
          <dt class="text-[var(--color-text-muted)]">Created</dt><dd class="text-[var(--color-text)]">{when(model.created_at)}</dd>
          <dt class="text-[var(--color-text-muted)]">Last changed</dt><dd class="text-[var(--color-text)]">{when(model.updated_at)}</dd>
          <dt class="text-[var(--color-text-muted)]">Owner</dt><dd class="text-[var(--color-text)]">{personLabel(model.subject_id)}</dd>
        </dl>
      {/if}
    </section>

    <!-- Versions -->
    <section class={card} data-testid="model-versions">
      <h2 class="text-base font-semibold text-[var(--color-text)]">Saved versions</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        A saved version is a snapshot that never changes. Reviews and publishing work on saved versions.
      </p>
      <form class="flex flex-wrap items-end gap-2" onsubmit={seal}>
        <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Label <span>Optional, e.g. "Release 1"</span>
          <input class="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]" bind:value={sealLabel} maxlength="200" data-testid="model-seal-label" />
        </label>
        <button type="submit" class={primary} disabled={sealing} data-testid="model-seal">{sealing ? 'Saving…' : 'Save the current draft as a version'}</button>
      </form>
      {#if sealError}
        <div class="flex flex-wrap items-center gap-2" data-testid="model-seal-error">
          <p class="text-sm text-[var(--color-danger)]">{sealError}</p>
          {#if sealStale}<button type="button" class={retry} onclick={loadAll}>Reload</button>{/if}
        </div>
      {/if}
      {#if sectionErrors.revisions}
        <div class="flex flex-wrap items-center gap-2"><p class="text-sm text-[var(--color-danger)]">The versions could not be loaded: {sectionErrors.revisions}</p><button type="button" class={retry} onclick={loadRevisions}>Try again</button></div>
      {:else if revisions.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]" data-testid="model-versions-empty">No saved versions yet.</p>
      {:else}
        <ul class="flex flex-col divide-y divide-[var(--color-border)]">
          {#each revisions as r (r.revision_id)}
            <li class="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="model-version-row">
              <a class="font-medium text-[var(--color-link)] hover:underline" href={`${base}/versions/${encodeURIComponent(r.revision_id)}`}>{versionName(r)}</a>
              <span class="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                {#if model.published_revision_id === r.revision_id}<Pill tone="success">Published</Pill>{/if}
                Saved {when(r.sealed_at)} by {personLabel(r.sealed_by)}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if publications.length > 0}
        <details class="text-sm" data-testid="model-publications">
          <summary class="cursor-pointer text-[var(--color-text)]">Publication history ({publications.length})</summary>
          <ul class="mt-2 flex flex-col gap-1">
            {#each publications as p (p.id)}
              <li class="text-[var(--color-text)]">
                {revisionById.get(p.revision_id) ? versionName(revisionById.get(p.revision_id)!) : 'A saved version'} published {when(p.published_at)} by {personLabel(p.published_by)}{p.supersedes_revision_id ? `, replacing ${revisionById.get(p.supersedes_revision_id) ? versionName(revisionById.get(p.supersedes_revision_id)!) : 'an earlier version'}` : ''}.
              </li>
            {/each}
          </ul>
        </details>
      {:else if sectionErrors.publications}
        <p class="text-sm text-[var(--color-danger)]">The publication history could not be loaded: {sectionErrors.publications}</p>
      {/if}
    </section>

    <!-- Rule checks -->
    <section class={card} data-testid="model-validation">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Rule checks</h2>
        <button type="button" class={primary} onclick={validateDraft} disabled={validating} data-testid="model-validate">{validating ? 'Checking…' : 'Check the current draft'}</button>
      </div>
      <p class="text-sm text-[var(--color-text-muted)]">
        Checks the model against the ArchiMate modeling rules. To check a saved version, open it.
      </p>
      {#if validateError}<p class="text-sm text-[var(--color-danger)]" data-testid="model-validate-error">{validateError}</p>{/if}
      {#if sectionErrors.runs}
        <div class="flex flex-wrap items-center gap-2"><p class="text-sm text-[var(--color-danger)]">The checks could not be loaded: {sectionErrors.runs}</p><button type="button" class={retry} onclick={loadRuns}>Try again</button></div>
      {:else if runs.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No checks have been run yet.</p>
      {:else}
        <ul class="flex flex-col divide-y divide-[var(--color-border)]">
          {#each runs as r (r.run_id)}
            <li class="flex flex-wrap items-start justify-between gap-3 py-2" data-testid="model-run-row">
              <a class="font-medium text-[var(--color-link)] hover:underline" href={`${base}/validation/${encodeURIComponent(r.run_id)}`}>{runTarget(r)} — {when(r.finished_at ?? r.started_at)}</a>
              <RunVerdict run={r} explain={false} />
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if model.language === 'uml'}
      <!-- UML contents: elements, relationships, interactions, diagrams -->
      <UmlModelContents modelId={id} projectId={model.project_id} onChange={loadModel} />
    {:else}
      <!-- ArchiMate contents: elements, relationships, views (with their shapes and lines) -->
      {#key contentsKey}<ArchimateModelContents modelId={id} projectId={model.project_id} visibility={model.visibility} head={model.head} onChange={loadModel} />{/key}
    <!-- Imported changes -->
      <section class={card} id="imported-changes" data-testid="model-changes">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Imported changes</h2>
        <ExchangeImport modelId={id} onImported={loadChangeSets} onChange={() => { contentsKey += 1; return Promise.all([loadModel(), loadChangeSets()]); }} />
        {#if sectionErrors.changes}
          <div class="flex flex-wrap items-center gap-2"><p class="text-sm text-[var(--color-danger)]">The change history could not be loaded: {sectionErrors.changes}</p><button type="button" class={retry} onclick={loadChangeSets}>Try again</button></div>
        {:else if changeSets.length > 0}
          <ul class="flex flex-col divide-y divide-[var(--color-border)]">
            {#each changeSets as c (c.id)}
              {@const s = changeSetStatus(c.status)}
              <li class="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="model-change-row">
                <a class="text-[var(--color-link)] hover:underline" href={`${base}/changes/${encodeURIComponent(c.id)}`}>{opsSummary(c.ops)}</a>
                <span class="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Pill tone={s.tone}>{s.label}</Pill>{when(c.created_at)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    <!-- Export: every view / diagram as PDF or SVG, and the language's exchange format -->
    <section class={card} data-testid="model-export">
      <h2 class="text-base font-semibold text-[var(--color-text)]">Export</h2>
      <p class="text-sm text-[var(--color-text-muted)]">Download the current draft: every {model.language === 'uml' ? 'diagram' : 'view'} as one PDF or as SVG files in a zip, or the model as {model.language === 'uml' ? 'an XMI file' : 'an Open Group exchange file (.xml)'} to open in other modeling tools. To export a saved version, open it.</p>
      <ModelExports modelId={id} language={model.language} fileTitle={model.title} />
    </section>

    <ModelTraceLinks modelId={id} />

    <!-- Delete -->
    <section class="flex flex-col gap-3 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-surface)] p-4" data-testid="model-delete">
      <h2 class="text-base font-semibold text-[var(--color-text)]">Delete this model</h2>
      {#if !deleting}
        <button type="button" class="self-start rounded-md border border-[var(--color-danger-border)] px-3 py-1.5 text-sm font-semibold text-[var(--color-danger)]" onclick={() => (deleting = true)} data-testid="model-delete-start">Delete model…</button>
      {:else}
        <p class="text-sm text-[var(--color-text)]">This cannot be undone. Type <strong>{model.title}</strong> to confirm.</p>
        <input class="{field} max-w-md" bind:value={confirmTitle} autocomplete="off" aria-label="Model title" data-testid="model-delete-confirm-title" />
        {#if deleteError}<p class="text-sm text-[var(--color-danger)]" data-testid="model-delete-error">{deleteError}</p>{/if}
        <div class="flex flex-wrap gap-2">
          {#if needsForce}
            <button type="button" class="rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50" disabled={!titleMatches || deleteBusy} onclick={() => remove(true)} data-testid="model-delete-force">
              {deleteBusy ? 'Deleting…' : 'Delete the model with its saved versions, checks and imported changes'}
            </button>
          {:else}
            <button type="button" class="rounded-md bg-[var(--color-danger)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50" disabled={!titleMatches || deleteBusy} onclick={() => remove(false)} data-testid="model-delete-confirm">
              {deleteBusy ? 'Deleting…' : 'Delete model'}
            </button>
          {/if}
          <button type="button" class="px-3 py-1.5 text-sm text-[var(--color-text-muted)]" onclick={() => { deleting = false; needsForce = false; deleteError = null; confirmTitle = ''; }}>Cancel</button>
        </div>
      {/if}
    </section>
  {/if}
</div>
