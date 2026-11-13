<!--
  "Install the Non-Agentic AI GitHub App on <owner>" — offered next to a repo-access
  verdict, and ONLY when installing would help: a private_ungranted verdict on a
  github.com repo outside nonagenticai (see installCtaOwner). Opens GitHub in a
  new tab; the caller keeps its own Re-check.
-->
<script lang="ts">
  import { installCtaOwner, openInstallInNewTab } from '$lib/api/github-app';

  let { verdict }: { verdict: { url: string; access_state: string } | null | undefined } = $props();

  const owner = $derived(installCtaOwner(verdict));
  let opening = $state(false);
  let error = $state<string | null>(null);

  async function install() {
    opening = true;
    error = null;
    try {
      await openInstallInNewTab();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      opening = false;
    }
  }
</script>

{#if owner}
  <button
    type="button"
    data-testid="install-github-app"
    onclick={install}
    disabled={opening}
    class="ml-2 underline disabled:opacity-50"
  >
    Install the Non-Agentic AI GitHub App on {owner}
  </button>
  {#if error}
    <span class="ml-2 text-[var(--color-danger)]" data-testid="install-github-app-error">{error}</span>
  {/if}
{/if}
