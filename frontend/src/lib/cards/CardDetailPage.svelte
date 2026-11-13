<script lang="ts">
	// The card detail view, shared by the tenant route `/cards/[id]` and the
	// project-shell route `/projects/[id]/cards/[cardId]` (fr-agui SPEC §7.3
	// "Board and cards", D10). The route passes its own project id (null on the
	// tenant route); once the card is read, `cardViewRedirect` moves the view to
	// where the SERVER says the card lives (§7.5: card → board → project).
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { setPageTitle } from '$lib/layout/pageTitle.svelte';
	import { cardViewRedirect } from '$lib/projects/projectShellRedirects';
	import { usePoll, type PollHandle } from '$lib/net/poll';
	import { CardLive } from '$lib/cards/cardLive.svelte';
	import CardDetailSections from '$lib/cards/CardDetailSections.svelte';
	import { activeProject } from '$lib/stores/activeProject.svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import { workspaces } from '$lib/stores/workspaces.svelte';
	import { newKataHref } from '$lib/katas/helpers';

	// ── A card detail view is WATCHED, so it has to actually be live ─────────
	// Cards are the conveyor: a human or an agent in a seat sits on this page
	// while work moves through the card. This route used to read the card
	// exactly once, at mount (twice, in fact — an `onMount` and an `$effect`
	// both called `load`), and then never again, so the page silently froze at
	// whatever it said when it was opened.
	//
	// The dangerous half is the other one: refreshing forever and saying
	// nothing when the refresh stops working. Measured on prod 2026-09-10 (pod
	// fr-859f796c55-kcv5j): 118 of 187 `GET /api/cards/<id>` answered 401
	// (`JWTExpired`, `exp - iat = 300`) — one every ~20s, unbroken to the last
	// line of the log, invisible outside that log.
	//
	// So the two halves are split deliberately:
	//   * FRESH CREDENTIAL PER REQUEST — every read goes through `authFetch`,
	//     which resolves the token per call and, on a 401, force-refreshes and
	//     replays once ($lib/api/auth-fetch.ts). Nothing here closes over a
	//     token.
	//   * BOUNDED, VISIBLE FAILURE — `CardLive` stops on a terminal answer or
	//     after MAX_CONSECUTIVE_POLL_FAILURES transient ones, and the banner
	//     below says the card is no longer being refreshed. There is no path
	//     that keeps retrying while the surface still looks live.
	const CARD_POLL_INTERVAL_MS = 15_000;

	const live = new CardLive();

	let { cardId, routeProjectId }: { cardId: string; routeProjectId: string | null } = $props();
	// Local alias so the template narrows it (and so the markup reads as the
	// card, not as an accessor chain).
	const card = $derived(live.card);

	let poll: PollHandle | null = null;

	async function tick(id: string): Promise<void> {
		const outcome = await live.refresh(id);
		if (outcome === 'terminal') {
			// 404 / not authorized / the failure cap. Retrying cannot change the
			// answer, and the surface is already showing why.
			poll?.stop();
			return;
		}
		if (outcome === 'failed') {
			// Transient. Rethrow so `usePoll` backs off exponentially instead of
			// hammering a struggling backend every 15s; the last-good card stays
			// on screen meanwhile.
			throw new Error('card refresh failed');
		}
	}

	function startPolling(id: string): PollHandle {
		const handle = usePoll(() => tick(id), {
			intervalMs: CARD_POLL_INTERVAL_MS,
			initialDelayMs: 0
		});
		poll = handle;
		handle.start();
		return handle;
	}

	// Owns the whole poll lifecycle: first load, id change, and unmount. The
	// teardown is what stops a poll for a card the user has navigated away from.
	$effect(() => {
		const id = cardId;
		poll?.stop();
		poll = null;
		if (!id) return;
		const handle = startPolling(id);
		return () => {
			handle.stop();
			if (poll === handle) poll = null;
		};
	});

	function retryLive(): void {
		const id = cardId;
		if (!id) return;
		poll?.stop();
		live.resume();
		startPolling(id);
	}

	function asOf(ms: number | null): string {
		if (ms === null) return 'an unknown time';
		return new Date(ms).toLocaleTimeString();
	}

	// Publish this route's entity name to the single title element in the
	// root layout. Always the CURRENT pathname: the resolver drops an override
	// whose path no longer matches, which is what makes a stale tab title
	// impossible. `null` while loading falls back to the static map entry.
	$effect(() => {
		setPageTitle($page.url.pathname, card?.name ?? null);
	});

	// §7.5 redirect. Keyed on the resolved project alone (not the whole card),
	// so the 15s poll does not re-run it. `fr_project_id` absent (older backend)
	// ⇒ undefined ⇒ stay.
	const serverProjectId = $derived(card ? card.fr_project_id : undefined);
	const redirectTo = $derived(
		card ? cardViewRedirect(cardId, routeProjectId, serverProjectId) : null
	);
	$effect(() => {
		const to = redirectTo;
		if (to) void goto(to, { replaceState: true });
	});

	// Inside the project shell the route's own project is the back target.
	const backHref = $derived(
		routeProjectId ? `/projects/${encodeURIComponent(routeProjectId)}/board` : '/kanban'
	);

	// UI review 2026-10-07: the TENANT route lives OUTSIDE the /projects/[id] layout,
	// so opening a card dropped the project context from the sidebar nav and
	// the header selector. When the SERVER states the card's fr project
	// (`fr_project_id`, emitted only when GET /api/projects/:id would admit the
	// caller — the same id the breadcrumb links to), select it the way the
	// project layout does. Never the editable Metadata `project_id`: a peer who
	// cannot read the project gets null and must not have it selected. Keyed
	// on the id alone so the 15s poll does not re-run it. The SELECTION
	// persists across routes; only the "open" scope (KAG cost attribution)
	// ends when this page, or the card, goes away.
	const frProjectId = $derived(card?.fr_project_id?.trim() || null);
	$effect(() => {
		const id = frProjectId;
		// In the project shell the (project) layout already selects the project.
		if (!id || routeProjectId) return;
		activeProject.open(id);
		void activeProject.load();
		return () => activeProject.leaveRoute(id);
	});
	// The owning project's status from the list `activeProject.load()` already
	// fetched (no extra read). Unlisted/unknown ⇒ null ⇒ no guard applied.
	const frProjectStatus = $derived(
		frProjectId ? (activeProject.projects.find((p) => p.id === frProjectId)?.status ?? null) : null
	);
