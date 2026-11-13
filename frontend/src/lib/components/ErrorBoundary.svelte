<script lang="ts">
	import { onMount } from 'svelte';
	import { ApiError } from '$lib/api/unified-client';
	import ErrorMessage from './ErrorMessage.svelte';

	/**
	 * ErrorBoundary - Wrapper component to catch and handle errors gracefully
	 *
	 * Props:
	 * - fallback: Optional custom error fallback component
	 * - onError: Callback when error occurs
	 * - onRetry: Callback for retry action (required)
	 * - showReportOption: Whether to show "Report Error" button (default: true)
	 * - errorTitle: Custom error title
	 */

	let {
		children,
		fallback,
		onError,
		onRetry,
		showReportOption = true,
		errorTitle = "Something went wrong"
	}: {
		children?: any;
		fallback?: any;
		onError?: (error: Error) => void;
		onRetry: () => void | Promise<void>;
		showReportOption?: boolean;
		errorTitle?: string;
	} = $props();

	let error = $state<Error | null>(null);
	let errorDetails = $state<string>("");
	let isRetrying = $state(false);
	let showReportModal = $state(false);
	let reportSubmitted = $state(false);

	// Extract error details
	$effect(() => {
		if (error) {
			if (error instanceof ApiError) {
				errorDetails = `API Error (${error.status}): ${error.message}`;
			} else {
				errorDetails = error.message || "An unexpected error occurred";
			}

			// Call onError callback if provided
			if (onError) {
				onError(error);
			}
		}
	});

	// Handle retry
	async function handleRetry() {
		isRetrying = true;
		error = null;
		errorDetails = "";

		try {
			await onRetry();
		} catch (e) {
			// If retry fails, set the error again
			error = e as Error;
		} finally {
			isRetrying = false;
		}
	}

	// Handle error reporting
	function openReportModal() {
		showReportModal = true;
	}

	function closeReportModal() {
		showReportModal = false;
		reportSubmitted = false;
	}

	async function submitErrorReport(additionalInfo: string) {
		// In a real application, this would send the error to a logging service
		console.error("Error Report:", {
			error: error,
			details: errorDetails,
			additionalInfo: additionalInfo,
			timestamp: new Date().toISOString(),
			userAgent: navigator.userAgent,
			url: window.location.href
		});

		// Simulate API call
		await new Promise(resolve => setTimeout(resolve, 500));

		reportSubmitted = true;

		// Close modal after 2 seconds
		setTimeout(() => {
			closeReportModal();
		}, 2000);
	}

	// Error report form
	let reportMessage = $state("");
</script>

