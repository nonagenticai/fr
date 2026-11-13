// Shared "Move back to READY" action — used by the card detail BLOCKED band
// (BlockedGateSection) and the Needs-you queue's blocked rows.
//
// Reuses the EXISTING kanban endpoints (GET board for its lists, POST
// /api/kanban/cards/:id/move); no new backend surface. The READY list is
// resolved by NAME from the board at call time; a board with no READY list
// is reported, never guessed. The card lands at the bottom of READY.
import { apiClient } from '$lib/api/unified-client';
import { describeMutationFailure } from '$lib/components/kanban/mutationFeedback';

export const NO_READY_LIST_MESSAGE = 'This board has no READY list — open the board to move it.';

export type MoveToReadyResult = { ok: true; listId: string } | { ok: false; error: string };

/** Move `cardId` to the READY list of `boardId`. Never throws. */
export async function moveCardToReady(cardId: string, boardId: string): Promise<MoveToReadyResult> {
	try {
		const board = await apiClient.kanban.getBoard(boardId);
		const ready = board.lists.find((l) => l.name.trim().toUpperCase() === 'READY');
		if (!ready) return { ok: false, error: NO_READY_LIST_MESSAGE };
		const top = board.cards
			.filter((c) => c.listId === ready.id)
			.reduce((m, c) => Math.max(m, c.position), 0);
		await apiClient.kanban.moveCard(cardId, { listId: ready.id, position: top + 1000 });
		return { ok: true, listId: ready.id };
	} catch (e) {
		return { ok: false, error: describeMutationFailure('move the card back to READY', e) };
	}
}
