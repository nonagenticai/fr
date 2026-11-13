/**
 * Plan 3 — Threads store.
 *
 * Lists user's threads from `/api/agui/threads`, owns the active-thread
 * selection + the in-memory message buffer the chat surface renders.
 *
 * Streaming: `sendMessage(text)` opens an NDJSON stream, appends events to
 * the active thread's local message buffer as they arrive, persists
 * server-side via the agent loop's appendMessage path. Local state is the
 * source of truth for the active turn; on `done`, the next thread reload
 * (or page refresh) resyncs from the server.
 */

import { agentSession } from './agentSession.svelte';
import { chatStream, endUserHeaders } from '../agui/agentClient';
import type { AgentChatEvent } from '../agui/types';
import { HttpStreamError } from '../agui/streamClient';
import { fetchWithBudget, BudgetExceededError } from '$lib/net/fetchWithBudget';
import { raiseInvalidate } from '$lib/agent/invalidation';
import { checkUiIntent, intentChipLabel } from '$lib/agent/ui-intent';

const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const TRANSIENT_MESSAGE_RE = /Server disconnected|network|ECONN|fetch failed/i;
const RETRY_BACKOFF_MS = 800;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isTransient(err: unknown): boolean {
  if (err instanceof HttpStreamError) return TRANSIENT_STATUSES.has(err.status);
  if (err instanceof Error) return TRANSIENT_MESSAGE_RE.test(err.message);
  return false;
}

export interface ThreadSummary {
  id: string;
  channel: string;
  threadId: string;
  workerName: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  /**
   * The fr project the thread is bound to, or null. Absent from an older
   * backend — treated as UNKNOWN (no redirect), never as "no project".
   */
  projectId?: string | null;
}

export interface ThreadDetail extends ThreadSummary {
  messages: ConversationMessage[];
}

export type ConversationMessage =
  | { role: 'user'; content: string; ts: string }
  | { role: 'assistant'; content: string; ts: string }
  | {
      role: 'tool';
      action: string;
      callId: string;
      output: unknown;
      status: 'success' | 'failed' | 'pending' | 'proposal';
      ts: string;
    };

/**
 * Renderable item in the chat. Wraps either a stored `ConversationMessage`
 * or a live tool-call card that hasn't been persisted yet.
 */
export type ChatItem =
  | { kind: 'message'; message: ConversationMessage }
  | {
      kind: 'tool-call';
      callId: string;
      action: string;
      input: unknown;
      status: 'running' | 'success' | 'failed' | 'pending' | 'proposal';
      output?: unknown;
      error?: string;
    }
  /**
   * fr-agui SPEC §5.4: a navigation the agent asked for — shown as a chip
   * ("Opened Board"), or, when the browser refused it, the refusal.
   */
  | { kind: 'intent'; callId: string; route: string; ok: boolean; label: string; reason?: string };

class ThreadsState {
  threads = $state<ThreadSummary[]>([]);
  activeThreadId = $state<string | null>(null);
  /** Renderable items for the active thread. */
  items = $state<ChatItem[]>([]);
  /** True while the agent loop is streaming. */
  streaming = $state(false);
  /** Last loop error (if any) for display. */
  lastError = $state<string | null>(null);
  /**
   * Text to restore into ChatInput after a retry-exhausted transient send
   * failure. ChatInput reads this in a `$effect` and clears it after
   * applying. Cursor / Claude.ai style — see
   * `feedback-fr-thread-stream-retry-design.md`.
   */
  restoredDraft = $state<string | null>(null);
  /**
   * Project the next thread will be bound to. `null` = no project (default).
   * Picker UI in the chat thread-create flow writes here; `create()` and the
   * implicit-create branch of `sendMessage()` read it. Existing threads are
   * never re-bound — only newly-created ones honor this value.
   */
  pendingProjectId = $state<string | null>(null);
  /**
   * The bound project of the thread the last successful `select()` loaded
   * (`undefined` while loading, after a failed load, or when the backend does
   * not state it). Drives the fr-agui §7.5 /threads/[id] ⇄
   * /projects/P/threads/[id] redirect, which must act on what the SERVER says.
   */
  activeThreadProjectId = $state<string | null | undefined>(undefined);
  /**
   * fr-agui SPEC §6.0: `intake` while the user is on a doorway page
   * (create / request), so the agent gets the request-intake tool set only.
   * Set by AgentRail from the current route.
   */
  mode = $state<'default' | 'intake'>('default');
  /**
   * fr-agui SPEC §5.4: how a checked `ui-intent` navigates. Set by AgentRail to
   * SvelteKit's `goto` (the store stays free of `$app/*`); null ⇒ the chip is
   * shown and nothing navigates.
   */
  navigator: ((route: string) => void) | null = null;
  /** Current AbortController so the user can interrupt a streaming turn. */
  private abortCtrl: AbortController | null = null;
  /** Bumped by every select(); a stale in-flight load compares and bails. */
  private selectSeq = 0;

