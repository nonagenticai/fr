<!--
  BriefSection (R6) — the project brief inside Plan & scope (FR-PROJECT-HOME-REDESIGN §3/§5). Moved
  from the retired /projects/[id]/brief page, which now 308s to /projects/[id]/plan.

  The brief lives in requirements management (RM) as VERSIONS. READ-ONLY (George 2026-10-13,
  D15/R16): v1 is the user's project request; every later version comes from the conveyor (the PM)
  and is only displayed. The section picks a version (newest first), shows who wrote it and its
  note, diffs it field by field against the version before it, prints the full brief at that
  version, and lists the history. RM unreachable (503 rm_brief_unavailable) is shown as
  unavailable, never as an empty brief. It fetches its own data, so a failed brief read leaves the
  rest of Plan & scope standing.
-->
<script lang="ts">
  import { Button, Pill, Select } from '$lib/components/ui';
  import BriefVersionHistory from '$lib/components/brief/BriefVersionHistory.svelte';
  import {
    getBriefVersion,
    getCurrentBrief,
    listBriefVersions,
    type BriefFailure,
    type BriefVersionDetail,
    type BriefVersionList,
    type CurrentProjectBrief,
    type ProjectBrief,
  } from '$lib/api/project-brief';
  import {
    BRIEF_FIELDS,
    EMPTY,
    NOTES_MAX_CHARS,
    diffBriefs,
    isEmptyValue,
    itemText,
    previousVersionOf,
    versionLabel,
    viewingBadge,
    type FieldDiff,
  } from '$lib/projects/brief-diff';

  let { projectId }: { projectId: string } = $props();

  let loading = $state(true);
  let current = $state<CurrentProjectBrief | null>(null);
  let versions = $state<BriefVersionList | null>(null);
  let loadFailure = $state<BriefFailure | null>(null);

  let selected = $state('');
  let detail = $state<BriefVersionDetail | null>(null);
  let previous = $state<BriefVersionDetail | null>(null);
  let detailFailure = $state<BriefFailure | null>(null);
  let detailLoading = $state(false);

  const newest = $derived<number | null>(
    versions ? (versions.current_version ?? versions.data[0]?.version ?? null) : null,
  );
  const versionOptions = $derived(
    (versions?.data ?? []).map((v) => ({ value: String(v.version), label: versionLabel(v) })),
  );
  const viewed = $derived<number | null>(selected === '' ? null : Number(selected));
  const viewedSummary = $derived(versions?.data.find((v) => v.version === viewed) ?? null);
  const isNewest = $derived(viewed !== null && viewed === newest);
  /** No version exists yet (a project created before RM held the brief): show the flat brief. */
  const noVersions = $derived(!!versions && versions.data.length === 0);
  /** The brief on screen: the viewed version's, else (no versions yet) the flat current one. */
  const shown = $derived<ProjectBrief | null>(detail?.brief ?? (noVersions ? current : null));
  const diff = $derived<FieldDiff[]>(
    detail && viewed !== null ? diffBriefs(previous?.brief ?? null, detail.brief) : [],
  );
  const prevVersion = $derived(
    versions && viewed !== null ? previousVersionOf(versions.data, viewed) : null,
  );

  async function load(): Promise<void> {
    loading = true;
    loadFailure = null;
    const [c, v] = await Promise.all([getCurrentBrief(projectId), listBriefVersions(projectId)]);
    loading = false;
    if (!c.ok) {
      loadFailure = c;
      return;
    }
    if (!v.ok) {
      loadFailure = v;
      return;
    }
    current = c.data;
    versions = v.data;
    const top = v.data.current_version ?? v.data.data[0]?.version ?? null;
    if (top === null) {
      selected = '';
      detail = null;
      previous = null;
      return;
    }
    selected = String(top);
    await showVersion(top);
  }

  async function showVersion(version: number): Promise<void> {
    detailLoading = true;
    detailFailure = null;
    const prev = versions ? previousVersionOf(versions.data, version) : null;
    const [d, p] = await Promise.all([
      getBriefVersion(projectId, version),
      prev === null ? Promise.resolve(null) : getBriefVersion(projectId, prev),
    ]);
    detailLoading = false;
    if (!d.ok) {
      detail = null;
      previous = null;
      detailFailure = d;
      return;
    }
    detail = d.data;
    if (p && !p.ok) {
      previous = null;
      detailFailure = p;
    } else {
      previous = p ? p.data : null;
    }
  }

  function viewVersion(version: number): void {
    selected = String(version);
    void showVersion(version);
  }

  function onPick(e: Event): void {
    const value = (e.currentTarget as HTMLSelectElement).value;
    selected = value;
    if (value !== '') void showVersion(Number(value));
  }

  $effect(() => {
    const id = projectId;
    if (!id) return;
    void load();
  });
</script>

