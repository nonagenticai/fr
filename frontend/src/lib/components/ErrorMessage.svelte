<script lang="ts">
	/**
	 * ErrorMessage - Reusable error message component
	 *
	 * Props:
	 * - title: Error title (default: "Error")
	 * - message: Error message to display (required)
	 * - dismissible: Whether the error can be dismissed (default: true)
	 * - onDismiss: Callback when error is dismissed
	 * - onRetry: Optional retry callback - shows retry button if provided
	 * - type: Error severity type (default: "error")
	 */

	let {
		title = "Error",
		message,
		dismissible = true,
		onDismiss,
		onRetry,
		type = "error"
	}: {
		title?: string;
		message: string;
		dismissible?: boolean;
		onDismiss?: () => void;
		onRetry?: () => void;
		type?: "error" | "warning" | "info";
	} = $props();

	const tone = $derived(
		type === "warning" ? "var(--color-warning)" : type === "info" ? "var(--color-accent)" : "var(--color-danger)",
	);
</script>

<div
	class="border rounded-lg p-4 bg-[var(--color-surface)]"
	style="border-color: {tone};"
>
	<div class="flex items-start">
		<!-- Icon -->
		<div class="flex-shrink-0" style="color: {tone};">
			{#if type === "error"}
				<svg class="w-5 h-5 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
					<path
						fill-rule="evenodd"
						d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
						clip-rule="evenodd"
					/>
				</svg>
			{:else if type === "warning"}
				<svg class="w-5 h-5 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
					<path
						fill-rule="evenodd"
						d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
						clip-rule="evenodd"
					/>
				</svg>
			{:else}
				<svg class="w-5 h-5 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
					<path
						fill-rule="evenodd"
						d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
						clip-rule="evenodd"
					/>
				</svg>
			{/if}
		</div>

		<!-- Content -->
		<div class="flex-1 ml-3">
			<h3 class="text-sm font-medium" style="color: {tone};">{title}</h3>
			<p class="mt-1 text-sm text-[var(--color-text)]">{message}</p>

			<!-- Action Buttons -->
			{#if onRetry}
				<div class="mt-3">
					<button
						onclick={onRetry}
						class="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md bg-[var(--color-bg)] border transition-colors hover:bg-[var(--color-surface-strong)]"
						style="color: {tone}; border-color: {tone};"
					>
						<svg class="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
							/>
						</svg>
						Retry
					</button>
				</div>
			{/if}
		</div>

		<!-- Dismiss Button -->
		{#if dismissible && onDismiss}
			<button
				onclick={onDismiss}
				class="flex-shrink-0 ml-3"
				style="color: {tone};"
				aria-label="Dismiss"
			>
				<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
					<path
						fill-rule="evenodd"
						d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
						clip-rule="evenodd"
					/>
				</svg>
			</button>
		{/if}
	</div>
</div>
