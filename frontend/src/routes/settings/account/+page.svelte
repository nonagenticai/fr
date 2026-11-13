<!--
  /settings/account — in-app account page.

  Replaces the old "Manage account" link that redirected out to the Keycloak
  account console (auth.nonagentic.ai). Identity (name/email/id) is read-only
  here (it's owned by Keycloak), but everything fr knows about the signed-in
  user — roles, workspace memberships, operator status, theme — is surfaced in
  one place, plus quick links to the other settings panes and sign-out. No
  external navigation.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import { workspaces } from '$lib/stores/workspaces.svelte';
	import ThemeToggle from '$lib/components/ui/ThemeToggle.svelte';

	onMount(() => {
		// Safe to call repeatedly; the switcher may already have hydrated it.
		if (!workspaces.loaded) void workspaces.load();
	});

	const initial = $derived(auth.user?.name?.charAt(0)?.toUpperCase() || 'U');

	// Realm/tenant roles worth surfacing, de-duplicated and stable-ordered.
	const roles = $derived([...(auth.user?.roles ?? [])].sort());

	function workspaceKindLabel(kind: string): string {
		switch (kind) {
			case 'system':
				return 'System';
			case 'kata':
				return 'Kata';
			default:
				return 'Execution';
		}
	}

	async function handleSignOut() {
		await auth.logout();
	}
</script>

<div class="space-y-8" data-testid="account-page">
	<header>
		<h1 class="text-2xl font-bold text-[var(--color-text)] dark:text-[var(--color-text)]">Account</h1>
		<p class="mt-1 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
			Your profile, access, and workspaces.
		</p>
	</header>

	<!-- Profile -->
	<section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
		<div class="flex items-center gap-4">
			<div
				class="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent)] text-xl font-semibold text-[var(--color-on-primary)]"
			>
				{initial}
			</div>
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<p class="truncate text-lg font-semibold text-[var(--color-text)]">{auth.user?.name || 'User'}</p>
					{#if auth.isSuperAdmin}
						<span class="rounded-full bg-[var(--color-accent-bg)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent-text)]">
							Super-admin
						</span>
					{/if}
				</div>
				<p class="truncate text-sm text-[var(--color-text-muted)]">{auth.user?.email || ''}</p>
			</div>
		</div>

		<dl class="mt-6 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
			<div>
				<dt class="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">Current workspace</dt>
				<dd class="text-sm text-[var(--color-text)]">{auth.user?.tenant_name || workspaces.active?.name || '—'}</dd>
			</div>
			<div>
				<dt class="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">User ID</dt>
				<dd class="break-all font-mono text-xs text-[var(--color-text-muted)]">{auth.user?.id || '—'}</dd>
			</div>
		</dl>

		<p class="mt-4 text-xs text-[var(--color-text-muted)]">
			Your name, email, and password are managed by your identity provider. Contact an administrator to change them.
		</p>
	</section>

	<!-- Theme -->
	<section class="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4">
		<div>
			<p class="text-sm font-medium text-[var(--color-text)]">Theme</p>
			<p class="text-xs text-[var(--color-text-muted)]">Light, dark, or follow the system.</p>
		</div>
		<ThemeToggle />
	</section>

	<!-- Access / roles -->
	<section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
		<h2 class="text-sm font-semibold text-[var(--color-text)]">Access</h2>
		{#if roles.length > 0}
			<div class="mt-3 flex flex-wrap gap-2">
				{#each roles as role (role)}
					<span class="rounded-full bg-[var(--color-bg)] px-2.5 py-1 text-xs text-[var(--color-text)] dark:bg-[var(--color-surface-strong)]">
						{role}
					</span>
				{/each}
			</div>
		{:else}
			<p class="mt-3 text-sm text-[var(--color-text-muted)]">No roles assigned.</p>
		{/if}
	</section>

	<!-- Workspace memberships -->
	{#if workspaces.workspaces.length > 0}
		<section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
			<h2 class="text-sm font-semibold text-[var(--color-text)]">Workspaces</h2>
			<p class="mt-1 text-xs text-[var(--color-text-muted)]">Workspaces you can act in. Switch the active one from the top bar.</p>
			<ul class="mt-3 divide-y divide-[var(--color-border)]">
				{#each workspaces.workspaces as ws (ws.id)}
					<li class="flex items-center justify-between py-2">
						<div class="min-w-0">
							<p class="truncate text-sm text-[var(--color-text)]">{ws.name}</p>
							<p class="text-xs text-[var(--color-text-muted)]">{workspaceKindLabel(ws.kind)}</p>
						</div>
						{#if ws.id === workspaces.activeId}
							<span class="rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 text-xs font-medium text-[var(--color-success-text)]">Active</span>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<!-- Sign out -->
	<section class="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4">
		<div>
			<p class="text-sm font-medium text-[var(--color-text)]">Sign out</p>
			<p class="text-xs text-[var(--color-text-muted)]">End your session on this device.</p>
		</div>
		<button
			type="button"
			onclick={handleSignOut}
			class="rounded-lg border border-[var(--color-danger)] px-4 py-2 text-sm font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger-bg)]"
		>
			Sign out
		</button>
	</section>
</div>
