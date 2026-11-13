<!--
  ModelExports — the downloads of a model's current draft, or (`revisionId`) of
  a saved version: every view / diagram in one PDF, the same as SVG files in
  one zip, and the model in its language's standard exchange format (the Open
  Group exchange file for ArchiMate, with what could not be written to it; XMI
  for UML). Every file is requirements_management's, relayed by fr unchanged.
-->
<script lang="ts">
  import {
    MODEL_DOWNLOAD_SUFFIX,
    downloadModel,
    exchangeFormatOf,
    exportModel,
    fileNameOf,
    saveFile,
    type ExchangeLoss,
    type ModelDownload,
  } from '$lib/api/modeling';
  import { lossText } from '$lib/modeling/explain';

  let {
    modelId,
    revisionId,
    language,
    fileTitle,
  }: { modelId: string; revisionId?: string; language: string | null | undefined; fileTitle: string } = $props();

  const exchange = $derived(exchangeFormatOf(language));
  const pages = $derived(language === 'uml' ? 'diagrams' : 'views');

  let busy = $state<ModelDownload | 'exchange' | null>(null);
  let error = $state<string | null>(null);
  let losses = $state<ExchangeLoss[] | null>(null);

  async function run(what: ModelDownload | 'exchange', work: () => Promise<void>): Promise<void> {
    busy = what;
    error = null;
    losses = null;
    try {
      await work();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = null;
    }
  }

  const download = (what: ModelDownload) =>
    run(what, async () => saveFile(await downloadModel(modelId, what, revisionId), fileNameOf(fileTitle, MODEL_DOWNLOAD_SUFFIX[what])));

  const exportExchange = () =>
    exchange === 'xmi'
      ? download('xmi')
      : run('exchange', async () => {
          const out = await exportModel(modelId, revisionId);
          saveFile(out.xml, fileNameOf(fileTitle, '.xml'));
          losses = out.losses;
        });

  const button =
    'rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50';
</script>

<div class="flex flex-wrap gap-2">
  <button type="button" class={button} onclick={() => download('pdf')} disabled={busy !== null} data-testid="model-export-pdf">
    {busy === 'pdf' ? 'Preparing…' : `Export PDF (all ${pages})`}
  </button>
  <button type="button" class={button} onclick={() => download('svg')} disabled={busy !== null} data-testid="model-export-svg">
    {busy === 'svg' ? 'Preparing…' : 'Export SVG (zip)'}
  </button>
  <button type="button" class={button} onclick={exportExchange} disabled={busy !== null} data-testid="model-export-exchange">
    {busy === 'exchange' || busy === 'xmi' ? 'Preparing…' : exchange === 'xmi' ? 'Export XMI' : 'Export Open Group XML'}
  </button>
</div>
{#if error}<p class="text-sm text-[var(--color-danger)]" data-testid="model-export-error">{error}</p>{/if}
{#if losses && losses.length > 0}
  <div class="rounded-md border border-[var(--color-info-border)] bg-[var(--color-info-bg)] p-3" data-testid="model-export-losses">
    <p class="text-sm font-medium text-[var(--color-info-text)]">Downloaded. Some details could not be written to the file:</p>
    <ul class="mt-1 list-disc pl-5 text-sm text-[var(--color-info-text)]">{#each losses as l, i (i)}<li>{lossText(l)}</li>{/each}</ul>
  </div>
{:else if losses}
  <p class="text-sm text-[var(--color-text-muted)]" data-testid="model-export-done">Downloaded. Everything was written to the file.</p>
{/if}