{#if error}
	{#if fallback}
		<!-- Custom fallback -->
		{@render fallback(error, handleRetry)}
	{:else}
		<!-- Default error UI -->
		<div class="space-y-4">
			<div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-6 dark:bg-[var(--color-danger-bg)]/20">
				<div class="flex items-start">
					<!-- Error Icon -->
					<div class="flex-shrink-0">
						<svg
							class="w-12 h-12 text-[var(--color-danger)]"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
							/>
						</svg>
					</div>

					<!-- Error Content -->
					<div class="ml-4 flex-1">
						<h3 class="text-lg font-semibold text-[var(--color-danger-text)]">{errorTitle}</h3>
						<p class="mt-2 text-sm text-[var(--color-danger-text)]">{errorDetails}</p>

						<!-- Action Buttons -->
						<div class="mt-4 flex flex-wrap gap-3">
							<button
								onclick={handleRetry}
								disabled={isRetrying}
								class="inline-flex items-center px-4 py-2 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{#if isRetrying}
									<svg
										class="animate-spin -ml-1 mr-2 h-4 w-4"
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
									>
										<circle
											class="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											stroke-width="4"
										></circle>
										<path
											class="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
										></path>
									</svg>
									Retrying...
								{:else}
									<svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
										/>
									</svg>
									Try Again
								{/if}
							</button>

							{#if showReportOption}
								<button
									onclick={openReportModal}
									class="inline-flex items-center px-4 py-2 bg-[var(--color-bg)] border border-[var(--color-danger-border)] text-[var(--color-danger)] rounded-lg hover:bg-[var(--color-danger-bg)] transition-colors dark:bg-[var(--color-surface)] dark:text-[var(--color-danger-text)]"
								>
									<svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
										/>
									</svg>
									Report Error
								</button>
							{/if}
						</div>
					</div>
				</div>
			</div>

			<!-- Technical Details (collapsible) -->
			<details class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-4 dark:bg-[var(--color-bg)] dark:border-[var(--color-border)]">
				<summary class="cursor-pointer text-sm font-medium text-[var(--color-text)] hover:text-[var(--color-text)] dark:text-[var(--color-text-muted)] dark:hover:text-[var(--color-text)]">
					Technical Details
				</summary>
				<div class="mt-3 text-xs font-mono text-[var(--color-text)] whitespace-pre-wrap break-all dark:text-[var(--color-text-muted)]">
					{error?.stack || errorDetails}
				</div>
			</details>
		</div>
	{/if}
{:else}
	<!-- Render children when no error -->
	{@render children?.()}
{/if}

<!-- Error Report Modal -->
{#if showReportModal}
	<div
		class="fixed inset-0 bg-[var(--color-bg)] bg-opacity-50 flex items-center justify-center z-50 p-4"
		role="button"
		tabindex="0"
		onclick={closeReportModal}
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeReportModal(); } }}
	>
		<div
			class="bg-[var(--color-bg)] rounded-lg max-w-md w-full shadow-xl dark:bg-[var(--color-surface)]"
			role="presentation"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>
			<div class="px-6 py-4 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h3 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Report Error</h3>
			</div>

			{#if reportSubmitted}
				<!-- Success Message -->
				<div class="px-6 py-8 text-center">
					<svg class="w-16 h-16 text-[var(--color-success)] mx-auto mb-4" fill="currentColor" viewBox="0 0 20 20">
						<path
							fill-rule="evenodd"
							d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
							clip-rule="evenodd"
						/>
					</svg>
					<p class="text-lg font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">Error report submitted</p>
					<p class="text-sm text-[var(--color-text)] mt-2 dark:text-[var(--color-text-muted)]">Thank you for helping us improve!</p>
				</div>
			{:else}
				<!-- Report Form -->
				<form
					onsubmit={(e) => {
						e.preventDefault();
						submitErrorReport(reportMessage);
					}}
					class="px-6 py-4"
				>
					<p class="text-sm text-[var(--color-text)] mb-4 dark:text-[var(--color-text-muted)]">
						Help us fix this issue by providing additional context about what you were doing when the
						error occurred.
					</p>

					<div class="mb-4">
						<label for="error-description" class="block text-sm font-medium text-[var(--color-text)] mb-2 dark:text-[var(--color-text-muted)]">
							What were you trying to do?
						</label>
						<textarea
							id="error-description"
							bind:value={reportMessage}
							rows="4"
							class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
							placeholder="Describe what happened..."
						></textarea>
					</div>

					<div class="bg-[var(--color-surface)] rounded-lg p-3 mb-4 dark:bg-[var(--color-bg)]">
						<p class="text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
							<strong>Error details:</strong> {errorDetails}
						</p>
					</div>

					<div class="flex gap-3">
						<button
							type="submit"
							class="flex-1 px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors"
						>
							Submit Report
						</button>
						<button
							type="button"
							onclick={closeReportModal}
							class="px-4 py-2 bg-[var(--color-surface-strong)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors dark:bg-[var(--color-surface-strong)] dark:text-[var(--color-text-muted)]"
						>
							Cancel
						</button>
					</div>
				</form>
			{/if}
		</div>
	</div>
{/if}
