<!--
  /settings/github — connect the public Non-Agentic AI GitHub App.

  Contract: ~/.claude/plans/public-github-app-usable.md. The install button
  asks fr for a signed, single-use install URL and sends the browser to
  GitHub; GitHub returns via /api/github-app/callback, which redirects back
  here with ?claim=<handle> | ?pending=1 | ?github_error=<code>.

  ?claim= is NOT a connection yet: the callback is unauthenticated, so this
  page (where the user IS logged in) confirms the claim with their bearer, and
  fr binds only if they are the user + workspace that started the install.
  The handle is stripped from the URL either way (it is single-use).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    confirmClaim,
    disconnectInstallation,
    GithubAppApiError,
    getInstallUrl,
    installErrorMessage,
    listInstallations,
    type GithubAppInstallation
  } from '$lib/api/github-app';
  import { Skeleton, EmptyState, ErrorState } from '$lib/components/ui';

  const GITHUB_INSTALLATIONS_URL = 'https://github.com/settings/installations';

  let installations = $state<GithubAppInstallation[]>([]);
  let loading = $state(true);
  let loadError = $state<unknown>(null);
  let installing = $state(false);
  let actionError = $state<string | null>(null);
  let disconnecting = $state<string | null>(null);
  let disconnected = $state<string | null>(null);
  let confirming = $state(false);
  let connected = $state<string | null>(null);
  let claimError = $state<string | null>(null);

  const pending = $derived($page.url.searchParams.get('pending') === '1');
  const errorCode = $derived(claimError ?? $page.url.searchParams.get('github_error'));

  const active = $derived(installations.filter((i) => !i.revoked_at));

  onMount(async () => {
    const handle = $page.url.searchParams.get('claim');
    if (handle) await confirmPendingClaim(handle);
    await load();
  });

  async function confirmPendingClaim(handle: string) {
    confirming = true;
    try {
      connected = await confirmClaim(handle);
    } catch (e) {
      claimError = e instanceof GithubAppApiError && e.code ? e.code : 'claim_failed';
    } finally {
      confirming = false;
      const u = new URL($page.url);
      u.searchParams.delete('claim');
      await goto(`${u.pathname}${u.search}`, { replaceState: true, noScroll: true, keepFocus: true });
    }
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      installations = await listInstallations();
    } catch (e) {
      loadError = e;
    } finally {
      loading = false;
    }
  }

  async function install() {
    installing = true;
    actionError = null;
    try {
      const url = await getInstallUrl();
      window.location.assign(url);
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
      installing = false;
    }
  }

  async function disconnect(inst: GithubAppInstallation) {
    disconnecting = inst.id;
    actionError = null;
    disconnected = null;
    try {
      await disconnectInstallation(inst.id);
      disconnected = inst.account_login;
      await load();
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      disconnecting = null;
    }
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  }
</script>

<section class="p-6 space-y-6">
  <header class="space-y-2">
    <h1 class="text-2xl font-semibold">GitHub</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      The Non-Agentic AI GitHub App gets read and write access only to the repositories you select when
      you install it. It never touches your workflow or CI files.
    </p>
  </header>

  {#if confirming}
    <div class="rounded border border-[var(--color-border)] p-3 text-sm" role="status" data-testid="github-banner-confirming">
      Connecting your GitHub installation…
    </div>
  {/if}
  {#if connected}
    <div class="rounded border border-[var(--color-success)] p-3 text-sm" role="status" data-testid="github-banner-connected">
      Connected <span class="font-mono">{connected}</span>. Non-Agentic AI can now use the repositories you selected there.
    </div>
  {/if}
  {#if pending}
    <div class="rounded border border-[var(--color-warning)] p-3 text-sm" role="status" data-testid="github-banner-pending">
      Your install request was sent to GitHub. An owner of that organization must approve it before
      Non-Agentic AI can use it; once approved, install again from this page to connect it here.
    </div>
  {/if}
  {#if errorCode}
    <div class="rounded border border-[var(--color-danger)] p-3 text-sm text-[var(--color-danger)]" role="alert" data-testid="github-banner-error" data-error-code={errorCode}>
      {installErrorMessage(errorCode)}
    </div>
  {/if}

  <div>
    <button
      type="button"
      data-testid="github-install"
      onclick={install}
      disabled={installing}
      class="px-4 py-2 bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
    >
      {installing ? 'Opening GitHub…' : 'Install on a GitHub organization or account'}
    </button>
  </div>

  {#if actionError}
    <p class="text-sm text-[var(--color-danger)]" data-testid="github-action-error">{actionError}</p>
  {/if}
  {#if disconnected}
    <p class="text-sm" role="status" data-testid="github-disconnected">
      Disconnected <span class="font-mono">{disconnected}</span> — Non-Agentic AI will no longer use it. To
      remove the app completely, uninstall it on GitHub:
      <a class="underline" href={GITHUB_INSTALLATIONS_URL} target="_blank" rel="noopener noreferrer">{GITHUB_INSTALLATIONS_URL}</a>.
    </p>
  {/if}

  <div class="space-y-2">
    <h2 class="text-lg font-semibold">Connected accounts</h2>
    {#if loading}
      <Skeleton variant="text" count={3} height="2.5rem" />
    {:else if loadError}
      <ErrorState error={loadError} title="Couldn't load connected GitHub accounts" onRetry={load} />
    {:else if active.length === 0}
      <EmptyState
        title="No GitHub accounts connected"
        body="Install the app on an organization or account to let Non-Agentic AI work on its private repositories."
      />
    {:else}
      <div class="overflow-x-auto">
      <table class="w-full min-w-[36rem] text-sm" data-testid="github-installations">
        <thead>
          <tr class="text-left text-[var(--color-text-muted)]">
            <th class="py-2 pr-4">Account</th>
            <th class="py-2 pr-4">Type</th>
            <th class="py-2 pr-4">Connected by</th>
            <th class="py-2 pr-4">Connected on</th>
            <th class="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each active as inst (inst.id)}
            <tr class="border-t border-[var(--color-border)]" data-testid="github-installation-row">
              <td class="py-2 pr-4 font-mono">{inst.account_login}</td>
              <td class="py-2 pr-4">{inst.account_type}</td>
              <td class="py-2 pr-4">{inst.github_user_login ?? '—'}</td>
              <td class="py-2 pr-4">{formatDate(inst.created_at)}</td>
              <td class="py-2 text-right">
                <button
                  type="button"
                  data-testid="github-disconnect"
                  onclick={() => disconnect(inst)}
                  disabled={disconnecting !== null}
                  class="underline text-[var(--color-danger)] disabled:opacity-50"
                >
                  {disconnecting === inst.id ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      </div>
      <p class="text-xs text-[var(--color-text-muted)]">
        Disconnect stops Non-Agentic AI using an installation. To fully remove the app, uninstall it on
        GitHub: <a class="underline" href={GITHUB_INSTALLATIONS_URL} target="_blank" rel="noopener noreferrer">{GITHUB_INSTALLATIONS_URL}</a>.
      </p>
    {/if}
  </div>
</section>
