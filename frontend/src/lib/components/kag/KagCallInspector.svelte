<!--
  KAG "Copy as API / n8n" inspector (P3-D4) — a disclosure on an Ask/Search result
  that shows the exact gateway call fr made (method + path + body), a one-click
  copy-as-curl, and the equivalent KAG n8n node operation when one genuinely
  exists. RAG "ask" has no single node operation (the node exposes retrieval, not
  answer-composition), so we say so honestly instead of mislabeling it.
-->
<script lang="ts">
  import {
    toCurl,
    prettyBody,
    n8nEquivalent,
    type GatewayCall,
  } from '$lib/components/kag/kagInspect';

  interface Props {
    call: GatewayCall;
  }
  const { call }: Props = $props();

  const curl = $derived(toCurl(call));
  const body = $derived(prettyBody(call.body));
  const n8n = $derived(n8nEquivalent(call));

  let copied = $state(false);
  async function copyCurl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(curl);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard blocked (no user gesture / permissions) — leave the text
      // visible for manual copy rather than surfacing a scary error.
      copied = false;
    }
  }
</script>

<details class="mt-3 text-xs" data-testid="kag-inspector">
  <summary class="cursor-pointer text-[var(--color-text-muted)] hover:underline"
    >Copy as API / n8n</summary
  >
  <div class="mt-2 flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <span
        class="rounded bg-[var(--color-surface-strong)] px-1.5 py-0.5 font-mono text-[10px] uppercase"
        data-testid="kag-inspector-method">{call.method}</span
      >
      <code class="font-mono text-[var(--color-text)]" data-testid="kag-inspector-path"
        >{call.path}</code
      >
    </div>

    <div class="flex items-center justify-between">
      <span class="text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">curl</span>
      <button
        type="button"
        data-testid="kag-inspector-copy"
        onclick={() => void copyCurl()}
        class="rounded border px-2 py-0.5 text-[10px] hover:border-[var(--color-accent)]"
        >{copied ? 'Copied ✓' : 'Copy'}</button
      >
    </div>
    <pre
      class="overflow-x-auto rounded bg-[var(--color-bg)] p-2 font-mono text-[10px] text-[var(--color-text)] dark:bg-[var(--color-surface)]"
      data-testid="kag-inspector-curl">{curl}</pre>

    {#if body}
      <span class="text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">body</span>
      <pre
        class="overflow-x-auto rounded bg-[var(--color-bg)] p-2 font-mono text-[10px] text-[var(--color-text)] dark:bg-[var(--color-surface)]"
        data-testid="kag-inspector-body">{body}</pre>
    {/if}

    <div data-testid="kag-inspector-n8n">
      <span class="text-[10px] font-semibold uppercase text-[var(--color-text-muted)]"
        >n8n equivalent</span
      >
      {#if n8n}
        <p class="text-[var(--color-text)]">
          <code class="font-mono">{n8n.node}</code> — resource
          <code class="font-mono">{n8n.resource}</code>, operation
          <code class="font-mono" data-testid="kag-inspector-n8n-op">{n8n.operation}</code>
        </p>
      {:else}
        <p class="text-[var(--color-text-muted)]" data-testid="kag-inspector-n8n-none">
          No single KAG node operation composes a RAG answer — use the gateway call
          directly, or Semantic Search / Hierarchical Retrieval for the retrieval step.
        </p>
      {/if}
    </div>
  </div>
</details>
