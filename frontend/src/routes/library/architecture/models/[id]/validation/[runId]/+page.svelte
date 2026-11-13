<!--
  /library/architecture/models/[id]/validation/[runId] — one rule check as
  requirements_management stored it: what was checked (draft or a saved
  version), its verdict with a plain-language explanation, counts by severity,
  and the findings (filter by severity and rule).
-->
<script lang="ts">
  import { page } from '$app/state';
  import FindingsTable from '$lib/components/modeling/FindingsTable.svelte';
  import RunVerdict from '$lib/components/modeling/RunVerdict.svelte';
  import { ModelingError, getModel, getRevision, getValidationRun, type ArchitectureModel, type ModelRevision, type ValidationRun } from '$lib/api/modeling';
  import { versionName, when } from '$lib/modeling/explain';
  import { personLabel } from '$lib/modeling/people';

  const modelId = $derived(decodeURIComponent(page.params.id ?? ''));
  const runId = $derived(decodeURIComponent(page.params.runId ?? ''));
  const modelHref = $derived(`/library/architecture/models/${encodeURIComponent(modelId)}`);

  let model = $state<ArchitectureModel | null>(null);
  let run = $state<ValidationRun | null>(null);
  let revision = $state<ModelRevision | null>(null);
  let error = $state<string | null>(null);
  let notFound = $state(false);

  async function load(): Promise<void> {
    error = null;
    notFound = false;
    try {
      [model, run] = await Promise.all([getModel(modelId), getValidationRun(runId)]);
      // A deleted version only loses its name here; any other failure is the page's error.
      revision = run.revision_id
        ? await getRevision(modelId, run.revision_id).catch((e) => {
            if (e instanceof ModelingError && e.status === 404) return null;
            throw e;
          })
        : null;
    } catch (e) {
      if (e instanceof ModelingError && e.status === 404) notFound = true;
      else error = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void runId;
    load();
  });

  const target = $derived(
    !run ? '' : run.target === 'draft_head' ? 'the draft as it was then' : revision ? versionName(revision) : 'a saved version',
  );
</script>

<div class="flex flex-col gap-4 px-6 py-4" data-testid="run-page">
  <a href={modelHref} class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">← {model?.title ?? 'Model'}</a>
  {#if notFound}
    <p class="text-sm text-[var(--color-text)]" data-testid="run-not-found">This rule check does not exist, or you do not have access to it. <a class="text-[var(--color-link)] underline" href={modelHref}>Back to the model</a></p>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2" data-testid="run-error">
      <p class="text-sm text-[var(--color-danger)]">This rule check could not be loaded: {error}</p>
      <button type="button" class="text-sm font-medium text-[var(--color-link)] underline" onclick={load}>Try again</button>
    </div>
  {:else if !run}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the rule check…</p>
  {:else}
    <header class="flex flex-col gap-2">
      <h1 class="text-2xl font-semibold text-[var(--color-text)]">Rule check</h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Checked {target}, {when(run.finished_at ?? run.started_at)}, requested by {personLabel(run.requested_by)}.
        {#if revision}<a class="text-[var(--color-link)] underline" href={`${modelHref}/versions/${encodeURIComponent(revision.revision_id)}`}>Open the version</a>{/if}
      </p>
      <RunVerdict {run} />
      <p class="text-xs text-[var(--color-text-muted)]">Rules: {run.ruleset_id} ({run.enabled_rules.length} switched on).</p>
    </header>
    <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <FindingsTable runId={run.run_id} rulesetId={run.ruleset_id} counts={run.counts} />
    </section>
  {/if}
</div>
