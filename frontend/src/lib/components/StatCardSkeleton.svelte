<script lang="ts">
	/**
	 * StatCardSkeleton - Reusable loading skeleton for dashboard stat cards
	 *
	 * Props:
	 * - count: number of skeleton cards to render (default: 3)
	 * - cols: grid column configuration (default: "grid-cols-1 md:grid-cols-3")
	 */

	let {
		count = 3,
		cols = "grid-cols-1 md:grid-cols-3"
	}: {
		count?: number;
		cols?: string;
	} = $props();
</script>

<div class="grid {cols} gap-6">
	{#each Array(count) as _, i}
		<div class="bg-[var(--color-surface)] rounded-lg shadow p-6 animate-pulse">
			<!-- Header with title and icon -->
			<div class="flex items-center justify-between mb-4">
				<div class="h-5 bg-[var(--color-surface-strong)] rounded w-24 dark:bg-[var(--color-surface-strong)]"></div>
				<div class="w-8 h-8 bg-[var(--color-surface-strong)] rounded dark:bg-[var(--color-surface-strong)]"></div>
			</div>

			<!-- Main stat value -->
			<div class="h-8 bg-[var(--color-surface-strong)] rounded mb-3 w-32 dark:bg-[var(--color-surface-strong)]"></div>

			<!-- Secondary information -->
			<div class="space-y-2">
				<div class="flex justify-between">
					<div class="h-3 bg-[var(--color-surface-strong)] rounded w-16 dark:bg-[var(--color-surface-strong)]"></div>
					<div class="h-3 bg-[var(--color-surface-strong)] rounded w-20 dark:bg-[var(--color-surface-strong)]"></div>
				</div>
				<div class="flex justify-between">
					<div class="h-3 bg-[var(--color-surface-strong)] rounded w-20 dark:bg-[var(--color-surface-strong)]"></div>
					<div class="h-3 bg-[var(--color-surface-strong)] rounded w-16 dark:bg-[var(--color-surface-strong)]"></div>
				</div>
			</div>
		</div>
	{/each}
</div>
