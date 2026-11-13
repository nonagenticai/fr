<script lang="ts">
	import { toast, type Toast } from '$lib/stores/toast.svelte';

	let toasts = $derived(toast.items);

	function getToastStyles(type: Toast['type']) {
		const baseStyles = 'px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 min-w-[300px] max-w-md';
		const typeStyles = {
			success: 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] border border-[var(--color-success-border)]',
			error: 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border border-[var(--color-danger-border)]',
			warning: 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border border-[var(--color-warning-border)]',
			info: 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border border-[var(--color-accent-border)]'
		};
		return `${baseStyles} ${typeStyles[type]}`;
	}

	function getIcon(type: Toast['type']) {
		switch (type) {
			case 'success':
				return '✓';
			case 'error':
				return '✗';
			case 'warning':
				return '⚠';
			case 'info':
				return 'ℹ';
		}
	}
</script>

<!-- Toast Container -->
<div class="fixed top-4 right-4 z-50 flex flex-col gap-2">
	{#each toasts as item (item.id)}
		<div class={getToastStyles(item.type)} role="alert">
			<span class="text-xl font-bold">{getIcon(item.type)}</span>
			<p class="flex-1">{item.message}</p>
			<button
				onclick={() => toast.dismiss(item.id)}
				class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] font-bold text-lg"
				aria-label="Close"
			>
				×
			</button>
		</div>
	{/each}
</div>
