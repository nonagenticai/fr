<!--
  AssetBindingsList.svelte
  ========================
  Plan: ~/.claude/plans/fr-asset-bindings-and-reuse.md (Phase D)

  Inline list of project chips on an asset detail page. One row per
  binding with × Unbind, plus a "+ Bind project" picker that opens a
  small inline selector populated from the user's projects.

  Calls the fr-backend bindings API directly. Optimistic local update
  on success; revert + toast on failure.
-->
<script lang="ts">
  import {
    bindAsset,
    listAssetBindings,
    unbindAsset,
    type AssetBinding,
    type AssetKind,
  } from '$lib/api/bindings';
  import { assetFetch } from '$lib/api/assets';
  import { displayName } from '$lib/utils/displayName';

  interface ProjectSummary {
    id: string;
    name: string;
  }

  let {
    kind,
    asset_id,
  }: {
    kind: AssetKind;
    asset_id: string;
  } = $props();

  let bindings: AssetBinding[] = $state([]);
  let projects: ProjectSummary[] = $state([]);
  let projectsLoaded = false;
  let loading = $state(true);
  let error = $state<string | null>(null);
  let pickerOpen = $state(false);
  let selectedProjectId = $state('');

  const boundProjectIds = $derived(new Set(bindings.map((b) => b.project_id)));
  const availableProjects = $derived(
    projects.filter((p) => !boundProjectIds.has(p.id)),
  );

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      bindings = await listAssetBindings(kind, asset_id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function ensureProjectsLoaded(): Promise<void> {
    if (projectsLoaded) return;
    try {
      projects = await assetFetch<ProjectSummary[]>('/api/projects');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      projectsLoaded = true;
    }
  }

  async function openPicker(): Promise<void> {
    await ensureProjectsLoaded();
    pickerOpen = true;
  }

  async function bind(): Promise<void> {
    if (!selectedProjectId) return;
    const pid = selectedProjectId;
    selectedProjectId = '';
    pickerOpen = false;
    try {
      await bindAsset(kind, asset_id, [pid]);
      await refresh();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function unbind(projectId: string): Promise<void> {
    try {
      await unbindAsset(kind, asset_id, projectId);
      bindings = bindings.filter((b) => b.project_id !== projectId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      await refresh();
    }
  }

  /**
   * The bound project's label for the chip — its name, or the FULL id when the
   * name is blank. Same `projects` array as the `<option>` list sixty lines
   * below, so the two MUST agree: this used to read
   * `find(...)?.name ?? id.slice(0, 8)` while the option list used
   * `displayName(p.name, p.id)`, i.e. one component answering the same question
   * two different ways.
   *
   * ⛔ WHY `?? ` WAS WRONG HERE SPECIFICALLY. `??` falls through on
   * `null`/`undefined` only, so a project named `''` or `'   '` won the chain
   * and painted (a) an EMPTY link, and (b) `aria-label="Unbind from "` on a
   * DESTRUCTIVE control — an unbind button with no accessible name at all.
   * That is strictly worse than the `<option>` case: a screen-reader user is
   * offered an unlabelled button that mutates data.
   *
   * ⛔ WHY THE `slice(0, 8)` TRUNCATION DID NOT SURVIVE. Two reasons, and the
   * second is the deciding one:
   *   1. An accessible name is not width-constrained. "Unbind from 019ff970"
   *      names a thing the user cannot verify against anything on screen,
   *      whereas the chip's own `href` is `/projects/<FULL id>` — so the full id
   *      is the one string that matches where the link goes.
   *   2. The fallback is not a rare edge here, it is the DEFAULT: `projects` is
   *      loaded lazily by `openPicker()`, so until the picker has been opened
   *      once, EVERY chip renders this fallback. A label that is normally shown
   *      must be the honest one.
   * Chip width is a VISUAL problem and is solved visually — the anchor carries
   * `max-w-[14rem] truncate`, which clips pixels while the DOM (and therefore
   * the accessible name and any assistive reader) keeps the whole id. Clipping
   * is reversible; slicing the string is not.
   */
  function projectName(id: string): string {
    return displayName(projects.find((p) => p.id === id)?.name, id);
  }

  $effect(() => {
    void refresh();
  });
</script>

<section data-testid="asset-bindings-list" class="space-y-2">
  <header class="flex items-center justify-between">
    <h3 class="text-sm font-medium text-[var(--color-text)]">Project bindings</h3>
    {#if !pickerOpen}
      <button
        type="button"
        class="text-xs px-2 py-1 border rounded hover:bg-[var(--color-bg-muted)]"
        onclick={openPicker}
      >
        + Bind project
      </button>
    {/if}
  </header>

  {#if loading}
    <p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
  {:else if error}
    <p class="text-xs text-[var(--color-error-text)]">{error}</p>
  {:else if bindings.length === 0}
    <p class="text-xs text-[var(--color-text-muted)]">
      Not bound to any project — visible tenant-wide, out of scope for n8n on
      any specific project.
    </p>
  {:else}
    <ul class="flex flex-wrap gap-2">
      {#each bindings as binding (binding.project_id)}
        <li
          class="inline-flex items-center gap-1 px-2 py-0.5 text-xs border rounded bg-[var(--color-bg-muted)]"
        >
          <a
            href={`/projects/${binding.project_id}`}
            class="hover:underline inline-block max-w-[14rem] truncate align-bottom"
          >
            {projectName(binding.project_id)}
          </a>
          <button
            type="button"
            aria-label={`Unbind from ${projectName(binding.project_id)}`}
            class="text-[var(--color-text-muted)] hover:text-[var(--color-error-text)]"
            onclick={() => unbind(binding.project_id)}
          >
            ×
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if pickerOpen}
    <div class="flex items-center gap-2 mt-2">
      <select
        bind:value={selectedProjectId}
        class="text-xs border rounded px-2 py-1 bg-[var(--color-bg)]"
      >
        <option value="">Select a project…</option>
        {#each availableProjects as p (p.id)}
          <option value={p.id}>{displayName(p.name, p.id)}</option>
        {/each}
      </select>
      <button
        type="button"
        class="text-xs px-2 py-1 border rounded bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]"
        disabled={!selectedProjectId}
        onclick={bind}
      >
        Bind
      </button>
      <button
        type="button"
        class="text-xs px-2 py-1 border rounded"
        onclick={() => {
          pickerOpen = false;
          selectedProjectId = '';
        }}
      >
        Cancel
      </button>
    </div>
  {/if}
</section>
