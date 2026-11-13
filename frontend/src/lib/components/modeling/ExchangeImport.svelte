<!--
  ExchangeImport — import an ArchiMate exchange file (.xml, the Open Group
  Model Exchange File Format) into a model (`modelId`), or as a NEW model
  (no `modelId`; `projectId` scopes it).

  Nothing changes on upload: requirements_management stages the file as a set of
  proposed changes. This component then shows what the file would change, what
  the format could not carry, and the problems RM found — with Apply / Reject
  (ChangeSetPanel). If the model moved on before Apply, "Import again" re-sends
  the same file (kept in memory) to prepare an up-to-date set.
-->
<script lang="ts">
  import { importExchange, newIntentKey, type ChangeSet, type ExchangeImport } from '$lib/api/modeling';
  import { importOutcome } from '$lib/modeling/explain';
  import ChangeSetPanel from './ChangeSetPanel.svelte';

  let {
    modelId,
    projectId,
    onImported,
    onChange,
  }: {
    modelId?: string;
    projectId?: string;
    /** After a successful import (a new model: its id is `result.model_id`). */
    onImported?: (result: ExchangeImport) => void;
    /** After the staged changes were applied or rejected. */
    onChange?: (cs: ChangeSet) => void;
  } = $props();

  let file = $state<File | null>(null);
  let xml = $state<string | null>(null);
  let importing = $state(false);
  let error = $state<string | null>(null);
  let result = $state<ExchangeImport | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  // One key per file the user chose (a retry of the same import reuses it); "Import again" is a new import.
  let intentKey = newIntentKey();

  async function choose(e: Event): Promise<void> {
    error = null;
    result = null;
    xml = null;
    const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
    file = f;
    intentKey = newIntentKey();
    if (!f) return;
    try {
      xml = await f.text();
    } catch (err) {
      error = `The file could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // The headline follows the set's CURRENT status (applied / rejected after the panel's buttons), not the upload's.
  function changed(cs: ChangeSet): void {
    if (result) result = { ...result, change_set: cs };
    onChange?.(cs);
  }

  async function runImport(fresh = false): Promise<void> {
    if (!xml || !file) return;
    if (fresh) intentKey = newIntentKey();
    importing = true;
    error = null;
    try {
      result = await importExchange({ ...(modelId ? { modelId } : {}), xml, filename: file.name, ...(projectId ? { projectId } : {}), idempotencyKey: intentKey });
      onImported?.(result);
    } catch (e) {
      result = null;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      importing = false;
    }
  }

  function reset(): void {
    file = null;
    xml = null;
    result = null;
    error = null;
    if (input) input.value = '';
  }
</script>

<section class="flex flex-col gap-3" data-testid="exchange-import">
  {#if !result}
    <p class="text-sm text-[var(--color-text-muted)]">
      {modelId
        ? 'Bring in changes from an ArchiMate exchange file (.xml), for example exported from Archi. You will see what the file changes before anything is applied.'
        : 'Create a model from an ArchiMate exchange file (.xml), for example exported from Archi. You will see its contents before anything is added.'}
    </p>
    <div class="flex flex-wrap items-center gap-2">
      <input
        bind:this={input}
        type="file"
        accept=".xml,application/xml,text/xml"
        onchange={choose}
        class="text-sm text-[var(--color-text)]"
        aria-label="ArchiMate exchange file"
        data-testid="exchange-import-file"
      />
      <button
        type="button"
        class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] disabled:opacity-50"
        onclick={() => runImport()}
        disabled={!xml || importing}
        data-testid="exchange-import-submit"
      >
        {importing ? 'Reading the file…' : 'Import'}
      </button>
    </div>
  {/if}
  {#if error}
    <div class="flex flex-wrap items-center gap-2" data-testid="exchange-import-error">
      <p class="text-sm text-[var(--color-danger)]">{error}</p>
      {#if xml}
        <button type="button" class="text-sm font-medium text-[var(--color-link)] underline" onclick={() => runImport()}>Try again</button>
      {/if}
    </div>
  {/if}
  {#if result}
    <p class="text-sm text-[var(--color-text)]" data-testid="exchange-import-done">
      {result.model_created ? 'A new model was created from' : 'The changes in'} <strong>{file?.name ?? 'the file'}</strong>
      {importOutcome(result.model_created, result.change_set.status)}
      {#if !result.schema_valid}
        <span class="block text-xs text-[var(--color-warning-text)]">The file does not fully follow the exchange format, so some details may be missing.</span>
      {/if}
    </p>
    <ChangeSetPanel changeSet={result.change_set} losses={result.losses} onChange={changed} onReimport={() => runImport(true)} />
    <button type="button" class="self-start text-sm font-medium text-[var(--color-link)] underline" onclick={reset} data-testid="exchange-import-another">
      Import another file
    </button>
  {/if}
</section>
