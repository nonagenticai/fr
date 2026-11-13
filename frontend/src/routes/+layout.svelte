<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto, beforeNavigate } from '$app/navigation';
	import { updated } from '$app/state';
	import { page } from '$app/stores';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import ShellLayout from '$lib/layout/ShellLayout.svelte';
	import ProjectShellLayout from '$lib/layout/ProjectShellLayout.svelte';
	import { isProjectShellRoute } from '$lib/layout/shellKind';
	import Toast from '$lib/components/Toast.svelte';
	import ActivityTray from '$lib/components/ActivityTray.svelte';
	import { ActivityTray as ObservabilityActivityTray } from '$lib/components/observability';
	import CmdK from '$lib/components/CmdK.svelte';
	import KagShell from '$lib/layout/KagShell.svelte';
	import LicenseBlocked from '$lib/components/LicenseBlocked.svelte';
	import LicenseExpiringBanner from '$lib/components/LicenseExpiringBanner.svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import { licenseGate } from '$lib/stores/licenseGate.svelte';
	import { theme } from '$lib/stores/theme.svelte';
	import { agentRail } from '$lib/stores/agentRail.svelte';
	import { isKagAllowedPath, KAG_HUB_PATH } from '$lib/product';
	import { resolveTitle } from '$lib/layout/pageTitle';
	import { getPageTitleOverride } from '$lib/layout/pageTitle.svelte';

	let { children, data } = $props();

	// Product mode (host-resolved in +layout.ts; SSR-safe, no fr-chrome flash).
	// In kag mode we render the chrome-free KagShell and skip fr-only chrome.
	const kagMode = $derived(data?.product === 'kag');

	// Layout-level toggle for the global slide-out ActivityTray (REST-polled
	// variant from $lib/components/observability). Triggered by the
	// LivenessBadge mounted in TopNav.
	let activityTrayOpen = $state(false);

	// Public routes that don't require authentication
	const publicRoutes = ['/login'];
	// Authenticated-but-license-gated destinations the gate must NOT bounce —
	// the in-app renew page must stay reachable even when the license is blocked.
	const licenseRoutes = ['/license-upgrade'];

	// Refresh the authoritative license gate on a cadence + when the tab regains
	// focus, so an expiry that lands while the app is open is caught even without
	// an API call triggering the 403 path.
	let licenseRefreshTimer: ReturnType<typeof setInterval> | null = null;
	function onVisibility() {
		if (document.visibilityState === 'visible' && auth.isAuthenticated) {
			void licenseGate.load();
		}
	}

	// Deploy-resilience: fr ships retire-first (single-replica pod on a
	// CPU-saturated node), so during a roll an open tab's lazily-loaded route
	// chunks 404/503 on the now-gone immutable hashes. When SvelteKit's version
	// poller detects a new build (`updated.current`), do a full document load on
	// the next navigation so fresh chunks are fetched — instead of a "failed to
	// fetch dynamically imported module" white-screen. hooks.client.ts handles the
	// in-place (no-navigation) case.
	beforeNavigate((nav) => {
		if (updated.current && nav.to?.url && !nav.willUnload) {
			nav.cancel();
			location.href = nav.to.url.href;
		}
	});

	onMount(async () => {
		theme.initialize();
		// Initialize Keycloak authentication. `ensureInitialized` not `initialize`:
		// a guarded route's `load` may already have started it, and this must join
		// that same promise rather than run a second handshake.
		await auth.ensureInitialized();
		// The license gate is loaded reactively (see the $effect below) the moment
		// auth flips authenticated — covers both initial load AND a mid-session
		// login without waiting up to a full interval tick.
		licenseRefreshTimer = setInterval(() => {
			if (auth.isAuthenticated) void licenseGate.load();
		}, 15 * 60 * 1000);
		document.addEventListener('visibilitychange', onVisibility);
	});

	// Load the authoritative license gate as soon as the user is authenticated
	// (and only once until cleared) — so a newly-logged-in user never sees an
	// unblocked shell before the first status lands.
	$effect(() => {
		if (auth.isAuthenticated && !licenseGate.status && !licenseGate.isLoading) {
			void licenseGate.load();
		}
	});

	onDestroy(() => {
		theme.destroy();
		if (licenseRefreshTimer) clearInterval(licenseRefreshTimer);
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibility);
		}
	});

	// Check if current route requires authentication
	$effect(() => {
		// A logout is a top-level navigation to Keycloak end-session that is still
		// in flight. Redirecting to /login here would supersede it and leave the
		// SSO session alive (the user comes back silently re-authenticated).
		if (auth.isLoggingOut) return;
		if (auth.isLoading) return;
		const currentPath = $page.url.pathname;
		const isPublicRoute = publicRoutes.includes(currentPath);

		// Redirect to login if not authenticated and not on public route
		if (!auth.isAuthenticated && !isPublicRoute) {
			console.log('Not authenticated, redirecting to login');
			goto('/login');
			return;
		}

		// KAG product surface gate: only the KAG routes are reachable in kag mode
		// (stray fr routes would query an empty kag_frontend DB). License blocking
		// (expired/revoked/none) is handled globally by the LicenseBlocked render
		// branch + the backend X-App-Key: kag gate, so no per-product redirect.
		if (kagMode && auth.isAuthenticated) {
			if (!isKagAllowedPath(currentPath)) {
				goto(KAG_HUB_PATH);
			}
		}
	});

	// URL → store: when ?thread=<id> is present, open the rail with that thread.
	$effect(() => {
		const t = $page.url.searchParams.get('thread');
		// fr-agui P1c-b: never re-open a thread the rail refused on this surface
		// (bound to another project) from a stale ?thread= link.
		if (t && t !== agentRail.activeThreadId && !agentRail.isRefusedThread(t)) {
			agentRail.openThread(t);
		}
	});

	// Store → URL: keep ?thread=<id> in sync so refresh restores the rail and
	// the link is shareable. Stripped when the rail is closed.
	//
	// Gated on the [Agent] tab as well. `close()` does NOT clear activeThreadId
	// (only `reset()` does), so a user who opened a thread, closed the rail, then
	// used an "open in pane" affordance would stamp that STALE id into the URL
	// while the Detail tab was showing. Refreshing or sharing that link hits the
	// URL → store effect above, which calls openThread() and forces tab back to
	// 'agent' — silently serving an old conversation instead of the detail the
	// link was meant to carry. ?thread= describes a thread, so it is written only
	// when a thread is what the rail is actually showing.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const open = agentRail.showsThread;
		const id = agentRail.activeThreadId;
		const url = new URL(window.location.href);
		const current = url.searchParams.get('thread');
		const next = open && id ? id : null;
		if (current === next) return;
		if (next) url.searchParams.set('thread', next);
		else url.searchParams.delete('thread');
		void goto(url.pathname + url.search, {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<!-- The ONLY title element in the app. Every route's tab text is resolved here from
	     the static route map plus an optional entity-name override published by
	     the page itself (see setPageTitle). The per-page convention it replaces
	     left the PREVIOUS page's title mounted on the 139 routes that set none. -->
	<title>{resolveTitle($page.route.id, $page.url.pathname, getPageTitleOverride(), kagMode)}</title>
</svelte:head>

{#if auth.isLoading}
	<!-- Loading screen while authenticating -->
	<div class="flex items-center justify-center h-screen bg-[var(--color-surface)] dark:bg-[var(--color-bg)]">
		<div class="text-center">
			<div class="animate-spin rounded-full h-16 w-16 border-b-4 border-[var(--color-accent)] mx-auto mb-4"></div>
			<p class="text-[var(--color-text)] text-lg dark:text-[var(--color-text-muted)]">Initializing...</p>
		</div>
	</div>
{:else if !auth.isAuthenticated && publicRoutes.includes($page.url.pathname)}
	<!-- Public pages (login, etc.) -->
	<div class="h-screen bg-[var(--color-surface)] dark:bg-[var(--color-bg)]">
		{@render children()}
	</div>
{:else if auth.isAuthenticated && licenseGate.isBlocked && !licenseRoutes.includes($page.url.pathname)}
	<!-- License missing/expired/revoked (or a live 403 fr_license_required):
	     full-screen hard block for BOTH products. The renew route is excluded
	     so the in-app renew page stays reachable. -->
	<LicenseBlocked />
{:else if auth.isAuthenticated && kagMode}
	<!-- KAG product (kag.nonagentic.ai): chrome-free shell, KAG surface only. -->
	<KagShell>
		{@render children()}
	</KagShell>
{:else if auth.isAuthenticated && isProjectShellRoute($page.route.id)}
	<!-- fr-agui SPEC §7.2: every route in the (project) group — every page under
	     /projects/[id]/** — renders in the PROJECT shell: project nav, project
	     header, the same licence + support banners and TopNav. Keyed on the route
	     id (group segment), never a pathname regex, so the tenant doorway pages
	     (/projects/new, /projects/intake, /projects/requests) stay below. Sits
	     AFTER the LicenseBlocked branch, so the licence gate still applies. -->
	<ProjectShellLayout onOpenActivity={() => (activityTrayOpen = true)}>
		{@render children()}
	</ProjectShellLayout>
{:else if auth.isAuthenticated}
	<!-- Authenticated layout: ShellLayout = TopNav (the one app bar) over
	     sidebar + main + collapsible right Agent rail. The right-pane
	     ContextualPane is folded into the rail's [Detail] tab (mounted inside
	     AgentRail.svelte). TopNav receives `onOpenActivity` so its LivenessBadge
	     can toggle the global slide-out ObservabilityActivityTray rendered below. -->
	<ShellLayout onOpenActivity={() => (activityTrayOpen = true)}>
		<LicenseExpiringBanner />
		<div class="flex-1 overflow-y-auto p-6">
			{@render children()}
		</div>
	</ShellLayout>
{:else}
	<!-- Fallback (shouldn't normally happen) -->
	<div class="flex items-center justify-center h-screen bg-[var(--color-surface)] dark:bg-[var(--color-bg)]">
		<p class="text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Redirecting...</p>
	</div>
{/if}

<!-- Global Toast Notifications -->
<Toast />

<!-- Activity tray (n8n observability) — fr product only, when authenticated.
     The KAG product (kagMode) uses the chrome-free KagShell with no fr nav /
     CmdK / activity rails, so none of this renders there. -->
{#if auth.isAuthenticated && !kagMode}
	<ActivityTray />
	<!-- REST-polled slide-out drawer driven by TopNav's LivenessBadge. -->
	<ObservabilityActivityTray bind:open={activityTrayOpen} />
	<!-- Cmd-K palette — global keyboard shortcut. -->
	<CmdK />
{/if}
