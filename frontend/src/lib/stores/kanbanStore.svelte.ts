// src/lib/stores/kanbanStore.svelte.ts
// Reactive store backing the /kanban UI. Holds the currently selected board +
// card, tracks optimistic mutations, and merges realtime KanbanEvents from the
// websocket into local state. Writes are limited to the conveyor operations
// fr's kanban proxy keeps (George 2026-10-10): card create/update/move/
// duplicate/delete, comment create, and attach/detach of an EXISTING board
// label. Lists, labels, checklists and members are edited in Planka itself.
//
// Design notes
// ------------
// - Uses Svelte 5 runes ($state) on a singleton class instance. Consumers
//   read fields like `kanbanStore.board` directly inside markup.
// - Action methods are optimistic: we apply the server's eventual response
//   to the store on success and roll back on failure. The WebSocket
//   channel is the authoritative source for changes from other clients.
// - To avoid double-applying our own mutations when the server echoes a
//   kanban:* event, we de-duplicate by entity id (card/list/etc). The
//   optimistic temp IDs are replaced with server IDs on the HTTP response.

import { apiClient } from '$lib/api/unified-client';
import { auth } from '$lib/stores/auth.svelte';
import { KanbanSocket, type KanbanEvent } from '$lib/ws/kanbanSocket';
import type {
  PlankaBoardDetail,
  PlankaCardDetail,
  PlankaCard,
  PlankaComment,
  PlankaCreateCardBody,
  PlankaUpdateCardBody,
  PlankaCreateCommentBody,
} from '$lib/types/api';

// --- helpers ---------------------------------------------------------------

let tempIdCounter = 0;
const TEMP_PREFIX = '__tmp__';
const tempId = (hint: string): string => `${TEMP_PREFIX}${hint}-${++tempIdCounter}`;
const isTempId = (id: string | undefined | null): boolean =>
  typeof id === 'string' && id.startsWith(TEMP_PREFIX);

function byPosition<T extends { position?: number }>(a: T, b: T): number {
  return (a.position ?? 0) - (b.position ?? 0);
}

// Cards arriving from POST responses + WS events (raw Planka entities) often
// omit the labels / memberIds arrays that the enriched GET path adds. Render
// code reads `.length` on those arrays — pad to [] to keep the UI defensive.
function padCard(card: PlankaCard): PlankaCard {
  return {
    ...card,
    labels: card.labels ?? [],
    memberIds: card.memberIds ?? [],
  };
}

// Remote-touch tombstone kinds. One map, keyed by `${kind}:${id}`, so every
// rollback consults the SAME mechanism instead of each growing its own.
//  - card:removed — a remote card_deleted
//  - card:changed — a remote card_moved / card_updated
type WsTouchKind = 'card:removed' | 'card:changed';

// Tombstones are only consulted for the lifetime of one in-flight request, so a
// bounded map is fine — but eviction must drop the OLDEST entries only. A
// wholesale `.clear()` throws away tombstones written milliseconds ago, which is
// exactly the set an in-flight rollback is about to read.
const WS_TOUCH_CAP = 1000;
const WS_TOUCH_KEEP = 500;

// --- store -----------------------------------------------------------------