  /**
   * The project the CURRENT conversation is bound to, as far as the browser
   * knows: the loaded thread's server-stated binding, else the listed summary's,
   * else (no thread yet) the project the next thread will be bound to.
   */
  get boundProjectId(): string | null {
    if (typeof this.activeThreadProjectId === 'string') return this.activeThreadProjectId;
    const listed = this.activeThread?.projectId;
    if (typeof listed === 'string') return listed;
    if (this.activeThreadId && (this.activeThreadProjectId === null || listed === null)) return null;
    return this.pendingProjectId;
  }

  /**
   * fr-agui SPEC §5.1 / §5.7 — the rail is bound to the surface it is on: the
   * project shell of P (`projectId` = P) or the doorway (`null`). The next thread
   * is created bound to it, and an active thread KNOWN to be bound elsewhere (a
   * thread of another project, or an unbound doorway thread inside a project
   * shell) is dropped, so the chat on P's pages never speaks for another
   * project. Returns true when it dropped the active thread.
   */
  bindToSurface(projectId: string | null): boolean {
    this.pendingProjectId = projectId;
    if (!this.activeThreadId) return false;
    const known =
      this.activeThreadProjectId !== undefined ? this.activeThreadProjectId : this.activeThread?.projectId;
    if (known === undefined || known === projectId) return false;
    this.deselect();
    return true;
  }

  /** Drop the active thread (the next send starts a fresh one). */
  deselect(): void {
    this.selectSeq++;
    this.activeThreadId = null;
    this.activeThreadProjectId = undefined;
    this.items = [];
    this.lastError = null;
  }

  /** The currently selected thread summary, if any. */
  get activeThread(): ThreadSummary | null {
    if (!this.activeThreadId) return null;
    return this.threads.find((t) => t.id === this.activeThreadId) ?? null;
  }

