<script lang="ts">
	/**
	 * ProjectCardSkeleton - Reusable loading skeleton for project/workflow cards
	 *
	 * Props:
	 * - count: number of skeleton cards to render (default: 1)
	 * - cols: grid column configuration (default: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3")
	 */

	let {
		count = 1,
		cols = "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
	}: {
		count?: number;
		cols?: string;
	} = $props();
</script>

<div class="grid {cols} gap-6">
	{#each Array(count) as _, i}
		<div class="bg-[var(--color-surface)] rounded-lg shadow p-6 animate-pulse">
			<!-- Icon and Status Badge -->
			<div class="flex items-start justify-between mb-4">
				<div class="w-8 h-8 bg-[var(--color-surface-strong)] rounded"></div>
				<div class="w-16 h-6 bg-[var(--color-surface-strong)] rounded-full"></div>
			</div>

			<!-- Title -->
			<div class="h-6 bg-[var(--color-surface-strong)] rounded mb-2 w-3/4"></div>

			<!-- Description lines -->
			<div class="h-4 bg-[var(--color-surface-strong)] rounded mb-2 w-full"></div>
			<div class="h-4 bg-[var(--color-surface-strong)] rounded mb-4 w-2/3"></div>

			<!-- Footer metadata -->
			<div class="flex items-center justify-between">
				<div class="h-3 bg-[var(--color-surface-strong)] rounded w-16"></div>
				<div class="h-3 bg-[var(--color-surface-strong)] rounded w-24"></div>
			</div>
		</div>
	{/each}
</div>
