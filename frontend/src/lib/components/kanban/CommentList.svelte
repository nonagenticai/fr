<script lang="ts">
	import type { PlankaComment } from '$lib/types/api';
	import { kanbanStore } from '$lib/stores/kanbanStore.svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import { reportMutationFailure } from './mutationFeedback';
	import { shortId } from '$lib/utils/shortId';
	import { displayName } from '$lib/utils/displayName';
	import type { PlankaUser } from '$lib/types/api';

	type Props = {
		cardId: string;
		comments: PlankaComment[];
	};
	const { cardId, comments }: Props = $props();

	let draft = $state('');
	let sending = $state(false);

	async function send() {
		const text = draft.trim();
		if (!text || sending) return;
		sending = true;
		try {
			await kanbanStore.createComment(cardId, text);
			// `draft` is cleared INSIDE the try, after the await — a failed send
			// therefore already keeps the text. Leave that shape alone.
			draft = '';
		} catch (e) {
			reportMutationFailure('post the comment', e);
		} finally {
			sending = false;
		}
	}

	// UI review 2026-10-07: authors rendered as `…a1b2c3d4` id tails. The names
	// are already loaded — the card detail carries `users` and the board payload
	// carries `users`. Resolve from those; the id tail is the fallback only when
	// no source knows the user. Optional reads throughout: test stores leave
	// either of them absent.
	const usersById = $derived.by(() => {
		const m = new Map<string, PlankaUser>();
		const sources: Array<PlankaUser[] | null | undefined> = [
			kanbanStore.board?.users,
			kanbanStore.selectedCard?.users,
		];
		for (const list of sources) for (const u of list ?? []) m.set(u.id, u);
		return m;
	});

	function authorName(userId: string): string {
		const u = usersById.get(userId);
		return u ? displayName(u.name, displayName(u.username, shortId(userId))) : shortId(userId);
	}

	const sorted = $derived(
		[...comments].sort(
			(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
		)
	);
</script>

<div class="space-y-3" data-testid="comment-list-{cardId}">
	{#if sorted.length === 0}
		<p class="text-sm text-[var(--color-text-muted)] italic dark:text-[var(--color-text-muted)]">No comments yet</p>
	{/if}

	{#each sorted as comment (comment.id)}
		{@const mentionsMe = kanbanStore.mentionedMeCommentIds.has(comment.id)}
		<div
			class="rounded-lg p-3 {mentionsMe
				? 'bg-[var(--color-warning-bg)] border-l-4 border-[var(--color-warning-border)] dark:bg-[var(--color-warning-bg)]/20'
				: 'bg-[var(--color-surface)] dark:bg-[var(--color-bg)]'}"
			data-testid="comment-{comment.id}"
		>
			<div class="flex items-center justify-between mb-1">
				<span class="text-xs font-medium text-[var(--color-text)] flex items-center gap-2 dark:text-[var(--color-text-muted)]">
					<!--
						`shortId`, not the EntityRef component: this is the false arm of a ternary
						whose other arm is the literal 'You'. TAIL 8 (fr#1203/#1205) —
						two commenters provisioned in one batch shared a leading-8.
					-->
					<span title={comment.userId} data-testid="comment-author-{comment.id}"
						>{comment.userId === auth.user?.id ? 'You' : authorName(comment.userId)}</span
					>
					{#if mentionsMe}
						<span
							class="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] rounded"
							data-testid="mention-badge-{comment.id}"
						>
							mentioned you
						</span>
					{/if}
				</span>
				<span class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
					{new Date(comment.createdAt).toLocaleDateString('en-US', {
						month: 'short',
						day: 'numeric',
						hour: '2-digit',
						minute: '2-digit'
					})}
				</span>
			</div>
			<p class="text-sm text-[var(--color-text)] whitespace-pre-wrap dark:text-[var(--color-text-muted)]">{comment.text}</p>
		</div>
	{/each}

	<!-- Composer -->
	<div class="border-t border-[var(--color-border)] pt-3 dark:border-[var(--color-border)]">
		<textarea
			class="w-full px-3 py-2 text-sm border border-[var(--color-border-strong)] rounded resize-none dark:border-[var(--color-border-strong)]"
			rows="2"
			placeholder="Add a comment…"
			value={draft}
			oninput={(e) => (draft = (e.target as HTMLTextAreaElement).value)}
			onkeydown={(e) => {
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					send();
				}
			}}
			data-testid="comment-input-{cardId}"
		></textarea>
		<div class="flex items-center justify-between mt-2">
			<span class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Cmd/Ctrl+Enter to send</span>
			<button
				class="px-3 py-1 text-sm bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded hover:bg-[var(--color-accent-strong)] disabled:opacity-50"
				onclick={send}
				disabled={sending || draft.trim().length === 0}
				data-testid="comment-send-{cardId}">{sending ? 'Sending…' : 'Send'}</button
			>
		</div>
	</div>
</div>
