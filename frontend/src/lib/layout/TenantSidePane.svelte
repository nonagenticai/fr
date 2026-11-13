<!--
  TenantSidePane — the right rail on a TENANT page that is not a doorway page
  (fr-agui SPEC §13 P1c, OQ-17 = (c)).

  It replaces AgentRail there. The [Detail] tab keeps the ContextualPane (an
  "open in pane" affordance is a UI feature, not the agent, and must keep
  working); the [Agent] tab no longer mounts a chat — it shows
  AgentProjectGate ("Open a project to use the agent" + a project picker).
-->
<script lang="ts">
	import X from 'lucide-svelte/icons/x';
	import { agentRail } from '$lib/stores/agentRail.svelte';
	import ContextualPane from './ContextualPane.svelte';
	import AgentProjectGate from './AgentProjectGate.svelte';

	function onKeydown(e: KeyboardEvent): void {
		if (e.defaultPrevented) return;
		if (e.key === 'Escape' && agentRail.isOpen) agentRail.close();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if agentRail.isOpen}
	<aside
		class="flex h-full w-[380px] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)]"
		aria-label="Side pane"
		data-testid="tenant-side-pane"
	>
		<header class="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
			<div class="flex items-center gap-1">
				<button
					type="button"
					class="rounded px-2 py-1 text-xs"
					class:bg-[var(--color-surface-strong)]={agentRail.tab === 'agent'}
					onclick={() => agentRail.switchTab('agent')}
				>
					Agent
				</button>
				<button
					type="button"
					class="rounded px-2 py-1 text-xs"
					class:bg-[var(--color-surface-strong)]={agentRail.tab === 'detail'}
					onclick={() => agentRail.switchTab('detail')}
				>
					Detail
				</button>
			</div>
			<button
				type="button"
				class="ml-auto flex items-center justify-center rounded p-1 hover:bg-[var(--color-surface-strong)]"
				onclick={() => agentRail.close()}
				aria-label="Close side pane"
			>
				<X size={16} />
			</button>
		</header>
		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if agentRail.tab === 'agent'}
				<AgentProjectGate />
			{:else}
				<ContextualPane />
			{/if}
		</div>
	</aside>
{/if}