export class KanbanStore {
  // Public reactive state
  board = $state<PlankaBoardDetail | null>(null);
  selectedCard = $state<PlankaCardDetail | null>(null);
  boardLoading = $state(false);
  cardLoading = $state(false);
  error = $state<string | null>(null);
  // R2/B3: set when the board id is stale — deleted in Planka but still
  // advertised by an fr.projects/streams row. The UI shows a "no longer exists"
  // empty state instead of a generic error.
  boardStale = $state(false);
  selectError = $state<string | null>(null);
  mentionedMeCommentIds = $state<Set<string>>(new Set());
  private readonly api = apiClient.kanban;
  private socket: KanbanSocket | null = null;
  private socketUnsub: (() => void) | null = null;
  private subscribedBoardId: string | null = null;
  private subscribedCardId: string | null = null;
  // Monotonic seq for selectCard. Bumped on every entry; each in-flight call
  // captures its seq and bails out post-await if a newer call has superseded
  // it. Prevents stale getCard() responses from clobbering newer selections
  // when the user clicks rapidly between cards. Plain field (not $state) —
  // never read from markup.
  private selectCardSeq = 0;
  // Same idiom for loadBoard: a board switch (or a tenant switch) while an
  // older getBoard() is in flight must not let the stale board land, nor
  // re-point subscribedBoardId at it.
  private loadSeq = 0;
  // Monotonic seq bumped on every inbound WS event, plus the seq at which each
  // entity was last touched by a REMOTE event. Optimistic rollbacks capture the
  // seq at entry and refuse to undo anything the WS layer changed since.
  //
  // WHY a `!cards.some(c => c.id === id)` guard alone cannot do this job: the
  // local optimistic path ALREADY removed the card before awaiting, so the
  // remote card_deleted reducer's filter is a silent no-op. The id is absent
  // from the array whether or not a remote delete arrived — presence simply
  // cannot distinguish the two cases, and the rollback would resurrect a card
  // another client legitimately deleted. The `.some()` checks are still kept
  // as dupe guards (a WS card_created may have re-inserted the id).
  // Plain fields (not $state) — never read from markup.
  private wsEventSeq = 0;
  private wsTouchedAt = new Map<string, number>();

  private markWsTouched(kind: WsTouchKind, id: string): void {
    const key = `${kind}:${id}`;
    // Delete-then-set so Map iteration order stays oldest-first by RECENCY.
    this.wsTouchedAt.delete(key);
    this.wsTouchedAt.set(key, this.wsEventSeq);
    if (this.wsTouchedAt.size > WS_TOUCH_CAP) {
      const drop = this.wsTouchedAt.size - WS_TOUCH_KEEP;
      const stale: string[] = [];
      for (const k of this.wsTouchedAt.keys()) {
        if (stale.length >= drop) break;
        stale.push(k);
      }
      for (const k of stale) this.wsTouchedAt.delete(k);
    }
  }

  private touchedSince(kind: WsTouchKind, id: string, sinceSeq: number): boolean {
    return (this.wsTouchedAt.get(`${kind}:${id}`) ?? -1) > sinceSeq;
  }

  /** True if a remote WS card_deleted removed `cardId` after `sinceSeq`. */
  private cardRemovedRemotelySince(cardId: string, sinceSeq: number): boolean {
    return this.touchedSince('card:removed', cardId, sinceSeq);
  }

  /**
   * Re-sort one list's cards by `position`, leaving every other list's cards in
   * their existing array slots.
   *
   * Array order IS load-bearing: `components/kanban/cardMoves.ts` derives
   * `priorIndex` from the order of `board.cards`, while `BoardView.svelte`
   * renders each lane sorted by `position`. If the two disagree,
   * `computeCardMoves` reports cards as "shifted" that never moved and the next
   * drop fires a spurious moveCard per card — the exact multi-request bug
   * cardMoves.ts exists to prevent. Every rollback that re-inserts a card ends
   * by calling this so the two views cannot diverge.
   */
  private sortListCardsByPosition(listId: string): void {
    if (!this.board) return;
    const cards = this.board.cards;
    const slots: number[] = [];
    for (let i = 0; i < cards.length; i += 1) {
      if (cards[i].listId === listId) slots.push(i);
    }
    if (slots.length < 2) return;
    // Array.prototype.sort is stable, so equal positions keep their prior order.
    const ordered = slots.map((i) => cards[i]).sort(byPosition);
    const next = cards.slice();
    slots.forEach((slot, k) => {
      next[slot] = ordered[k];
    });
    this.board.cards = next;
  }

  // fr row 14d-0b: the socket's active tenant is the persisted workspace
  // switch, else the user's own (home) tenant — the same value HTTP resolves.
  private newSocket(): KanbanSocket {
    return new KanbanSocket({
      getActiveTenant: () => {
        try {
          const persisted =
            typeof localStorage === 'undefined'
              ? null
              : localStorage.getItem('fr.active_tenant');
          if (persisted) return persisted;
        } catch {
          // storage unavailable — fall through to the home tenant
        }
        return auth.user?.tenant_id || undefined;
      },
    });
  }

  // ---------------- Board lifecycle ---------------------------------------

