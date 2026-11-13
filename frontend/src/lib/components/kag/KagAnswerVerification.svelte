<!--
  KAG "Verify this answer" (P3-D3) — a lazy, on-click groundedness check for a
  RAG answer. Runs RAGAS (faithfulness / answer-relevancy / factual-accuracy /
  context-precision) over the question + the composed answer + the exact retrieved
  passages it was grounded in (`/api/research/scientific/verify/ragas`, already
  wired). Read-only. Honest disabled state when there's nothing to verify (no
  answer, or no retrieved contexts — RAGAS requires at least one context).

  Not integrity: `verify/integrity` scores a graph ENTITY by id, which an Ask
  answer does not have — RAGAS is the correct "is this answer grounded" check.
-->
<script lang="ts">
  import { researchApi, type RagasResponse } from '$lib/api/research';
  import { AssetError } from '$lib/api/assets';

  interface Props {
    question: string;
    answer: string;
    contexts: string[];
  }
  const { question, answer, contexts }: Props = $props();

  let running = $state(false);
  let error = $state('');
  let scores = $state<RagasResponse | null>(null);

  const canVerify = $derived(
    question.trim().length > 0 && answer.trim().length > 0 && contexts.length > 0,
  );
  // Why the button is unavailable, if it is — so it's never a dead control.
  const disabledReason = $derived.by<string>(() => {
    if (answer.trim().length === 0) return 'No composed answer to verify.';
    if (contexts.length === 0)
      return 'No retrieved passages to check the answer against.';
    return '';
  });

  // Faithfulness is the headline "groundedness": is the answer supported by the
  // retrieved passages? The rest are shown as supporting metrics.
  const METRICS: Array<{ key: keyof RagasResponse; label: string }> = [
    { key: 'faithfulness', label: 'Faithfulness' },
    { key: 'answer_relevancy', label: 'Answer relevance' },
    { key: 'factual_accuracy', label: 'Factual accuracy' },
    { key: 'context_precision', label: 'Context precision' },
  ];

  function pct(v: unknown): string {
    return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—';
  }

  async function verify(): Promise<void> {
    if (!canVerify) return;
    running = true;
    error = '';
    scores = null;
    try {
      scores = await researchApi.verifyRagas({
        question: question.trim(),
        answer: answer.trim(),
        contexts,
      });
    } catch (e) {
      error = e instanceof AssetError ? e.message : e instanceof Error ? e.message : String(e);
    } finally {
      running = false;
    }
  }
</script>

<div class="mt-3 border-t border-[var(--color-border)] pt-3" data-testid="kag-verify">
  <div class="flex flex-wrap items-center gap-2">
    <button
      type="button"
      data-testid="kag-verify-btn"
      disabled={!canVerify || running}
      onclick={() => void verify()}
      title={disabledReason}
      class="rounded border border-[var(--color-border-strong)] px-3 py-1.5 text-sm text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {running ? 'Verifying…' : 'Verify this answer'}
    </button>
    {#if !canVerify && disabledReason}
      <span class="text-xs text-[var(--color-text-muted)]" data-testid="kag-verify-disabled-reason"
        >{disabledReason}</span
      >
    {:else if scores}
      <span class="text-xs text-[var(--color-text-muted)]"
        >Grounded against {contexts.length} passage{contexts.length === 1 ? '' : 's'}</span
      >
    {/if}
  </div>

  {#if error}
    <p class="mt-2 text-sm text-[var(--color-danger)]" data-testid="kag-verify-error">{error}</p>
  {:else if scores}
    <div class="mt-3 flex flex-wrap gap-3" data-testid="kag-verify-scores">
      {#each METRICS as m (m.key)}
        {#if typeof scores[m.key] === 'number'}
          <div
            class="rounded border border-[var(--color-border)] px-3 py-1.5"
            data-testid="kag-verify-metric-{m.key}"
          >
            <div class="text-[10px] uppercase text-[var(--color-text-muted)]">{m.label}</div>
            <div class="text-lg font-semibold">{pct(scores[m.key])}</div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
