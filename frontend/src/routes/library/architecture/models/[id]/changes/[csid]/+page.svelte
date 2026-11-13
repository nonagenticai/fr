<!--
  /library/architecture/models/[id]/changes/[csid] — one set of changes (for
  example an imported exchange file) as requirements_management stored it, with
  Apply / Reject while it is still open. If the model moved on since the set was
  prepared, the panel explains it and links back to the model to import again.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import ChangeSetPanel from '$lib/components/modeling/ChangeSetPanel.svelte';
  import { ModelingError, getChangeSet, getModel, type ArchitectureModel, type ChangeSet } from '$lib/api/modeling';
  import { when } from '$lib/modeling/explain';
  import { personLabel } from '$lib/modeling/people';

  const modelId = $derived(decodeURIComponent(page.params.id ?? ''));
  const csid = $derived(decodeURIComponent(page.params.csid ?? ''));
  const modelHref = $derived(`/library/architecture/models/${encodeURIComponent(modelId)}`);

  let model = $state<ArchitectureModel | null>(null);
  let cs = $state<ChangeSet | null>(null);
  let error = $state<string | null>(null);
  let notFound = $state(false);

  async function load(): Promise<void> {
    error = null;
    notFound = false;
    try {
      [model, cs] = await Promise.all([getModel(modelId), getChangeSet(csid)]);
    } catch (e) {
      if (e instanceof ModelingError && e.status === 404) notFound = true;
      else error = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void csid;
    load();
  });
</script>

<div class="flex flex-col gap-4 px-6 py-4" data-testid="change-set-page">
  <a href={modelHref} class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">← {model?.title ?? 'Model'}</a>
  {#if notFound}
    <p class="text-sm text-[var(--color-text)]" data-testid="change-set-not-found">These changes do not exist, or you do not have access to them. <a class="text-[var(--color-link)] underline" href={modelHref}>Back to the model</a></p>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2" data-testid="change-set-load-error">
      <p class="text-sm text-[var(--color-danger)]">These changes could not be loaded: {error}</p>
      <button type="button" class="text-sm font-medium text-[var(--color-link)] underline" onclick={load}>Try again</button>
    </div>
  {:else if !cs}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the changes…</p>
  {:else}
    <header>
      <h1 class="text-2xl font-semibold text-[var(--color-text)]">{cs.evaluator_ref === 'exchange-import' ? 'Imported changes' : 'Proposed changes'}</h1>
      <p class="mt-1 text-sm text-[var(--color-text-muted)]">Prepared {when(cs.created_at)} by {personLabel(cs.created_by)}.</p>
    </header>
    <ChangeSetPanel changeSet={cs} onChange={(next) => (cs = next)} onReimport={() => goto(`${modelHref}#imported-changes`)} />
  {/if}
</div>