  async loadBoard(boardId: string): Promise<void> {
    const mySeq = ++this.loadSeq;
    this.boardLoading = true;
    this.error = null;
    this.boardStale = false;
    // Drop the currently-rendered board BEFORE awaiting.
    //
    // Every consumer renders lists+cards behind `{#if kanbanStore.board}` and
    // shows the board NAME from its own selector state. On a board switch the
    // selector flips to board B immediately, and if this load fails
    // `boardLoading` goes back to false with `this.board` still holding board
    // A — so the page draws board A's lists and cards under board B's name.
    // Nulling here makes a half-finished switch unrenderable instead of wrong.
    //
    // No flash-of-empty on first load (board is already null), and on a reload
    // of the SAME board every consumer's `boardLoading` arm precedes its
    // `board` arm, so the gap renders as the existing spinner.
    this.board = null;
    try {
      const board = await this.api.getBoard(boardId);
      // Superseded by a newer loadBoard() or a tenant switch — drop it.
      if (this.loadSeq !== mySeq) return;
      this.board = board;
      // Unsubscribe old, subscribe new
      if (this.socket && this.subscribedBoardId && this.subscribedBoardId !== boardId) {
        this.socket.unsubscribeBoard(this.subscribedBoardId);
      }
      this.subscribedBoardId = boardId;
      if (this.socket) {
        this.socket.subscribeBoard(boardId);
      }
    } catch (err) {
      // A superseded load's failure is not the current board's failure.
      if (this.loadSeq !== mySeq) return;
      // Stale board id (deleted in Planka) — surfaced by the backend as a typed
      // 404 `code: 'board_deleted_upstream'`. Render a dedicated empty state.
      if ((err as { data?: { code?: string } })?.data?.code === 'board_deleted_upstream') {
        this.boardStale = true;
        this.error = 'This board no longer exists.';
        return;
      }
      this.error = err instanceof Error ? err.message : 'Failed to load board';
      throw err;
    } finally {
      // Only the current call owns the loading flag.
      if (this.loadSeq === mySeq) this.boardLoading = false;
    }
  }

  // ---------------- WS lifecycle -----------------------------------------

  openSocket(): void {
    if (this.socket) return;
    const token = auth.getToken();
    if (!token) {
      console.warn('[kanban-store] no auth token, skipping WS open');
      return;
    }
    this.socket = this.newSocket();
    // Read a FRESH token at every (re)connect — never the one captured here.
    this.socket.connect(() => auth.ensureFreshToken());
    this.socketUnsub = this.socket.onEvent((ev) => this.dispatchEvent(ev));
    if (this.subscribedBoardId) {
      this.socket.subscribeBoard(this.subscribedBoardId);
    }
    if (this.subscribedCardId) {
      this.socket.subscribeCard(this.subscribedCardId);
    }
  }

