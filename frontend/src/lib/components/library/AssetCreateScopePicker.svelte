<!--
  AssetCreateScopePicker.svelte

  Asset-creation-time radio: is this new asset tenant-wide (any project
  can bind it later) or scoped to a specific project (auto-bound on
  create)? Used by AssetEditor when the manifest opts in via
  `editor.scopePicker`.

  Emits the chosen scope via two-way binding on `scope` and `projectId`.
  When scope='project', the consumer is responsible for posting a
  binding to /api/assets/<kind>/<new-asset-id>/bindings after the
  upstream create returns.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { displayName } from '$lib/utils/displayName';
  import { authFetch } from '$lib/api/auth-fetch';
  import {
    readFailureReason,
    scopeRefState,
    type ScopeRefState,
  } from '$lib/asset-workspace/scopeRefs';

  interface Props {
    scope: 'tenant' | 'project';
    projectId: string | null;
    defaultScope?: 'tenant' | 'project';
    /**
     * ⚠️ READ-OUT, bound upward so the CONSUMER can act on it.
     *
     * The warning below ("Do not switch to tenant-wide on account of this —
     * retry first") was, until this prop existed, advice with no enforcement:
     * `AssetEditor.onSubmit` never referenced this component's state at all
     * (measured: 0 references to `projectsUnreadable`/`projectsState` in that
     * file, against 10 hits for `scope` — so the file DOES read the picker,
     * just not the half that says the picker cannot be trusted). An asset
     * therefore got created tenant-wide precisely BECAUSE the project
     * directory was unreadable — the widening the copy warns against,
     * performed by the form itself.
     *
     * A warning a user can click past is a warning; a warning the submit path
     * reads is a constraint.
     */
    directoryState?: ScopeRefState;
    /** The reason the directory read failed, for the consumer's message. */
    directoryUnreadableReason?: string | null;
  }

  let {
    scope = $bindable<'tenant' | 'project'>('tenant'),
    projectId = $bindable<string | null>(null),
    defaultScope,
    directoryState = $bindable<ScopeRefState>('ready'),
    directoryUnreadableReason = $bindable<string | null>(null),
  }: Props = $props();

  interface ProjectRow {
    id: string;
    name: string;
  }

  let projects = $state<ProjectRow[]>([]);
  let loading = $state(true);
  // ⚠️ non-null ⇒ the project list could not be READ, and the value is WHY.
  // Distinct from "this tenant has no projects", because the empty-state below
  // does not merely inform — it instructs the user to switch the asset to
  // tenant-wide scope. Acting on that instruction during a backend blip
  // silently broadens the scope of an asset that had a perfectly good project
  // to bind to. The reason is kept because "retry" is sound advice after a 502
  // and useless after a 403, and only the reason tells them apart.
  let projectsUnreadable = $state<string | null>(null);
  // Four states: loading (no claim yet), unreadable, empty (the only state the
  // "switch to tenant-wide" instruction is true in), and pick.
  const projectsState = $derived(scopeRefState(projects.length, projectsUnreadable));

  // Publish the verdict upward. `loading` is deliberately NOT published as a
  // state of its own: the consumer's only question is "may a tenant-wide
  // create proceed", and the answer while loading is yes (the default) —
  // refusing during a normal page load would be a new way to block the form.
  $effect(() => {
    directoryState = projectsState;
    directoryUnreadableReason = projectsUnreadable;
  });

  onMount(async () => {
    if (defaultScope && scope === 'tenant') {
      scope = defaultScope;
    }
    try {
      const res = await authFetch('/api/projects');
      if (res.ok) {
        const body = (await res.json()) as { items?: ProjectRow[] } | ProjectRow[];
        projects = Array.isArray(body) ? body : (body.items ?? []);
      } else {
        // A non-ok response never reached the catch below, so it left `projects`
        // at [] and rendered the same instruction. Two paths, one wrong claim.
        projectsUnreadable = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
      }
    } catch (err) {
      projects = [];
      projectsUnreadable = readFailureReason(err, 'project list read failed');
    } finally {
      loading = false;
    }
  });
</script>

<fieldset
  class="border border-[var(--color-border)] rounded-lg p-3 space-y-2 dark:border-[var(--color-border)]"
  data-testid="asset-create-scope-picker"
>
  <legend class="text-xs font-semibold uppercase text-[var(--color-text)] px-1 dark:text-[var(--color-text-muted)]">
    Scope
  </legend>

  <label class="flex items-start gap-2 cursor-pointer">
    <input
      type="radio"
      bind:group={scope}
      value="tenant"
      class="mt-0.5 text-[var(--color-accent)]"
    />
    <span class="text-sm">
      <span class="block text-[var(--color-text)]">Tenant-wide</span>
      <span class="block text-xs text-[var(--color-text-muted)]">
        Visible across the tenant; any project can bind it later.
      </span>
    </span>
  </label>

  <label class="flex items-start gap-2 cursor-pointer">
    <input
      type="radio"
      bind:group={scope}
      value="project"
      class="mt-0.5 text-[var(--color-accent)]"
    />
    <span class="text-sm">
      <span class="block text-[var(--color-text)]">Specific project</span>
      <span class="block text-xs text-[var(--color-text-muted)]">
        Created and auto-bound to one project; tenant-wide listings hide it
        unless explicitly bound elsewhere.
      </span>
    </span>
  </label>

  {#if scope === 'project'}
    <div class="ml-6 mt-1">
      {#if loading}
        <p class="text-xs text-[var(--color-text-muted)]">Loading projects…</p>
      {:else if projectsState === 'unreadable'}
        <p
          class="text-xs text-[var(--color-warning-text)]"
          data-testid="projects-unreadable"
          title={`Project list read failed — ${projectsUnreadable}`}
        >
          The project list could not be loaded, so it is unknown whether this tenant has projects.
          Do not switch to tenant-wide on account of this — retry first.
          <span class="font-mono text-[var(--color-text-muted)]">({projectsUnreadable})</span>
        </p>
      {:else if projectsState === 'empty'}
        <p class="text-xs text-[var(--color-danger)]">
          No projects available — switch to tenant-wide.
        </p>
      {:else}
        <select
          bind:value={projectId}
          class="w-full px-2 py-1 text-sm border border-[var(--color-border-strong)] rounded focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
        >
          <option value={null}>Pick a project…</option>
          {#each projects as p (p.id)}
            <option value={p.id}>{displayName(p.name, p.id)}</option>
          {/each}
        </select>
      {/if}
    </div>
  {/if}
</fieldset>
