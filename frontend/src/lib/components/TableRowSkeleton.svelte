<script lang="ts">
	/**
	 * TableRowSkeleton - Reusable loading skeleton for table rows
	 *
	 * Props:
	 * - rows: number of skeleton rows to render (default: 5)
	 * - columns: number of columns per row (default: 4)
	 * - showHeader: whether to show a header skeleton (default: false)
	 */

	let {
		rows = 5,
		columns = 4,
		showHeader = false
	}: {
		rows?: number;
		columns?: number;
		showHeader?: boolean;
	} = $props();

	// Generate varying widths for more realistic appearance
	function getRandomWidth(index: number): string {
		const widths = ['w-full', 'w-3/4', 'w-2/3', 'w-1/2', 'w-5/6'];
		return widths[index % widths.length];
	}
</script>

<div class="bg-[var(--color-surface)] rounded-lg shadow">
	<!-- Optional Header -->
	{#if showHeader}
		<div class="px-6 py-4 border-b border-[var(--color-border)] animate-pulse">
			<div class="h-6 bg-[var(--color-surface-strong)] rounded w-48"></div>
		</div>
	{/if}

	<!-- Table Rows -->
	<div class="divide-y divide-[var(--color-border)]">
		{#each Array(rows) as _, rowIndex}
			<div class="px-6 py-4 hover:bg-[var(--color-surface-muted)] transition-colors animate-pulse">
				<div class="flex items-center gap-4">
					<!-- Icon/Avatar -->
					<div class="w-10 h-10 bg-[var(--color-surface-strong)] rounded"></div>

					<!-- Content columns -->
					<div class="flex-1 grid grid-cols-{columns} gap-4">
						{#each Array(columns) as _, colIndex}
							<div>
								<div class="h-4 bg-[var(--color-surface-strong)] rounded mb-2 {getRandomWidth(colIndex)}"></div>
								{#if colIndex === 0}
									<div class="h-3 bg-[var(--color-surface-strong)] rounded w-2/3"></div>
								{/if}
							</div>
						{/each}
					</div>

					<!-- Action buttons -->
					<div class="flex gap-2 flex-shrink-0">
						<div class="w-16 h-8 bg-[var(--color-surface-strong)] rounded"></div>
						<div class="w-16 h-8 bg-[var(--color-surface-strong)] rounded"></div>
					</div>
				</div>
			</div>
		{/each}
	</div>
</div>
