<script lang="ts">
  // R319 — "Start again" at the top of every project page: the conveyor accepted this
  // project's start 10+ minutes ago, but its first card is still waiting (the backend's retry
  // offer `no_progress`), or (R320) its first card has not moved for 30+ minutes (`stalled`).
  // R320: when a "Start again" was not carried out (`restart_not_done`) the backend's text is
  // shown, without a button. Any member of the workspace may press it; the backend refuses a
  // second press while one is being sent, and never offers it while the project is on hold.
  // Read once per project; nothing is shown while unknown or when the read fails.
  import { page } from '$app/stores';
  import { fetchProjectConveyorNotices, retryProjectConveyorStart, type ConveyorRetryOffer } from '$lib/api/project-execution';
  import { START_AGAIN_TEXT, startAgainCopy, startAgainErrorText, startAgainNotDoneText } from '$lib/projects/start-again';

  const projectId = $derived($page.params?.id ?? '');
  let retry = $state<ConveyorRetryOffer | null>(null);
  let readFor = $state('');
  let busy = $state(false);
  let message = $state<{ ok: boolean; text: string } | null>(null);

  async function load(id: string): Promise<void> {
    try {
      // Quiet: every project page mounts this banner, and a project with no start record
      // (or a backend without the route) answers non-2xx — that is "nothing to offer", not an
      // app error. The Execution hub reads the same route loudly and shows the failure.
      const n = await fetchProjectConveyorNotices(id, { quiet: true });
      if (id === projectId) {
        retry = n.retry;
        readFor = id;
      }
    } catch (e) {
      // An unreadable offer shows nothing new (R319); the Execution hub shows the read error.
      console.warn('[start-again] could not read the start offer; "Start again" is not shown', e);
      if (id === projectId) retry = null;
    }
  }

  $effect(() => {
    const id = projectId;
    retry = null;
    readFor = '';
    message = null;
    if (id) void load(id);
  });

  async function startAgain(): Promise<void> {
    if (busy) return;
    const id = projectId;
    busy = true;
    message = null;
    try {
      await retryProjectConveyorStart(id);
      message = { ok: true, text: START_AGAIN_TEXT.sent };
    } catch (e) {
      message = { ok: false, text: startAgainErrorText(e) };
    } finally {
      busy = false;
      await load(id);
    }
  }

  const copy = $derived(readFor === projectId ? startAgainCopy(retry) : null);
  const offered = $derived(copy !== null);
  const notDone = $derived(readFor === projectId ? startAgainNotDoneText(retry) : null);
</script>

{#if offered || message || notDone}
  <div
    role="status"
    data-testid="project-start-again"
    class="border-b border-[var(--color-warning-border,transparent)] bg-[var(--color-warning-bg)] px-6 py-3"
  >
    {#if notDone && !message}
      <p class="text-sm text-[var(--color-text)]" data-testid="project-start-again-not-done">{notDone}</p>
    {/if}
    {#if copy}
      <p class="text-sm font-semibold text-[var(--color-warning-text)]" data-testid="project-start-again-headline">{copy.headline}</p>
      <p class="mt-1 text-sm text-[var(--color-text)]" data-testid="project-start-again-body">{copy.body}</p>
      <div class="mt-2">
        <button
          type="button"
          class="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50"
          disabled={busy}
          onclick={() => void startAgain()}
          data-testid="project-start-again-button"
        >
          {busy ? START_AGAIN_TEXT.busy : START_AGAIN_TEXT.button}
        </button>
      </div>
    {/if}
    {#if message}
      <p class="mt-1.5 text-sm {message.ok ? 'text-[var(--color-text)]' : 'text-[var(--color-danger)]'}" data-testid="project-start-again-message">{message.text}</p>
    {/if}
  </div>
{/if}
