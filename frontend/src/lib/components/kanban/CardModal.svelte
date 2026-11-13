<script lang="ts">
	import { kanbanStore } from '$lib/stores/kanbanStore.svelte';
	import { reportMutationFailure } from './mutationFeedback';
	import CommentList from './CommentList.svelte';
	import LabelPicker from './LabelPicker.svelte';
	import CardTocSection from '$lib/components/toc/CardTocSection.svelte';
	import { authFetch } from '$lib/api/auth-fetch';
	import type { CardDetail } from '$lib/cards/types';
	import { descriptionSegments, parseReadiedBrief, stripReadiedBrief } from '$lib/cards/readiedBrief';

	type Props = {
		onClose: () => void;
	};
	const { onClose }: Props = $props();

	// Local draft state for name / description with blur/debounce save.
	let nameDraft = $state('');
	let descDraft = $state('');
	let dueDateDraft = $state('');
	let saving = $state(false);
	// Per-action in-flight guards for the footer. These are one-shot writes with
	// no debounce in front of them, so N clicks made N duplicates / N deletes.
	// Idiom: lib/bridge/PromoteButton.svelte.
	let duplicating = $state(false);
	let closing = $state(false);
	let deleting = $state(false);

	let descTimer: ReturnType<typeof setTimeout> | null = null;

	// UI review 2026-10-07: the description was ONLY a textarea, so a fenced
	// ```json body showed as raw backticks. It now reads as rendered text
	// (fences → <pre>, the shared lib/cards/readiedBrief segmenter the card
	// detail page uses; text interpolation only, never {@html}) until the user
	// asks to edit. The save path below is unchanged.
	let descEditing = $state(false);

	// UI review 2026-10-07: the AA card payload (GET /api/cards/:id) for the
	// open card. The Planka detail in the store carries no custom-field groups,
	// and those are the card's OWN bindings (Decisions) and its
	// server-gated fr project id (`fr_project_id`). Before this, "Related" listed EVERY
	// tenant decision — its `card_id` filter is ignored upstream
	// (backend/src/integrations/decisions.ts) — and the reasoning trees were
	// queried with the PLANKA project id, which fr's TOC store never holds.
	let aaCard = $state<CardDetail | null>(null);
	let aaCardState = $state<'loading' | 'ok' | 'failed'>('loading');
	let aaSeq = 0;
	// A derived primitive, so the optimistic `selectedCard` reassignment on
	// every edit does not refetch — only opening a different card does.
	const selectedId = $derived(kanbanStore.selectedCard?.card.id ?? null);
	$effect(() => {
		const id = selectedId;
		const seq = ++aaSeq;
		aaCard = null;
		if (!id) return;
		aaCardState = 'loading';
		void (async () => {
			try {
				const res = await authFetch(`/api/cards/${encodeURIComponent(id)}`);
				if (seq !== aaSeq) return;
				if (!res.ok) {
					aaCardState = 'failed';
					return;
				}
				const body = (await res.json()) as CardDetail;
				if (seq !== aaSeq) return;
				aaCard = body;
				aaCardState = 'ok';
			} catch {
				if (seq === aaSeq) aaCardState = 'failed';
			}
		})();
	});

	function boundRows(group: Record<string, string> | undefined): Array<{ slot: string; value: string }> {
		return Object.entries(group ?? {})
			.filter(([, v]) => typeof v === 'string' && v.trim() !== '')
			.map(([slot, v]) => ({ slot, value: v.trim() }));
	}

	// The fr project id — never the Planka one, and never the editable
	// Metadata.project_id: only the server-gated `fr_project_id`, which
	// GET /api/cards/:id sets only when the caller can read that project (the
	// same rule as GET /api/projects/:id). A peer who cannot read it gets null,
	// so no project-library link and no project TOC query. No fallback to the
	// header's active project: that can be a DIFFERENT project than this card's.
	const frProjectId = $derived(aaCard?.fr_project_id?.trim() || null);
	const linkedGroups = $derived([
		{
			key: 'decisions',
			label: 'Linked Decisions',
			base: '/decisions',
			rows: boundRows(aaCard?.groups?.Decisions),
		},
	]);

	// A draft belongs to the USER from the first keystroke until it is saved or a
	// different card is opened. These flags record that, per field.
	//
	// Why an explicit flag and not "the draft no longer equals what I seeded":
	// `updateCard` is OPTIMISTIC, so while the request is in flight the store's
	// card already HOLDS the typed value — an inferred-dirty check reads the
	// field as clean at that moment, updates its seed, and then the ROLLBACK
	// looks like a legitimate remote change and overwrites the user's text. That
	// version was written, and was measured failing. Dirtiness has to be recorded at the keystroke, where it is a fact.
	let nameDirty = false;
	let descDirty = false;
	let dueDirty = false;
	let seededCardId: string | null = null;

	// Seed draft state from the selectedCard.
	//
	// A failed updateCard rolls the store back to the pre-edit card (kanbanStore
	// updateCard's catch reassigns `selectedCard`), which re-runs this effect. A
	// blind re-seed then deletes what the user typed — and for the 700 ms
	// debounced description autosave that happens with no user action at all, so
	// the text disappears while they are still looking at it.
	//
	// Clean fields still track the store, which is how a websocket edit from
	// another user lands in a field nobody is typing into.
	$effect(() => {
		const c = kanbanStore.selectedCard?.card;
		const id = c?.id ?? null;
		const name = c?.name ?? '';
		const desc = c?.description ?? '';
		const due = c?.dueDate ? c.dueDate.slice(0, 10) : '';
		if (id !== seededCardId) {
			// A different card (or none) — its own values win, unconditionally.
			// Anything half-typed belonged to the card that is no longer open.
			seededCardId = id;
			descEditing = false;
			nameDirty = false;
			descDirty = false;
			dueDirty = false;
		}
		if (!nameDirty) nameDraft = name;
		if (!descDirty) descDraft = desc;
		if (!dueDirty) dueDateDraft = due;
	});

	async function saveName() {
		const card = kanbanStore.selectedCard?.card;
		if (!card) return;
		const name = nameDraft.trim();
		if (!name || name === card.name) return;
		saving = true;
		try {
			await kanbanStore.updateCard(card.id, { name });
			// Saved — the field is the server's again, unless the user typed
			// something NEWER while the request was in flight.
			if (nameDraft.trim() === name) nameDirty = false;
		} catch (e) {
			// Stays dirty on purpose: the typed text is all the user has left.
			reportMutationFailure('rename the card', e);
		} finally {
			saving = false;
		}
	}

	function scheduleDescSave() {
		if (descTimer) clearTimeout(descTimer);
		descTimer = setTimeout(() => {
			void saveDescription();
		}, 700);
	}

	async function saveDescription() {
		const card = kanbanStore.selectedCard?.card;
		if (!card) return;
		const next = descDraft;
		if ((card.description ?? '') === next) return;
		saving = true;
		try {
			await kanbanStore.updateCard(card.id, { description: next });
			if (descDraft === next) descDirty = false;
		} catch (e) {
			// The autosave also fires on blur, so this can fail with no click of
			// the user's behind it — the toast is the only signal they get. The
			// typed text survives via `descDirty` on the seeding effect.
			reportMutationFailure('save the description', e);
		} finally {
			saving = false;
		}
	}

	async function saveDueDate() {
		const card = kanbanStore.selectedCard?.card;
		if (!card) return;
		const next = dueDateDraft ? new Date(dueDateDraft + 'T00:00:00Z').toISOString() : null;
		if ((card.dueDate ?? null) === next) return;
		const typed = dueDateDraft;
		saving = true;
		try {
			await kanbanStore.updateCard(card.id, { dueDate: next });
			if (dueDateDraft === typed) dueDirty = false;
		} catch (e) {
			reportMutationFailure('set the due date', e);
		} finally {
			saving = false;
		}
	}

	async function duplicate() {
		if (duplicating) return;
		const card = kanbanStore.selectedCard?.card;
		if (!card) return;
		duplicating = true;
		try {
			await kanbanStore.duplicateCard(card.id);
		} catch (e) {
			reportMutationFailure('duplicate the card', e);
		} finally {
			duplicating = false;
		}
	}

	async function closeCard() {
		if (closing) return;
		const card = kanbanStore.selectedCard?.card;
		if (!card) return;
		closing = true;
		try {
			await kanbanStore.updateCard(card.id, { isClosed: true });
		} catch (e) {
			reportMutationFailure('close the card', e);
		} finally {
			closing = false;
		}
	}

	async function removeCard() {
		if (deleting) return;
		const card = kanbanStore.selectedCard?.card;
		if (!card) return;
		if (!confirm(`Delete card "${card.name}"?`)) return;
		deleting = true;
		try {
			await kanbanStore.deleteCard(card.id);
			onClose();
		} catch (e) {
			reportMutationFailure('delete the card', e);
		} finally {
			deleting = false;
		}
	}

	function isPast(d: string | null): boolean {
		return d ? new Date(d) < new Date() : false;
	}