{#snippet fieldValue(value: unknown)}
  {#if isEmptyValue(value)}
    <span class="text-[var(--color-text-muted)]">{EMPTY}</span>
  {:else if Array.isArray(value)}
    <ul class="list-disc pl-5">
      {#each value as item, i (i)}
        <li class="break-words">{itemText(item)}</li>
      {/each}
    </ul>
  {:else}
    <span class="whitespace-pre-wrap break-words">{itemText(value)}</span>
  {/if}
{/snippet}


<section class="flex flex-col gap-4" data-testid="plan-brief">
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the brief…</p>
  {:else if loadFailure}
    <div
      role="alert"
      data-testid="brief-unavailable"
      class="rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-danger-text)]"
    >
      {#if loadFailure.unavailable}
        <p class="font-medium">The brief is unavailable</p>
        <p class="mt-1">
          The brief is stored in requirements management, which could not be reached{loadFailure.status
            ? ` (HTTP ${loadFailure.status})`
            : ''}. Nothing is shown rather than a stale or empty brief.
        </p>
      {:else}
        <p class="font-medium">The brief could not be read{loadFailure.status ? ` (HTTP ${loadFailure.status})` : ''}</p>
      {/if}
      <p class="mt-1 break-words">{loadFailure.message}</p>
      <div class="mt-2"><Button size="sm" variant="secondary" onclick={() => void load()}>Retry</Button></div>
    </div>
  {:else}
    {#if versions && versions.data.length > 0}
      <div class="flex flex-wrap items-center gap-3" data-testid="brief-version-bar">
        <label class="flex items-center gap-2 text-sm">
          Version
          <Select bind:value={selected} options={versionOptions} onchange={onPick} />
        </label>
        {#if viewed !== null}
          <Pill tone={isNewest ? 'accent' : 'neutral'}>
            <span data-testid="brief-viewing">{viewingBadge(viewed, versions.current_version, versions.total)}</span>
          </Pill>
        {/if}
        {#if viewedSummary}
          <span class="text-sm text-[var(--color-text-muted)]" data-testid="brief-author">
            by <span class="font-medium text-[var(--color-text)]">{viewedSummary.author_kind}</span>
          </span>
        {/if}
      </div>
      {#if viewedSummary?.note}
        <p class="text-sm" data-testid="brief-note">
          <span class="text-[var(--color-text-muted)]">Note:</span>
          {viewedSummary.note}
        </p>
      {/if}
    {:else}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="brief-no-versions">
        No brief version is recorded in requirements management yet.
      </p>
    {/if}

    {#if detailFailure}
      <div
        role="alert"
        data-testid="brief-version-failure"
        class="rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-danger-text)]"
      >
        <p class="font-medium">This version could not be read{detailFailure.status ? ` (HTTP ${detailFailure.status})` : ''}</p>
        <p class="mt-1 break-words">{detailFailure.message}</p>
      </div>
    {/if}

    {#if detailLoading}
      <p class="text-sm text-[var(--color-text-muted)]">Loading version…</p>
    {/if}

    {#if detail && viewed !== null}
      <section
        class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        data-testid="brief-diff"
      >
        <h2 class="text-sm font-semibold">
          {prevVersion === null ? `Changes in v${viewed} (first version)` : `Changes from v${prevVersion} to v${viewed}`}
        </h2>
        {#if diff.length === 0}
          <p class="mt-2 text-sm text-[var(--color-text-muted)]">No field changed.</p>
        {:else}
          <ul class="mt-2 flex flex-col gap-3 text-sm">
            {#each diff as d (d.key)}
              <li data-testid="brief-diff-field">
                <p class="font-medium">{d.label}</p>
                {#if d.kind === 'text'}
                  <p class="mt-1 break-words">
                    <span class="text-[var(--color-danger-text)] line-through">{d.before ?? EMPTY}</span>
                    →
                    <span class="text-[var(--color-success-text)]">{d.after ?? EMPTY}</span>
                  </p>
                {:else if d.kind === 'lines'}
                  {#if d.kept > 0}
                    <p class="mt-1 text-[var(--color-text-muted)]" data-testid="brief-diff-kept">
                      {d.kept} unchanged {d.kept === 1 ? 'line' : 'lines'}
                    </p>
                  {/if}
                  <div class="mt-1 flex flex-col gap-0.5" data-testid="brief-diff-lines">
                    {#each d.removed as line, i (i)}
                      <p class="whitespace-pre-wrap break-words text-[var(--color-danger-text)] line-through">− {line}</p>
                    {/each}
                    {#each d.added as line, i (i)}
                      <p class="whitespace-pre-wrap break-words text-[var(--color-success-text)]">+ {line}</p>
                    {/each}
                  </div>
                {:else}
                  <ul class="mt-1 flex flex-col gap-0.5">
                    {#each d.added as item, i (i)}
                      <li class="break-words text-[var(--color-success-text)]">+ {itemText(item)}</li>
                    {/each}
                    {#each d.removed as item, i (i)}
                      <li class="break-words text-[var(--color-danger-text)] line-through">− {itemText(item)}</li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if shown}
      <section
        class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        data-testid="brief-fields"
      >
        <h2 class="text-sm font-semibold">{viewed !== null ? `Brief at v${viewed}` : 'Current brief'}</h2>
        <dl class="mt-2 grid grid-cols-1 gap-2 text-sm md:grid-cols-[12rem_1fr]">
          {#each BRIEF_FIELDS as f (f.key)}
            <dt class="text-[var(--color-text-muted)]">{f.label}</dt>
            <dd class="min-w-0">
              {@render fieldValue(shown[f.key])}
              {#if f.key === 'notes' && typeof shown.notes === 'string' && !isEmptyValue(shown.notes)}
                <p class="mt-1 text-xs text-[var(--color-text-muted)]" data-testid="brief-notes-length">
                  {shown.notes.length.toLocaleString('en-US')} / {NOTES_MAX_CHARS.toLocaleString('en-US')} characters
                </p>
              {/if}
            </dd>
          {/each}
        </dl>
      </section>
    {/if}

    {#if versions && versions.data.length > 0}
      <BriefVersionHistory
        versions={versions.data}
        current={newest}
        viewing={viewed}
        onOpen={viewVersion}
      />
    {/if}

    <p class="text-sm text-[var(--color-text-muted)]" data-testid="brief-read-only">
      The brief is read-only: version 1 is the project request, and every later version comes from the conveyor.
    </p>
  {/if}
</section>