  async list(): Promise<void> {
    const token = await agentSession.getAccessToken();
    try {
      const res = await fetchWithBudget('/api/agui/threads', {
        headers: { Authorization: `Bearer ${token}`, ...(await endUserHeaders()) },
      });
      if (!res.ok) throw new Error(`threads list failed: ${res.status}`);
      const body = (await res.json()) as { threads: ThreadSummary[] };
      this.threads = body.threads;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        this.lastError = 'Loading threads timed out — check connection.';
      }
      throw err;
    }
  }

  /**
   * The caller's OWN threads bound to one project, filtered SERVER-side
   * (`GET /api/agui/threads?projectId=`). Returned, not stored: the rail's
   * `threads` list (all projects) is left as it is.
   */
  async listForProject(projectId: string): Promise<ThreadSummary[]> {
    const token = await agentSession.getAccessToken();
    try {
      const res = await fetchWithBudget(
        `/api/agui/threads?projectId=${encodeURIComponent(projectId)}`,
        { headers: { Authorization: `Bearer ${token}`, ...(await endUserHeaders()) } },
      );
      if (!res.ok) throw new Error(`threads list failed: ${res.status}`);
      const body = (await res.json()) as { threads: ThreadSummary[] };
      return body.threads;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        this.lastError = 'Loading threads timed out — check connection.';
      }
      throw err;
    }
  }

  async create(opts: { channel?: string; projectId?: string | null } = {}): Promise<ThreadSummary> {
    const channel = opts.channel ?? 'web';
    const projectId = opts.projectId ?? null;
    const token = await agentSession.getAccessToken();
    const body: { channel: string; projectId?: string } = { channel };
    if (projectId) body.projectId = projectId;
    try {
      const res = await fetchWithBudget('/api/agui/threads', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          // SPEC §5.7: the bind gate reads the signed realm role from the portal token.
          ...(await endUserHeaders()),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // SPEC §5.6 / §5.7: the bind gate's refusal, verbatim (an unreadable or
        // other-tenant project is a 404 / 403 with the server's code).
        let code = '';
        try {
          const b = (await res.json()) as { error?: unknown; code?: unknown };
          code = typeof b.error === 'string' ? b.error : typeof b.code === 'string' ? b.code : '';
        } catch {
          // no JSON body — the status alone
        }
        throw new Error(`threads create failed: ${res.status}${code ? ` ${code}` : ''}`);
      }
      const summary = (await res.json()) as ThreadSummary;
      this.threads = [summary, ...this.threads];
      return summary;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        this.lastError = 'Creating thread timed out — check connection.';
      }
      throw err;
    }
  }

  async select(id: string): Promise<void> {
    // Seq guard (kanbanStore.selectCard idiom): a click on thread B while A's
    // load is in flight must not let A's late response overwrite B's buffer.
    const mySeq = ++this.selectSeq;
    this.activeThreadId = id;
    this.lastError = null;
    this.activeThreadProjectId = undefined;
    // Never render the previous thread's messages under the new selection.
    this.items = [];
    const token = await agentSession.getAccessToken();
    if (this.selectSeq !== mySeq) return;
    try {
      const res = await fetchWithBudget(`/api/agui/threads/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}`, ...(await endUserHeaders()) },
      });
      if (this.selectSeq !== mySeq) return;
      if (!res.ok) {
        // A failed load is NOT an empty thread. Without this the chat renders
        // MessageList's onboarding copy ("Start a conversation...") on a 403 or
        // a 500, which is indistinguishable from a brand-new thread. Callers
        // are fire-and-forget `void` inside `$effect`, so throwing here (as
        // list/create/deleteThread do) would go unhandled — the store's own
        // `lastError` channel is the one MessageList already renders.
        this.lastError = `threads select failed: ${res.status}`;
        this.items = [];
        return;
      }
      const detail = (await res.json()) as ThreadDetail;
      if (this.selectSeq !== mySeq) return;
      this.items = detail.messages.map((message) => ({ kind: 'message' as const, message }));
      this.activeThreadProjectId = detail.projectId;
    } catch (err) {
      // A superseded load's failure is not the current thread's failure.
      if (this.selectSeq !== mySeq) return;
      if (err instanceof BudgetExceededError) {
        this.lastError = 'Loading thread timed out — check connection.';
        this.items = [];
        return;
      }
      throw err;
    }
  }

  async deleteThread(id: string): Promise<void> {
    const token = await agentSession.getAccessToken();
    try {
      const res = await fetchWithBudget(`/api/agui/threads/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, ...(await endUserHeaders()) },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`threads delete failed: ${res.status}`);
      }
      this.threads = this.threads.filter((t) => t.id !== id);
      if (this.activeThreadId === id) {
        this.activeThreadId = null;
        this.items = [];
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        this.lastError = 'Deleting thread timed out — check connection.';
      }
      throw err;
    }
  }

  /**
   * Send a user message on the active thread, stream the agent's response.
   * If no active thread exists, creates a fresh one first.
   */
  async sendMessage(text: string): Promise<void> {
    if (!text.trim()) return;
    if (this.streaming) return; // ignore double-sends

    let summary = this.threads.find((t) => t.id === this.activeThreadId);
    if (!summary) {
      try {
        summary = await this.create({ channel: 'web', projectId: this.pendingProjectId });
      } catch (err) {
        // A refused bind is shown, never an unhandled rejection; the text is
        // handed back so nothing the user typed is lost.
        this.lastError = err instanceof Error ? err.message : String(err);
        this.restoredDraft = text;
        return;
      }
      this.activeThreadId = summary.id;
      this.activeThreadProjectId = summary.projectId ?? this.pendingProjectId;
    }

    // Append the user message optimistically.
    const ts = new Date().toISOString();
    this.items = [
      ...this.items,
      { kind: 'message', message: { role: 'user', content: text, ts } },
    ];

    this.streaming = true;
    this.lastError = null;

    // Bounded retry-with-backoff: survive WM pod rolls where the upstream
    // returns 502/503/504 before emitting any events. See design memo
    // `feedback-fr-thread-stream-retry-design.md`. We only retry when ZERO
    // events have been applied — otherwise WM has already committed a
    // partial turn server-side and a retry would double-charge.
    const MAX_ATTEMPTS = 2;
    let succeeded = false;
    let lastErr: unknown = null;
    let retryExhausted = false;

    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        this.abortCtrl = new AbortController();
        let eventsDelivered = 0;
        try {
          for await (const ev of chatStream(
            {
              threadId: summary.threadId,
              message: text,
              channel: 'web',
              ...(this.mode === 'intake' ? { mode: 'intake' as const } : {}),
            },
            { signal: this.abortCtrl.signal },
          )) {
            this.applyEvent(ev);
            eventsDelivered++;
          }
          succeeded = true;
          break;
        } catch (err) {
          lastErr = err;
          if (err instanceof Error && err.name === 'AbortError') break;
          if (eventsDelivered > 0) break;
          if (!isTransient(err)) break;
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(RETRY_BACKOFF_MS);
            continue;
          }
          retryExhausted = true;
        }
      }

      if (!succeeded) {
        if (lastErr instanceof Error && lastErr.name === 'AbortError') {
          this.lastError = 'Stopped';
        } else if (retryExhausted) {
          // Remove the optimistic user message and hand the text back to
          // ChatInput so the user can edit + resend.
          this.items = this.items.slice(0, -1);
          this.restoredDraft = text;
          this.lastError = 'Send failed — text restored, try again.';
        } else {
          this.lastError = lastErr instanceof Error ? lastErr.message : String(lastErr);
        }
      }
    } finally {
      this.streaming = false;
      this.abortCtrl = null;
      // Refresh the threads list so updated_at + preview reflect this turn.
      // Surface refresh failure into lastError so the UI can render a hint
      // (the streamed turn itself succeeded; this is a best-effort resync).
      await this.list().catch((err) => {
        if (!this.lastError) {
          this.lastError =
            err instanceof Error
              ? `Thread list refresh failed: ${err.message}`
              : 'Thread list refresh failed';
        }
      });
    }
  }

  /** Cancel the current streaming turn, if any. */
  interrupt(): void {
    this.abortCtrl?.abort();
  }

  private applyEvent(ev: AgentChatEvent): void {
    switch (ev.type) {
      case 'assistant-start':
        // Nothing visible; could show a typing indicator if desired.
        break;
      case 'tool-call-start':
        this.items = [
          ...this.items,
          {
            kind: 'tool-call',
            callId: ev.callId,
            action: ev.action,
            input: ev.input,
            status: 'running',
          },
        ];
        break;
      case 'tool-call-end': {
        const status = ev.status === 'pending' ? 'pending' : ev.status;
        // SPEC §5.6: a coded refusal is shown VERBATIM (`project_mismatch: …`).
        const error =
          ev.errorInfo && ev.errorInfo.code
            ? `${ev.errorInfo.code}: ${ev.errorInfo.message}`
            : ev.error;
        this.items = this.items.map((it) => {
          if (it.kind !== 'tool-call' || it.callId !== ev.callId) return it;
          return {
            ...it,
            status,
            output: ev.output,
            error,
          };
        });
        break;
      }
      case 'ui-intent': {
        // SPEC §5.4: the server checked the route; the browser checks it again
        // against the binding it knows before it follows it (fail closed).
        const verdict = checkUiIntent(ev.route, this.boundProjectId);
        this.items = [
          ...this.items,
          verdict.ok
            ? // ⛔ The chip's href is the VALIDATED, resolved route — the same value goto() gets — never ev.route.
              { kind: 'intent', callId: ev.callId, route: verdict.route, ok: true, label: intentChipLabel(verdict.route) }
            : { kind: 'intent', callId: ev.callId, route: '', ok: false, label: 'Navigation refused', reason: verdict.reason },
        ];
        if (verdict.ok) this.navigator?.(verdict.route);
        break;
      }
      case 'state-invalidate':
        // SPEC §5.3: invalidation, not a patch — every view rendering one of
        // these resources re-fetches.
        raiseInvalidate(ev.resources);
        break;
      case 'assistant-message':
        this.items = [
          ...this.items,
          {
            kind: 'message',
            message: {
              role: 'assistant',
              content: ev.text,
              ts: new Date().toISOString(),
            },
          },
        ];
        break;
      case 'assistant-end':
      case 'done':
        // Nothing to do — the message events already landed.
        break;
      case 'error':
        // A worker_management BYO-key error (errorCode set) already carries a
        // sentence the user can act on; the internal `wm_failed` prefix would
        // only obscure it.
        this.lastError = ev.errorCode ? ev.message : `${ev.code}: ${ev.message}`;
        break;
      case 'tool-call-event':
        // Reserved for fine-grained progress on long tool calls. The
        // current UI ignores these but they're available for a future
        // detail-pane.
        break;
    }
  }
}

export const threads = new ThreadsState();
