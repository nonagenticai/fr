<!--
  /library/architecture/models — ArchiMate models (requirements_management's
  modeling lifecycle). List with filters (project, title), create a model, or
  create one from an ArchiMate exchange file. Each row opens the model page
  (versions, validation, review and publishing, imports, exports).
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Pill } from '$lib/components/ui';
  import ExchangeImport from '$lib/components/modeling/ExchangeImport.svelte';
  import { createModel, listModels, newIntentKey, type ArchitectureModel, type ModelVisibility } from '$lib/api/modeling';
  import { visibilityLabel, when } from '$lib/modeling/explain';
  import { activeProject } from '$lib/stores/activeProject.svelte';

  const projectFilter = $derived(page.url.searchParams.get('project_id') ?? '');
  let q = $state('');
  // Scoped to a project (e.g. from the project's Architecture hub) ⇒ all
  // languages, so the hub's UML models do not vanish behind the ArchiMate default.
  let language = $state<'archimate' | 'uml' | ''>(page.url.searchParams.get('project_id') ? '' : 'archimate');
  let models = $state<ArchitectureModel[]>([]);
  let truncated = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // `?new=1` / `?import=1` open the form on arrival (the project Architecture
  // hub links here pre-scoped with `?project_id=`).
  let creating = $state(page.url.searchParams.get('new') === '1');
  let importing = $state(page.url.searchParams.get('import') === '1' && page.url.searchParams.get('new') !== '1');
  let title = $state('');
  let description = $state('');
  // A new model defaults to the project the list is filtered to.
  let projectId = $state(page.url.searchParams.get('project_id') ?? '');
  let visibility = $state<ModelVisibility>('tenant');
  let newLanguage = $state<'archimate' | 'uml'>('archimate');
  // One key per "New model" form: a retry of a failed create reuses it.
  let createKey = newIntentKey();
  let saving = $state(false);
  let createError = $state<string | null>(null);

  $effect(() => {
    if (!activeProject.loaded) void activeProject.load();
  });

  const projectName = (id: string | null) =>
    id ? (activeProject.projects.find((p) => p.id === id)?.name ?? 'A project you cannot see') : 'No project';

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await listModels({ ...(projectFilter ? { project_id: projectFilter } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(language ? { language } : {}) });
      models = res.items;
      truncated = res.truncated;
    } catch (e) {
      models = [];
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void projectFilter;
    void language;
    load();
  });

  function setProjectFilter(id: string): void {
    const url = new URL(page.url);
    if (id) url.searchParams.set('project_id', id);
    else url.searchParams.delete('project_id');
    goto(`${url.pathname}${url.search}`, { keepFocus: true, noScroll: true });
  }

  function search(e: Event): void {
    e.preventDefault();
    load();
  }

  async function create(e: Event): Promise<void> {
    e.preventDefault();
    if (!title.trim()) {
      createError = 'Give the model a title.';
      return;
    }
    saving = true;
    createError = null;
    try {
      const m = await createModel({
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        visibility,
        language: newLanguage,
      }, createKey);
      await goto(`/library/architecture/models/${encodeURIComponent(m.id)}`);
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  const fieldClass = 'w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]';
  const secondaryButton = 'rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]';
</script>

<div class="flex flex-col gap-4 px-6 py-4" data-testid="models-page">
  <header class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold text-[var(--color-text)]">Architecture models</h1>
      <p class="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
        ArchiMate and UML models with saved versions, rule checks, reviews and publishing. Open a model to work on it.
      </p>
    </div>
    <div class="flex gap-2">
      <button type="button" class={secondaryButton} onclick={() => { importing = !importing; creating = false; }} data-testid="models-import-toggle">
        Import a file
      </button>
      <button
        type="button"
        class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)]"
        onclick={() => { creating = !creating; importing = false; createKey = newIntentKey(); projectId = projectFilter; }}
        data-testid="models-new-toggle"
      >
        New model
      </button>
    </div>
  </header>

  {#if creating}
    <form class="flex max-w-2xl flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" onsubmit={create} data-testid="model-create-form">
      <h2 class="text-base font-semibold text-[var(--color-text)]">New model</h2>
      <fieldset class="flex flex-col gap-1 text-sm text-[var(--color-text)]">
        <legend class="mb-1">Language</legend>
        <label class="flex items-center gap-2"><input type="radio" bind:group={newLanguage} value="archimate" data-testid="model-create-archimate" /> ArchiMate <span class="text-xs text-[var(--color-text-muted)]">(enterprise architecture: layers, views)</span></label>
        <label class="flex items-center gap-2"><input type="radio" bind:group={newLanguage} value="uml" data-testid="model-create-uml" /> UML <span class="text-xs text-[var(--color-text-muted)]">(classes, components, sequences)</span></label>
      </fieldset>
      <label class="flex flex-col gap-1 text-sm text-[var(--color-text)]">
        Title
        <input class={fieldClass} bind:value={title} maxlength="300" required data-testid="model-create-title" />
      </label>
      <label class="flex flex-col gap-1 text-sm text-[var(--color-text)]">
        Description <span class="text-xs text-[var(--color-text-muted)]">Optional</span>
        <textarea class={fieldClass} bind:value={description} rows="3" data-testid="model-create-description"></textarea>
      </label>
      <label class="flex flex-col gap-1 text-sm text-[var(--color-text)]">
        Project <span class="text-xs text-[var(--color-text-muted)]">Optional. A model in a project is also available to that project's assistant.</span>
        <select class={fieldClass} bind:value={projectId} data-testid="model-create-project">
          <option value="">No project</option>
          {#each activeProject.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
        </select>
      </label>
      <fieldset class="flex flex-col gap-1 text-sm text-[var(--color-text)]">
        <legend class="mb-1">Who can see it</legend>
        <label class="flex items-center gap-2"><input type="radio" bind:group={visibility} value="tenant" /> Everyone in the workspace</label>
        <label class="flex items-center gap-2"><input type="radio" bind:group={visibility} value="user" /> Only me</label>
      </fieldset>
      {#if createError}<p class="text-sm text-[var(--color-danger)]" data-testid="model-create-error">{createError}</p>{/if}
      <div class="flex gap-2">
        <button type="submit" class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50" disabled={saving} data-testid="model-create-submit">
          {saving ? 'Creating…' : 'Create model'}
        </button>
        <button type="button" class="px-3 py-1.5 text-sm text-[var(--color-text-muted)]" onclick={() => (creating = false)}>Cancel</button>
      </div>
    </form>
  {/if}

  {#if importing}
    <div class="flex max-w-3xl flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="models-import">
      <h2 class="text-base font-semibold text-[var(--color-text)]">New model from a file</h2>
      <ExchangeImport
        projectId={projectFilter || undefined}
        onImported={() => load()}
        onChange={(cs) => goto(`/library/architecture/models/${encodeURIComponent(cs.model_id)}`)}
      />
    </div>
  {/if}

  <div class="flex flex-wrap items-end gap-3">
    <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
      Project
      <select
        class="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]"
        value={projectFilter}
        onchange={(e) => setProjectFilter((e.currentTarget as HTMLSelectElement).value)}
        data-testid="models-filter-project"
      >
        <option value="">All projects</option>
        {#each activeProject.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
      </select>
    </label>
    <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
      Language
      <select class="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]" bind:value={language} data-testid="models-filter-language">
        <option value="archimate">ArchiMate</option>
        <option value="uml">UML</option>
        <option value="">All languages</option>
      </select>
    </label>
    <form class="flex items-end gap-2" onsubmit={search}>
      <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
        Title contains
        <input class="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]" bind:value={q} data-testid="models-filter-q" />
      </label>
      <button type="submit" class={secondaryButton}>Search</button>
    </form>
  </div>

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading models…</p>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2" data-testid="models-error">
      <p class="text-sm text-[var(--color-danger)]">The models could not be loaded: {error}</p>
      <button type="button" class="text-sm font-medium text-[var(--color-link)] underline" onclick={load}>Try again</button>
    </div>
  {:else if models.length === 0}
    <div class="rounded-lg border border-dashed border-[var(--color-border-strong)] p-6 text-sm text-[var(--color-text-muted)]" data-testid="models-empty">
      {projectFilter || q.trim() || language !== 'archimate' ? 'No model matches these filters.' : 'No models yet. Create one, or import an ArchiMate exchange file.'}
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full min-w-[48rem] text-left text-sm" data-testid="models-table">
        <thead class="text-xs text-[var(--color-text-muted)]">
          <tr>
            <th class="py-1 pr-3 font-medium">Model</th>
            <th class="py-1 pr-3 font-medium">Project</th>
            <th class="py-1 pr-3 font-medium">Who can see it</th>
            <th class="py-1 pr-3 font-medium">Published</th>
            <th class="py-1 font-medium">Last changed</th>
          </tr>
        </thead>
        <tbody>
          {#each models as m (m.id)}
            <tr class="border-t border-[var(--color-border)]" data-testid="model-row">
              <td class="py-2 pr-3">
                <a class="font-medium text-[var(--color-link)] hover:underline" href={`/library/architecture/models/${encodeURIComponent(m.id)}`}>{m.title}</a>
                {#if m.is_default}<span class="ml-1 text-xs text-[var(--color-text-muted)]">(workspace default)</span>{/if}
              </td>
              <td class="py-2 pr-3 text-[var(--color-text)]">{projectName(m.project_id)}</td>
              <td class="py-2 pr-3 text-[var(--color-text)]">{visibilityLabel(m.visibility)}</td>
              <td class="py-2 pr-3">{#if m.published_revision_id}<Pill tone="success">Published</Pill>{:else}<span class="text-[var(--color-text-muted)]">Not yet</span>{/if}</td>
              <td class="py-2 text-[var(--color-text-muted)]">{when(m.updated_at)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if truncated}
      <p class="text-xs text-[var(--color-warning-text)]">Only the first models are shown. Narrow the list with the filters above.</p>
    {/if}
  {/if}
</div>
