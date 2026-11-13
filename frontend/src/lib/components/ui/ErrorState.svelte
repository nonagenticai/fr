<script lang="ts">
  import { Button } from '.';

  let {
    error,
    onRetry,
    title = 'Something went wrong',
    class: className = ''
  }: {
    error: unknown;
    onRetry?: () => void;
    title?: string;
    class?: string;
  } = $props();

  function messageOf(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    if (err && typeof err === 'object' && 'message' in err) {
      const m = (err as { message?: unknown }).message;
      if (typeof m === 'string' && m.length > 0) return m;
    }
    try {
      return String(err);
    } catch {
      return 'Unknown error';
    }
  }

  const message = $derived(messageOf(error));
</script>

<div
  data-testid="error-state"
  role="alert"
  class={`flex flex-col items-center justify-center gap-3 py-12 px-6 text-center ${className}`}
>
  <div class="text-[var(--color-danger)]" data-testid="error-state-icon" aria-hidden="true">
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  </div>
  <h3 class="text-lg font-semibold text-[var(--color-text)]" data-testid="error-state-title">
    {title}
  </h3>
  <p
    class="text-sm font-mono text-[var(--color-text-muted)] max-w-xl break-words"
    data-testid="error-state-message"
  >
    {message}
  </p>
  {#if onRetry}
    <div class="mt-2">
      <Button variant="secondary" onclick={onRetry}>Retry</Button>
    </div>
  {/if}
</div>
