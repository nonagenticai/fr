<script lang="ts">
	import type { CardDetail } from '../types';

	interface Props {
		kag_seeker: CardDetail['kag_seeker'];
	}
	let { kag_seeker }: Props = $props();
</script>

<div class="space-y-3">
	<!-- Seeker (READYING phase pull) -->
	<div>
		<h4 class="text-xs uppercase text-[var(--color-text-muted)] mb-1">
			Seeker · pulled at READYING
		</h4>
		{#if kag_seeker === null}
			<p class="text-sm text-[var(--color-text-muted)] italic">
				Seeker links could not be read — unknown, not empty.
			</p>
		{:else if kag_seeker.length === 0}
			<p class="text-sm text-[var(--color-text-muted)] italic">
				No seeker pulls recorded.
			</p>
		{:else}
			<ul class="space-y-1 text-sm">
				{#each kag_seeker ?? [] as item, idx (idx)}
					<li class="font-mono text-xs text-[var(--color-text)]">
						{JSON.stringify(item)}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