</script>

{#if kanbanStore.selectedCard}
	{@const detail = kanbanStore.selectedCard}
	{@const card = detail.card}
	<!-- Backdrop -->
	<button class="fixed inset-0 bg-[var(--color-bg)]/30 z-40" onclick={onClose} aria-label="Close"></button>

	<!-- Panel -->
	<div
		class="fixed right-0 top-0 h-full w-full max-w-2xl bg-[var(--color-bg)] shadow-xl z-50 flex flex-col overflow-hidden dark:bg-[var(--color-surface)]"
		data-testid="card-modal"
	>
		<div class="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)] flex-shrink-0 dark:border-[var(--color-border)]">
			<input
				class="text-lg font-semibold text-[var(--color-text)] flex-1 px-2 py-1 rounded border border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none dark:text-[var(--color-text)]"
				value={nameDraft}
				oninput={(e) => {
					nameDraft = (e.target as HTMLInputElement).value;
					nameDirty = true;
				}}
				onblur={saveName}
				onkeydown={(e) => {
					if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
				}}
				data-testid="card-name-input"
			/>
			<div class="flex items-center gap-2 ml-3">
				{#if saving}
					<span class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Saving…</span>
				{/if}
				<a
					href={`/cards/${encodeURIComponent(card.id)}`}
					class="px-2 py-1 text-xs rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]"
					title="Open the AA card-detail view (5D · phase · protocol)"
					data-testid="card-modal-open-detail"
				>
					Open detail →
				</a>
				<button
					onclick={onClose}
					class="p-1 rounded-lg hover:bg-[var(--color-surface)] text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)] dark:text-[var(--color-text-muted)]"
					aria-label="Close"
				>
					<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</button>
			</div>
		</div>

		<div class="flex-1 overflow-y-auto px-6 py-4 space-y-6">
			<!-- Meta row: labels + due date (members/checklists are edited in Planka) -->
			<div class="flex flex-wrap items-start gap-6">
				<div>
					<h3 class="text-xs font-semibold text-[var(--color-text-muted)] uppercase mb-2 dark:text-[var(--color-text-muted)]">Labels</h3>
					<LabelPicker cardId={card.id} attachedLabels={card.labels} />
				</div>
				<div>
					<h3 class="text-xs font-semibold text-[var(--color-text-muted)] uppercase mb-2 dark:text-[var(--color-text-muted)]">Due Date</h3>
					<input
						type="date"
						class="text-sm px-2 py-1 border border-[var(--color-border-strong)] rounded {isPast(card.dueDate)
							? 'text-[var(--color-danger)] border-[var(--color-danger-border)]'
							: ''} dark:border-[var(--color-border-strong)]"
						value={dueDateDraft}
						oninput={(e) => {
							dueDateDraft = (e.target as HTMLInputElement).value;
							dueDirty = true;
						}}
						onblur={saveDueDate}
						data-testid="card-due-date"
					/>
				</div>
			</div>

			<!-- Description -->
			<div>
				<div class="flex items-center justify-between mb-2">
					<h3 class="text-xs font-semibold text-[var(--color-text-muted)] uppercase dark:text-[var(--color-text-muted)]">Description</h3>
					{#if descEditing}
						<button
							type="button"
							class="text-xs text-[var(--color-accent)] hover:underline"
							onclick={() => {
								descEditing = false;
								void saveDescription();
							}}
							data-testid="card-description-done"
						>
							Done
						</button>
					{:else}
						<button
							type="button"
							class="text-xs text-[var(--color-accent)] hover:underline"
							onclick={() => (descEditing = true)}
							data-testid="card-description-edit"
						>
							Edit
						</button>
					{/if}
				</div>
				{#if descEditing}
					<textarea
						class="w-full px-3 py-2 text-sm border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] focus:bg-[var(--color-bg)] focus:border-[var(--color-accent)] focus:outline-none resize-y dark:border-[var(--color-border)] dark:bg-[var(--color-bg)]"
						rows="8"
						placeholder="Add a description…"
						value={descDraft}
						oninput={(e) => {
							descDraft = (e.target as HTMLTextAreaElement).value;
							descDirty = true;
							scheduleDescSave();
						}}
						onblur={saveDescription}
						data-testid="card-description"
					></textarea>
				{:else}
					{@const parts = descriptionSegments(stripReadiedBrief(descDraft))}
					<div class="space-y-2" data-testid="card-description-view">
						{#if parts.length === 0}
							<p class="text-sm text-[var(--color-text-muted)] italic">No description.</p>
						{/if}
						{#each parts as part, i (i)}
							{#if part.type === 'code'}
								<pre class="text-xs font-mono overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"><code>{part.content}</code></pre>
							{:else}
								<p class="text-sm text-[var(--color-text)] whitespace-pre-wrap break-words">{part.content}</p>
							{/if}
						{/each}
						{#if parseReadiedBrief(descDraft)}
							<p class="text-xs text-[var(--color-text-muted)]">
								This card carries a readied brief —
								<a href={`/cards/${encodeURIComponent(card.id)}`} class="text-[var(--color-accent)] hover:underline">open the detail view</a>
								to read it.
							</p>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Comments -->
			<div>
				<h3 class="text-xs font-semibold text-[var(--color-text-muted)] uppercase mb-2 dark:text-[var(--color-text-muted)]">
					Comments ({detail.comments.length})
				</h3>
				<CommentList cardId={card.id} comments={detail.comments} />
			</div>

			<!--
				Linked decisions — the card's OWN bindings (custom-field
				group Decisions, the same source FiveDPanel reads on
				the detail page). UI review 2026-10-07: this used to be RelatedAssets
				with `filter={{ card_id }}`, which the backend ignores, so it listed
				every decision in the tenant.
			-->
			<div data-testid="card-linked-assets">
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					{#each linkedGroups as g (g.key)}
						<div data-testid="card-linked-{g.key}">
							<h3 class="text-xs font-semibold text-[var(--color-text-muted)] uppercase mb-2 dark:text-[var(--color-text-muted)]">{g.label}</h3>
							{#if aaCardState === 'loading'}
								<p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
							{:else if aaCardState === 'failed'}
								<p class="text-xs text-[var(--color-text-muted)] italic">
									Couldn't read this card's bindings — unknown, not empty.
								</p>
							{:else if g.rows.length === 0}
								<p class="text-xs text-[var(--color-text-muted)] italic" data-testid="card-linked-{g.key}-none">
									None bound to this card.
								</p>
								{#if frProjectId}
									<a
										href={`/projects/${encodeURIComponent(frProjectId)}/library/${g.key}`}
										class="text-xs text-[var(--color-accent)] hover:underline"
										data-testid="card-linked-{g.key}-browse"
									>
										Browse project {g.key} →
									</a>
								{/if}
							{:else}
								<ul class="space-y-1">
									{#each g.rows as row (row.slot)}
										<li class="text-sm truncate">
											<a
												href={`${g.base}/${encodeURIComponent(row.value)}`}
												class="text-[var(--color-accent)] hover:underline"
												title={row.slot}
											>
												{row.value}
											</a>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			<!--
				TOC / Reasoning — the project's Theory-of-Constraints reasoning
				trees (IO-Maps, evaporating clouds, logic trees) + CLR scores.
				UI review 2026-10-07: keyed on the FR project id (the card's
				server-gated `fr_project_id`, null when the caller cannot read
				the project) — it used to pass the PLANKA project id
				(kanbanStore.board.board.projectId), which matches no TOC tree.
				Section self-hides when no fr project id is known.
			-->
			<CardTocSection projectId={frProjectId} />
		</div>

		<!-- Footer actions -->
		<div class="flex items-center gap-2 border-t border-[var(--color-border)] px-6 py-3 flex-shrink-0 dark:border-[var(--color-border)]">
			<button
				class="px-3 py-1 text-sm bg-[var(--color-surface)] hover:bg-[var(--color-surface-strong)] rounded dark:bg-[var(--color-surface)] dark:hover:bg-[var(--color-surface-strong)] disabled:opacity-50 disabled:cursor-not-allowed"
				onclick={duplicate}
				disabled={duplicating}
				data-testid="card-duplicate"
			>
				Duplicate
			</button>
			{#if !card.isClosed}
				<button
					class="px-3 py-1 text-sm bg-[var(--color-surface)] hover:bg-[var(--color-surface-strong)] rounded dark:bg-[var(--color-surface)] dark:hover:bg-[var(--color-surface-strong)] disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={closeCard}
					disabled={closing}
					data-testid="card-close"
				>
					Close card
				</button>
			{/if}
			<button
				class="px-3 py-1 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] rounded disabled:opacity-50 disabled:cursor-not-allowed"
				onclick={removeCard}
				disabled={deleting}
				data-testid="card-delete"
			>
				Delete
			</button>
			<div class="flex-1"></div>
			<button class="px-3 py-1 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface)] rounded dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]" onclick={onClose}>
				Close
			</button>
		</div>
	</div>
{/if}
