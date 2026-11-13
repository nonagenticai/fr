<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { apiClient } from '$lib/api/unified-client';
	import { kanbanStore } from '$lib/stores/kanbanStore.svelte';
	import BoardView from '$lib/components/kanban/BoardView.svelte';
	import {
		describeBoardLoadFailure,
		reportMutationFailure
	} from '$lib/components/kanban/mutationFeedback';
	import CardModal from '$lib/components/kanban/CardModal.svelte';
	import LivenessBadge from '$lib/components/LivenessBadge.svelte';
	import type { PlankaBoard } from '$lib/types/api';
	import { shortId } from '$lib/utils/shortId';
	import { goto } from '$app/navigation';
	import { kanbanBoardRedirect } from '$lib/projects/projectShellRedirects';
	import ProjectHaltBanner from '$lib/components/ProjectHaltBanner.svelte';
	import { projectHalt } from '$lib/stores/projectHalt.svelte';

	// Board selector state
	let boards = $state<PlankaBoard[]>([]);
	let selectedBoardId = $state<string | null>(null);
	// The selected board's project (if any) — its halt banner shows here too.
	const selectedProjectId = $derived(boards.find((b) => b.id === selectedBoardId)?.frProjectId ?? null);
	let loading = $state(false);
	let error = $state<string | null>(null);

	// Derived display label for the dropdown. Two distinct Planka boards
	// occasionally share the same `${projectName} / ${name}` string (the
	// upstream Planka instance allows it). The board.id is always unique,
	// so on label collision we append a short id suffix to disambiguate.
	const boardLabels = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const b of boards) {
			const k = b.projectName ? `${b.projectName} / ${b.name}` : b.name;
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
		return new Map(
			boards.map((b) => {
				const base = b.projectName ? `${b.projectName} / ${b.name}` : b.name;
				// The suffix must DISAMBIGUATE, which is exactly what a leading-8
				// cannot do: two boards created in one batch share their UUIDv7
				// prefix, so `(06954722…)` on both labels left them identical —
				// the collision this branch exists to break (fr#1203/#1205).
				// `shortId` takes the TAIL. String context, so not `<EntityRef>`.
				const label =
					(counts.get(base) ?? 0) > 1 ? `${base} (${shortId(String(b.id))})` : base;
				return [b.id, label];
			}),
		);
	});

	async function loadBoards() {
		loading = true;
		error = null;
		try {
			const data = await apiClient.kanban.listBoards();
			boards = data.items ?? [];
			if (boards.length > 0 && !selectedBoardId) {
				// Deep-link: `/kanban?board=<id>` (used by the continuous-improvement
				// board cards on /projects) preselects that board when present and
				// reachable; otherwise fall back to the first board.
				const requested =
					typeof window !== 'undefined'
						? new URLSearchParams(window.location.search).get('board')
						: null;
				// fr-agui SPEC §7.5: a PROJECT's board lives in the project shell.
				// The board → project mapping is the server's (frProjectId, from
				// the tenant-gated list); stream / ad-hoc boards stay here.
				const projectBoard = kanbanBoardRedirect(requested, boards);
				if (projectBoard) {
					await goto(projectBoard, { replaceState: true });
					return;
				}
				const initial =
					requested && boards.some((b) => b.id === requested)
						? requested
						: boards[0].id;
				selectedBoardId = initial;
				await kanbanStore.loadBoard(initial);
			}
		} catch (err) {
			const e = err as { status?: number; message?: string };
			if (e?.status === 502) {
				error = 'The board service is currently unavailable. It may not be deployed or is experiencing issues.';
			} else {
				error = e.message ?? 'Failed to load kanban boards';
			}
		} finally {
			loading = false;
		}
	}

	async function selectBoard(boardId: string) {
		selectedBoardId = boardId;
		error = null;
		try {
			await kanbanStore.loadBoard(boardId);
		} catch (err) {
			// The banner below is this page's only failure surface and nothing
			// used to set it here — a failed switch just logged to the console.
			console.error('Failed to load board:', err);
			error = describeBoardLoadFailure(err);
		}
	}

	// In-flight guard for `refresh()`. `loading` covers loadBoards and
	// `kanbanStore.boardLoading` covers a board fetch, but neither is set
	// during the gap between the click and the awaited call actually flipping
	// them, so a fast double-click could still fire two loads. This closes it.
	let refreshing = $state(false);

	// True while ANY load is in flight — the retry/refresh buttons disable on it.
	const busy = $derived(loading || refreshing || kanbanStore.boardLoading);

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			// ⚠️ This used to be `if (selectedBoardId) { … }` with no else, which
			// made it a NO-OP in exactly the state the retry button below exists
			// for: when `loadBoards()` fails (e.g. Planka 502 — the service is not
			// deployed), `boards` is empty and `selectedBoardId` is never set, so
			// there is no board to reload. Retrying has to go back to the call
			// that failed. A button wired to the old body would have looked live
			// and done nothing.
			if (!selectedBoardId) {
				await loadBoards();
				return;
			}
			error = null;
			try {
				await kanbanStore.loadBoard(selectedBoardId);
				// A re-read of the board re-reads its project's hold.
				void projectHalt.refresh();
			} catch (err) {
				console.error('Failed to refresh board:', err);
				error = describeBoardLoadFailure(err);
			}
		} finally {
			refreshing = false;
		}
	}

	async function openCard(cardId: string) {
		try {
			await kanbanStore.selectCard(cardId);
		} catch (err) {
			reportMutationFailure('open the card', err);
		}
	}

	function closeCard() {
		kanbanStore.closeSelectedCard();
	}

	onMount(async () => {
		kanbanStore.openSocket();
		await loadBoards();
	});

	onDestroy(() => {
		kanbanStore.closeSocket();
	});