</script>

<div class="mx-auto max-w-7xl px-4 py-6">
	{#if live.initialLoading}
		<p class="text-sm text-[var(--color-text-muted)]">Loading card…</p>
	{:else if live.error}
		<div class="rounded border border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-4">
			<p class="text-sm text-[var(--color-danger)]">{live.error}</p>
			<a href={backHref} class="text-xs text-[var(--color-accent)] hover:underline mt-2 inline-block">
				{routeProjectId ? '← back to the project board' : '← back to kanban'}
			</a>
		</div>
	{:else if card}
		{#if live.liveError}
			<!--
				The whole point of the fix: a card that has stopped updating must
				never keep looking live. This says what happened, when the data on
				screen is from, and offers exactly one operator-initiated retry —
				no automatic loop hides behind it.
			-->
			<div
				role="status"
				data-testid="card-live-stopped"
				class="mb-4 rounded border border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-4"
			>
				<p class="text-sm text-[var(--color-danger)]">
					Live updates stopped — {live.liveError}
				</p>
				<p class="text-xs text-[var(--color-text-muted)] mt-1">
					Showing this card as of {asOf(live.lastUpdatedAt)}. It is no longer being refreshed.
				</p>
				<button
					type="button"
					onclick={retryLive}
					class="text-xs text-[var(--color-accent)] hover:underline mt-2 inline-block"
				>
					Retry now
				</button>
			</div>
		{/if}
		{#if auth.isSuperAdmin}
			<!-- Super-admin only: open a kata from this card's symptom (/admin/kata, prefilled). -->
			<div class="mb-3 flex justify-end">
				<a
					href={newKataHref({ projectId: frProjectId, cardId, tenantId: workspaces.activeId ?? null })}
					class="text-xs text-[var(--color-accent)] hover:underline"
					data-testid="card-open-kata">Open kata from this card</a
				>
			</div>
		{/if}
		<CardDetailSections {card} projectStatus={frProjectStatus} />
	{/if}
</div>
