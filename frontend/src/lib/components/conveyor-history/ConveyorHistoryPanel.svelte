<!--
  ConveyorHistoryPanel — what the conveyor did on this project: the conversation (asks and
  sign-offs with their answers), every card with its comment timeline, and the pull requests
  delivered. On the cockpit it renders the read model's `conveyor_history` panel (no call of its
  own); elsewhere it reads GET /api/projects/:id/conveyor-history. Each part degrades on its own,
  and a failed read is said as such, never shown as "nothing happened". Not a conveyor project ⇒
  nothing is rendered.
-->
<script lang="ts">
  import { fetchProjectConveyorHistory } from '$lib/api/conveyor-history';
  import type { CockpitConveyorHistory } from '$lib/types/cockpit';
  import { hasData, type Panel } from '$lib/types/panel';
  import { panelFromLegacyBlock } from './legacy-block';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import ConveyorConversation from './ConveyorConversation.svelte';
  import ConveyorCards from './ConveyorCards.svelte';
  import DeliveredPullRequests from './DeliveredPullRequests.svelte';

  let {
    projectId,
    /** The cockpit's panel; when given, nothing is fetched. */
    history = undefined,
  }: {
    projectId: string;
    history?: Panel<CockpitConveyorHistory>;
  } = $props();

  type View =
    | { kind: 'reading' }
    | { kind: 'failed'; panel: Panel<unknown> | null }
    | { kind: 'not_applicable' }
    | { kind: 'read'; parts: CockpitConveyorHistory };
  let view = $state<View>({ kind: 'reading' });
  let tick = $state(0);

  $effect(() => {
    if (history) {
      view = hasData(history)
        ? { kind: 'read', parts: history.data }
        : history.health === 'ok'
          ? { kind: 'not_applicable' }
          : { kind: 'failed', panel: history };
      return;
    }
    const id = projectId;
    void tick;
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const h = await fetchProjectConveyorHistory(id);
        if (cancelled) return;
        view = h.applicable
          ? {
              kind: 'read',
              parts: {
                conversation: panelFromLegacyBlock(h.conversation),
                cards: panelFromLegacyBlock(h.cards),
                delivered: panelFromLegacyBlock(h.delivered),
              },
            }
          : { kind: 'not_applicable' };
      } catch {
        if (!cancelled) view = { kind: 'failed', panel: null };
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

{#if view.kind !== 'not_applicable'}
<div class="flex flex-col gap-3" data-testid="conveyor-history">
  {#if view.kind === 'reading'}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="conveyor-history-reading">Reading what the conveyor did…</p>
  {:else if view.kind === 'failed'}
    <div class="rounded border border-dashed border-[var(--color-border)] p-3 text-xs" data-testid="conveyor-history-failed">
      {#if view.panel}
        <PanelNote panel={view.panel} title="What the conveyor did" />
      {:else}
        <p class="text-[var(--color-warning-text)]">
          What the conveyor did couldn't be loaded. Nothing is shown rather than an empty history.
        </p>
        <button type="button" class="mt-1 underline" onclick={() => (tick += 1)}>Retry</button>
      {/if}
    </div>
  {:else}
    <DeliveredPullRequests block={view.parts.delivered} />
    <ConveyorConversation {projectId} block={view.parts.conversation} />
    <ConveyorCards block={view.parts.cards} />
  {/if}
</div>
{/if}