  closeSocket(): void {
    if (this.socketUnsub) {
      this.socketUnsub();
      this.socketUnsub = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  /**
   * Tear down all tenant-scoped state on a tenant switch. The currently-loaded
   * board/card ids belong to the OLD tenant and won't exist in the new one, and
   * the WS carries the old tenant's board/card topic subscriptions — so close
   * the socket and null everything out. A fresh socket + board load happen when
   * the user next lands on `/kanban` (its `onMount` calls `openSocket()`).
   */
  resetForTenantSwitch(): void {
    // Invalidate every in-flight load: an old-tenant getBoard()/getCard()
    // resolving after this must not repopulate state or subscriptions.
    this.loadSeq++;
    this.selectCardSeq++;
    this.closeSocket();
    this.board = null;
    this.selectedCard = null;
    this.error = null;
    this.selectError = null;
    this.boardLoading = false;
    this.cardLoading = false;
    this.mentionedMeCommentIds = new Set();
    this.subscribedBoardId = null;
    this.subscribedCardId = null;
  }

  // ---------------- Card detail ------------------------------------------

  async selectCard(cardId: string): Promise<void> {
    const mySeq = ++this.selectCardSeq;
    this.cardLoading = true;
    this.error = null;
    this.selectError = null;
    try {
      const detail = await this.api.getCard(cardId);
      // A newer selectCard() has been issued while our fetch was in flight —
      // bail out without writing stale state. Don't touch cardLoading; the
      // newer call owns it.
      if (this.selectCardSeq !== mySeq) return;
      this.selectedCard = detail;
      if (this.subscribedCardId && this.subscribedCardId !== cardId && this.socket) {
        this.socket.unsubscribeCard(this.subscribedCardId);
      }
      this.subscribedCardId = cardId;
      if (this.socket) {
        this.socket.subscribeCard(cardId);
      }
      // Clear the "mentioned you" badges for this card's comments — the user
      // has seen them by opening the card.
      if (this.mentionedMeCommentIds.size > 0) {
        const next = new Set(this.mentionedMeCommentIds);
        for (const c of detail.comments) next.delete(c.id);
        if (next.size !== this.mentionedMeCommentIds.size) {
          this.mentionedMeCommentIds = next;
        }
      }
    } catch (err) {
      // Only the current call should surface its error; stale failures are
      // silently dropped (the newer call will report its own outcome).
      if (this.selectCardSeq !== mySeq) return;
      this.error = err instanceof Error ? err.message : 'Failed to load card';
      throw err;
    } finally {
      // Only the current call clears the loading flag; stale calls leave it
      // alone so the active fetch's spinner stays up.
      if (this.selectCardSeq === mySeq) {
        this.cardLoading = false;
      }
    }
  }

  closeSelectedCard(): void {
    if (this.subscribedCardId && this.socket) {
      this.socket.unsubscribeCard(this.subscribedCardId);
    }
    this.subscribedCardId = null;
    this.selectedCard = null;
  }

  // ---------------- Card actions -----------------------------------------

  async createCard(listId: string, body: PlankaCreateCardBody): Promise<PlankaCard> {
    if (!this.board) throw new Error('No board loaded');
    const tmp: PlankaCard = {
      id: tempId('card'),
      name: body.name,
      description: body.description ?? null,
      listId,
      boardId: this.board.board.id,
      position: body.position ?? Number.MAX_SAFE_INTEGER,
      dueDate: body.dueDate ?? null,
      stopwatch: null,
      labels: [],
      memberIds: [],
    };
    this.board.cards = [...this.board.cards, tmp];

    try {
      const created = await this.api.createCard(listId, body);
      this.replaceCardById(tmp.id, created);
      return created;
    } catch (err) {
      this.board.cards = this.board.cards.filter((c) => c.id !== tmp.id);
      throw err;
    }
  }

  async updateCard(cardId: string, patch: PlankaUpdateCardBody): Promise<PlankaCard> {
    if (!this.board) throw new Error('No board loaded');
    const before = this.board.cards.find((c) => c.id === cardId);
    if (!before) throw new Error('Card not in current board');
    const optimistic: PlankaCard = { ...before, ...patch } as PlankaCard;
    this.board.cards = this.board.cards.map((c) => (c.id === cardId ? optimistic : c));
    if (this.selectedCard?.card.id === cardId) {
      this.selectedCard = { ...this.selectedCard, card: optimistic };
    }
    try {
      const updated = await this.api.updateCard(cardId, patch);
      this.replaceCardById(cardId, updated);
      return updated;
    } catch (err) {
      this.board.cards = this.board.cards.map((c) => (c.id === cardId ? before : c));
      if (this.selectedCard?.card.id === cardId) {
        this.selectedCard = { ...this.selectedCard, card: before };
      }
      throw err;
    }
  }

  async moveCard(cardId: string, params: { toListId: string; position: number }): Promise<void> {
    if (!this.board) throw new Error('No board loaded');
    const seqAtStart = this.wsEventSeq;
    const before = this.board.cards.find((c) => c.id === cardId);
    if (!before) throw new Error('Card not in current board');
    this.board.cards = this.board.cards.map((c) =>
      c.id === cardId ? { ...c, listId: params.toListId, position: params.position } : c,
    );
    try {
      const moved = await this.api.moveCard(cardId, {
        listId: params.toListId,
        position: params.position,
      });
      this.replaceCardById(cardId, moved);
    } catch (err) {
      // Surgical rollback: restore ONLY this card. Restoring a whole-array
      // snapshot would discard any WS event that landed mid-flight.
      //
      // And skip the restore entirely if the WS layer moved/updated/removed
      // this card since we started: a remote card_moved that landed mid-flight
      // is authoritative and newer than our `before` snapshot, so writing
      // `before` back would clobber it with state the server has already
      // superseded. Same tombstone mechanism the delete rollbacks use.
      const touched =
        this.touchedSince('card:changed', cardId, seqAtStart) ||
        this.cardRemovedRemotelySince(cardId, seqAtStart);
      if (!touched) {
        this.board.cards = this.board.cards.map((c) => (c.id === cardId ? before : c));
        this.sortListCardsByPosition(before.listId);
      }
      throw err;
    }
  }

  async deleteCard(cardId: string): Promise<void> {
    if (!this.board) throw new Error('No board loaded');
    const seqAtStart = this.wsEventSeq;
    const beforeIndex = this.board.cards.findIndex((c) => c.id === cardId);
    const before = beforeIndex === -1 ? undefined : this.board.cards[beforeIndex];
    // Stable restore key: the NEIGHBOUR that followed this card. A raw index is
    // wrong the moment a mid-flight WS event removes a card ahead of it.
    const nextSiblingId = beforeIndex === -1 ? undefined : this.board.cards[beforeIndex + 1]?.id;
    this.board.cards = this.board.cards.filter((c) => c.id !== cardId);
    if (this.selectedCard?.card.id === cardId) {
      this.closeSelectedCard();
    }
    try {
      await this.api.deleteCard(cardId);
    } catch (err) {
      // Re-insert ONLY this card — never a whole-array snapshot (that would
      // erase WS events from mid-flight). A concurrent remote card_deleted for
      // the same id WINS over the rollback.
      if (
        before &&
        !this.cardRemovedRemotelySince(cardId, seqAtStart) &&
        !this.board.cards.some((c) => c.id === cardId)
      ) {
        const anchor =
          nextSiblingId === undefined
            ? -1
            : this.board.cards.findIndex((c) => c.id === nextSiblingId);
        const idx = anchor === -1 ? this.board.cards.length : anchor;
        this.board.cards = [
          ...this.board.cards.slice(0, idx),
          before,
          ...this.board.cards.slice(idx),
        ];
        this.sortListCardsByPosition(before.listId);
      }
      throw err;
    }
  }

  async duplicateCard(cardId: string): Promise<PlankaCard> {
    const dup = await this.api.duplicateCard(cardId);
    if (this.board && dup.boardId === this.board.board.id) {
      // Avoid dupes if a WS event already inserted it.
      if (!this.board.cards.some((c) => c.id === dup.id)) {
        this.board.cards = [...this.board.cards, dup];
      }
    }
    return dup;
  }

  // ---------------- Comments ---------------------------------------------

  async createComment(cardId: string, text: string): Promise<PlankaComment> {
    if (!this.selectedCard || this.selectedCard.card.id !== cardId) {
      throw new Error('Card not open');
    }
    const body: PlankaCreateCommentBody = { text };
    const tmp: PlankaComment = {
      id: tempId('comment'),
      cardId,
      userId: auth.user?.id ?? 'me',
      text,
      createdAt: new Date().toISOString(),
    };
    this.selectedCard.comments = [...this.selectedCard.comments, tmp];
    try {
      const created = await this.api.createComment(cardId, body);
      // Card closed / switched while in flight — the comment WAS created
      // server-side, there is just no open card to reconcile it into.
      if (!this.stillOpen(cardId)) return created;
      // Same race as cards: WS comment_created may have inserted `created`
      // already. Drop any pre-existing copy of created.id, then swap temp.
      this.selectedCard!.comments = this.selectedCard!.comments
        .filter((c) => c.id !== created.id || c.id === tmp.id)
        .map((c) => (c.id === tmp.id ? created : c));
      return created;
    } catch (err) {
      // Roll back only if the card is still open; otherwise surface the
      // ORIGINAL error rather than a TypeError from the rollback itself.
      if (this.stillOpen(cardId)) {
        this.selectedCard!.comments = this.selectedCard!.comments.filter((c) => c.id !== tmp.id);
      }
      throw err;
    }
  }

  /**
   * Is the card that a mutation started against STILL the open one?
   *
   * Every selected-card mutation checks `selectedCard` before its await and then
   * writes `selectedCard.<field>` after it. `closeSelectedCard()` (and switching
   * cards) sets `selectedCard = null` in between, so without this re-check the
   * write throws `TypeError: Cannot read properties of null`. Same reasoning as
   * the `selectCardSeq` guard in `selectCard()`.
   *
   * When it returns false the mutation has still been applied SERVER-side; only
   * the local optimistic bookkeeping is skipped, because the card it described
   * is no longer on screen.
   */
  private stillOpen(cardId: string): boolean {
    return this.selectedCard?.card.id === cardId;
  }

  // ---------------- Labels -----------------------------------------------

  async attachLabel(cardId: string, labelId: string): Promise<void> {
    if (!this.board) throw new Error('No board loaded');
    const label = this.board.labels.find((l) => l.id === labelId);
    if (!label) throw new Error('Label not in current board');
    const before = this.board.cards.find((c) => c.id === cardId);
    if (!before) throw new Error('Card not in current board');
    const optimisticLabels = [...before.labels, label];
    this.board.cards = this.board.cards.map((c) =>
      c.id === cardId ? { ...c, labels: optimisticLabels } : c,
    );
    if (this.selectedCard?.card.id === cardId) {
      this.selectedCard = {
        ...this.selectedCard,
        card: { ...this.selectedCard.card, labels: optimisticLabels },
      };
    }
    try {
      await this.api.attachLabel(cardId, labelId);
    } catch (err) {
      this.board.cards = this.board.cards.map((c) =>
        c.id === cardId ? { ...c, labels: before.labels } : c,
      );
      if (this.selectedCard?.card.id === cardId) {
        this.selectedCard = {
          ...this.selectedCard,
          card: { ...this.selectedCard.card, labels: before.labels },
        };
      }
      throw err;
    }
  }

  async detachLabel(cardId: string, labelId: string): Promise<void> {
    if (!this.board) throw new Error('No board loaded');
    const before = this.board.cards.find((c) => c.id === cardId);
    if (!before) throw new Error('Card not in current board');
    const nextLabels = before.labels.filter((l) => l.id !== labelId);
    this.board.cards = this.board.cards.map((c) =>
      c.id === cardId ? { ...c, labels: nextLabels } : c,
    );
    if (this.selectedCard?.card.id === cardId) {
      this.selectedCard = {
        ...this.selectedCard,
        card: { ...this.selectedCard.card, labels: nextLabels },
      };
    }
    try {
      await this.api.detachLabel(cardId, labelId);
    } catch (err) {
      this.board.cards = this.board.cards.map((c) =>
        c.id === cardId ? { ...c, labels: before.labels } : c,
      );
      if (this.selectedCard?.card.id === cardId) {
        this.selectedCard = {
          ...this.selectedCard,
          card: { ...this.selectedCard.card, labels: before.labels },
        };
      }
      throw err;
    }
  }

  // ---------------- WS reducers ------------------------------------------

  private replaceCardById(oldId: string, next: PlankaCard): void {
    if (!this.board) return;
    const padded = padCard(next);
    // Race: a WS card_created event for `next.id` may have already been
    // dispatched, so the board may contain BOTH the optimistic temp card
    // (oldId) AND a real-id copy. Drop the duplicate first, then map the
    // temp slot to the merged real card.
    this.board.cards = this.board.cards
      .filter((c) => c.id !== padded.id || c.id === oldId)
      .map((c) => (c.id === oldId ? { ...c, ...padded } : c));
    if (this.selectedCard?.card.id === oldId) {
      this.selectedCard = {
        ...this.selectedCard,
        card: { ...this.selectedCard.card, ...padded },
      };
    }
  }

  /** Applies a single kanban:* event to local state. */
  private dispatchEvent(msg: KanbanEvent): void {
    const evt = msg.event as Record<string, unknown> & { kind?: string };
    const kind = evt.kind;
    this.wsEventSeq += 1;
    switch (kind) {
      case 'card_created': {
        const card = evt.card as PlankaCard | undefined;
        if (!card || !this.board) return;
        if (card.boardId !== this.board.board.id) return;
        if (this.board.cards.some((c) => c.id === card.id)) return; // already present
        this.board.cards = [...this.board.cards, padCard(card)];
        return;
      }
      case 'card_updated': {
        const card = evt.card as PlankaCard | undefined;
        if (!card || !this.board) return;
        const padded = padCard(card);
        this.markWsTouched('card:changed', card.id);
        if (this.board.cards.some((c) => c.id === card.id)) {
          this.board.cards = this.board.cards.map((c) =>
            c.id === card.id ? { ...c, ...padded } : c,
          );
        }
        if (this.selectedCard?.card.id === card.id) {
          this.selectedCard = {
            ...this.selectedCard,
            card: { ...this.selectedCard.card, ...padded },
          };
        }
        return;
      }
      case 'card_moved': {
        const card = evt.card as PlankaCard | undefined;
        const cardId = (evt.cardId as string | undefined) ?? card?.id;
        if (!cardId || !this.board) return;
        const toListId = (evt.toListId as string | undefined) ?? card?.listId;
        if (!toListId) return;
        // Tombstone the move so an in-flight optimistic moveCard's rollback
        // cannot clobber it with a snapshot the server has already superseded.
        this.markWsTouched('card:changed', cardId);
        this.board.cards = this.board.cards.map((c) =>
          c.id === cardId
            ? { ...c, listId: toListId, position: card?.position ?? c.position }
            : c,
        );
        return;
      }
      case 'card_deleted': {
        const cardId = evt.cardId as string | undefined;
        if (!cardId || !this.board) return;
        this.markWsTouched('card:removed', cardId);
        this.board.cards = this.board.cards.filter((c) => c.id !== cardId);
        if (this.selectedCard?.card.id === cardId) {
          this.closeSelectedCard();
        }
        return;
      }
      case 'label_attached':
      case 'label_detached': {
        const cardId = evt.cardId as string | undefined;
        const labelId = evt.labelId as string | undefined;
        if (!cardId || !labelId || !this.board) return;
        const label = this.board.labels.find((l) => l.id === labelId);
        this.board.cards = this.board.cards.map((c) => {
          if (c.id !== cardId) return c;
          if (kind === 'label_attached' && label) {
            if (c.labels.some((l) => l.id === labelId)) return c;
            return { ...c, labels: [...c.labels, label] };
          }
          return { ...c, labels: c.labels.filter((l) => l.id !== labelId) };
        });
        return;
      }
      case 'comment_created': {
        const comment = evt.comment as PlankaComment | undefined;
        if (!comment) return;
        if (this.selectedCard && this.selectedCard.card.id === comment.cardId) {
          const exists = this.selectedCard.comments.some((c) => c.id === comment.id);
          this.selectedCard.comments = exists
            ? this.selectedCard.comments.map((c) => (c.id === comment.id ? comment : c))
            : [...this.selectedCard.comments, comment];
        }
        return;
      }
      case 'comment_mentioned': {
        // Backend dispatches this as a distinct kind (see
        // backend/src/services/mentions/dispatcher.ts). If the current user is
        // in the mentionedUserIds list, flag the comment so CommentList can
        // render a "mentioned you" badge. Cleared when the card is opened.
        const commentId = evt.commentId as string | undefined;
        const mentioned = (evt.mentionedUserIds as string[] | undefined) ?? [];
        const me = auth.user?.id;
        if (!commentId || !me || !mentioned.includes(me)) return;
        const openedCardId = this.selectedCard?.card.id;
        const evtCardId = evt.cardId as string | undefined;
        // If the card is already open, don't badge — the user is looking at it.
        if (openedCardId && evtCardId === openedCardId) return;
        if (this.mentionedMeCommentIds.has(commentId)) return;
        const next = new Set(this.mentionedMeCommentIds);
        next.add(commentId);
        this.mentionedMeCommentIds = next;
        return;
      }
      default:
        // ignore unknown kinds — forward-compat
        return;
    }
  }
}

export const kanbanStore = new KanbanStore();
export { isTempId };