</script>

<div class="flex flex-col h-full">
	<!-- Header -->
	<div class="flex items-center justify-between mb-4 flex-shrink-0">
		<div>
			<div class="flex items-center gap-3">
				<h1 class="text-3xl font-bold text-[var(--color-text)] dark:text-[var(--color-text)]">Kanban Board</h1>
				<LivenessBadge />
			</div>
			<p class="mt-1 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Project task management</p>
		</div>

		{#if boards.length > 0}
			<div class="flex items-center gap-3">
				<label for="board-select" class="text-sm font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Board:</label>
				<select
					id="board-select"
					class="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg bg-[var(--color-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
					value={selectedBoardId}
					onchange={(e) => selectBoard((e.target as HTMLSelectElement).value)}
					disabled={kanbanStore.boardLoading}
				>
					{#each boards as board}
						<option value={board.id}>
							{boardLabels.get(board.id) ?? board.name}
						</option>
					{/each}
				</select>
				<button
					onclick={refresh}
					disabled={busy}
					class="px-3 py-2 text-sm bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors disabled:opacity-50 dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
				>
					Refresh
				</button>
			</div>
		{/if}
	</div>

	<ProjectHaltBanner projectId={selectedProjectId} />

	{#if error}
		<div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-4 mb-4 flex-shrink-0 dark:bg-[var(--color-danger-bg)]/20">
			<div class="flex items-center gap-2">
				<svg class="w-5 h-5 text-[var(--color-danger)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				<p class="text-[var(--color-danger-text)]">{error}</p>
				<!--
					The ONLY recovery from this banner used to be a manual page
					reload: the branch rendered an icon and the message and nothing
					actionable, and the top-bar Refresh button is inside `{#if
					boards.length > 0}` — never rendered when the load that set this
					error is the one that failed. A plain <button> (not a div with an
					onclick) so it is tab-reachable and fires on Enter/Space for free.
				-->
				<button
					type="button"
					onclick={refresh}
					disabled={busy}
					data-testid="kanban-error-retry"
					class="ml-auto flex-shrink-0 px-3 py-1.5 text-sm font-medium rounded-lg border border-[var(--color-danger-border)] text-[var(--color-danger-text)] hover:bg-[var(--color-danger-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{busy ? 'Retrying…' : 'Retry'}
				</button>
			</div>
		</div>
	{/if}

	{#if loading}
		<div class="flex flex-col items-center justify-center py-20">
			<div class="w-12 h-12 border-4 border-[var(--color-accent)] border-t-blue-600 rounded-full animate-spin"></div>
			<p class="mt-4 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Loading boards...</p>
		</div>
	{:else if boards.length === 0 && !error}
		<!--
			⚠️ The second line used to read "Create a project to get started",
			which names a condition this page never measured and CANNOT measure.
			`apiClient.kanban.listBoards()` (GET /api/kanban/boards) returns
			`{items, total}` of BOARDS only — the backend fetches the Planka
			project list but never returns it, so "zero projects" and "projects
			exist but hold no boards" are indistinguishable here. A third cause
			reaches this arm too: the tenant allow-list can filter every board
			out of an otherwise healthy response. So the copy says only "no boards
			yet" and that boards live in projects — true under every one of those
			causes — and points at /projects instead of asserting which one holds.

			The upstream-down case does NOT land here: Planka unreachable is a
			502 from the proxy, which `loadBoards()` turns into `error`, and this
			arm is guarded on `!error`.
		-->
		<div class="text-center py-20" data-testid="kanban-empty-state">
			<p class="text-[var(--color-text-muted)] text-lg dark:text-[var(--color-text-muted)]">No kanban boards found</p>
			<p class="text-[var(--color-text-muted)] text-sm mt-2 dark:text-[var(--color-text-muted)]">
				This workspace has no kanban boards yet. Boards are created from projects.
			</p>
			<div class="mt-4 flex items-center justify-center gap-4 text-sm">
				<a href="/" data-testid="kanban-empty-projects-link" class="text-[var(--color-accent)] hover:underline">View projects</a>
				<a href="/projects/new" data-testid="kanban-empty-create-project-link" class="text-[var(--color-accent)] hover:underline">Create a project</a>
			</div>
		</div>
	{:else if kanbanStore.boardLoading}
		<div class="flex flex-col items-center justify-center py-20">
			<div class="w-12 h-12 border-4 border-[var(--color-accent)] border-t-blue-600 rounded-full animate-spin"></div>
			<p class="mt-4 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Loading board...</p>
		</div>
	{:else}
		<!--
			BoardView is rendered unconditionally here (not behind `{#if
			kanbanStore.board}`): it owns all three board states — loaded, deleted
			upstream (`boardStale`, which loadBoard sets while RETURNING normally,
			so no catch above ever fires for it) and none-loaded. Gating on a
			truthy board is exactly what made those last two arms unreachable and
			left a blank pane instead of a message.
		-->
		<BoardView onOpenCard={openCard} />
	{/if}
</div>

<CardModal onClose={closeCard} />
