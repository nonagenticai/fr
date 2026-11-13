<script lang="ts">
  import { ASSET_EXPLAINERS, type AssetTypeKey } from './AssetTypeExplainers';
  import { agentRail } from '$lib/stores/agentRail.svelte';
  import { threads } from '$lib/stores/threads.svelte';

  let { type }: { type: AssetTypeKey } = $props();
  const e = $derived(ASSET_EXPLAINERS[type]);

  let asking = $state(false);

  async function askAgent(): Promise<void> {
    if (asking) return;
    // fr-agui §13 P1c (OQ-17 = c): outside a project there is no agent to ask —
    // open the side pane, which says "Open a project to use the agent" and offers
    // the project picker. Nothing is created or sent to the (doorway-only) agent.
    if (!agentRail.projectId) {
      agentRail.openAgentTab();
      return;
    }
    asking = true;
    try {
      const t = await threads.create({
        channel: 'web',
        projectId: agentRail.projectId,
      });
      agentRail.openThread(t.id);
      await threads.sendMessage(`${e.agentPrompt}…`);
    } finally {
      asking = false;
    }
  }
</script>

<div
  class="mx-auto max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-8 text-center"
  data-testid={`${type}-empty`}
>
  <!-- `e.what` is already rendered as the page header by routes/library/[type]/+page.svelte:405.
       Repeating it here produced a visible duplicate paragraph on empty pages. -->
  <p class="text-base font-medium text-[var(--color-text)]">Nothing here yet.</p>
  <p class="mt-2 text-sm text-[var(--color-text-muted)]">{e.how}</p>
  <div class="mt-5 flex items-center justify-center gap-2">
    {#if e.createHref}
      <a
        href={e.createHref}
        class="inline-flex items-center justify-center h-8 px-3 text-sm font-medium rounded-[var(--radius-sm)] bg-[var(--color-accent)] text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] transition"
        data-testid={`${type}-empty-add`}
      >
        {e.createLabel ?? `Create a ${type}`}
      </a>
    {/if}
    <button
      type="button"
      class="inline-flex items-center justify-center h-8 px-3 text-sm font-medium rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] text-[var(--color-text)] hover:bg-[var(--color-border)] disabled:opacity-50 transition"
      onclick={askAgent}
      disabled={asking}
      data-testid={`${type}-empty-ask-agent`}
    >
      Ask the agent
    </button>
  </div>
</div>
