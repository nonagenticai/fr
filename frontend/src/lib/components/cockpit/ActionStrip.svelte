<script lang="ts">
  // C2 — the action strip (cockpit spec C2): every open question, sign-off and artifact review on
  // this project, OLDEST FIRST, with how long it has waited. The page's one accented zone.
  //
  //   * Simple sign-off → inline Approve / Reject, each a two-step press (the second press sends),
  //     through the SAME decide endpoint every approval surface uses (`recordDecision` →
  //     PUT /api/approvals/:id). Who may decide is the server's rule; `inlineVerdict` only mirrors it.
  //   * A plain question the viewer may answer → an inline answer box (R2), through the SAME decide
  //     endpoint (`recordDecision`, isQuestion). A question with a structured answer form → "Open".
  //   * Anything with evidence or a structured decision → "Open" (the approve page).
  //   * Each item is tagged with its phase (its card's exact phase; none when it has none).
  //   * Hidden on a closed project (the parent does not mount it); empty ⇒ one quiet line.
  import { auth } from '$lib/stores/auth.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { toastDecisionNotice } from '$lib/approvals/toast-notice';
  import { recordDecision } from '../../../routes/approvals/[id]/page-helpers';
  import { ageWords } from '$lib/projects/cockpit-status';
  import { hasData, type Panel } from '$lib/types/panel';
  import type { CockpitActionItem, CockpitApproval } from '$lib/types/cockpit';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import { ACTION_TYPE_WORD, inlineAnswerVerdict, inlineVerdict, openHref } from './actionStrip';

  interface Props {
    projectId: string;
    actions: Panel<CockpitActionItem[]>;
    approvals: Panel<CockpitApproval[]>;
    /** Called after a decision lands, so the page re-reads the cockpit. */
    onDecided?: () => void;
    /** phase name → its title, to tag each item with its phase. */
    phaseLabels?: ReadonlyMap<string, string>;
  }
  let {
    projectId,
    actions,
    approvals,
    onDecided,
    phaseLabels = new Map(),
  }: Props = $props();

  let answers = $state<Record<string, string>>({});

  async function answer(item: CockpitActionItem): Promise<void> {
    if (!item.approval_id) return;
    const text = (answers[item.key] ?? '').trim();
    if (!text) {
      toast.error('Write your answer first: it is what the agent receives.');
      return;
    }
    busy = item.key;
    try {
      const outcome = await recordDecision(item.approval_id, 'approve', text, { isQuestion: true });
      decided = { ...decided, [item.key]: true };
      toastDecisionNotice(outcome.notice);
      onDecided?.();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The answer could not be sent.');
    } finally {
      busy = null;
    }
  }

  const items = $derived(hasData(actions) ? actions.data : []);
  const byId = $derived(new Map((approvals.data ?? []).map((a) => [a.id, a])));
  /** Decided here and not yet re-read: hidden at once so a second press cannot land. */
  let decided = $state<Record<string, true>>({});
  const shown = $derived(items.filter((i) => !decided[i.key]));

  let armed = $state<{ key: string; kind: 'approve' | 'reject' } | null>(null);
  let busy = $state<string | null>(null);

  const TYPE_TONE: Record<CockpitActionItem['type'], string> = {
    ask: 'border-[var(--color-info-border)] bg-[var(--color-info-bg)]',
    signoff: 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]',
    review: 'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)]',
  };

  async function decide(item: CockpitActionItem, kind: 'approve' | 'reject'): Promise<void> {
    if (!item.approval_id) return;
    if (armed?.key !== item.key || armed.kind !== kind) {
      armed = { key: item.key, kind };
      return;
    }
    busy = item.key;
    try {
      const outcome = await recordDecision(item.approval_id, kind, '', { isQuestion: false });
      decided = { ...decided, [item.key]: true };
      toastDecisionNotice(outcome.notice);
      onDecided?.();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'The decision could not be recorded.');
    } finally {
      busy = null;
      armed = null;
    }
  }
</script>

<section
  class="rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-surface)] p-3"
  data-testid="action-strip"
  aria-label="Needs you"
>
  <h2 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
    Needs you{shown.length > 0 ? ` (${shown.length})` : ''}
  </h2>
  {#if !hasData(actions)}
    <PanelNote panel={actions} title="Pending actions" />
  {:else if shown.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="action-strip-empty">Nothing needs you.</p>
  {:else}
    {#if actions.health !== 'ok'}<PanelNote panel={actions} title="Pending actions" class="mb-2" />{/if}
    <ul class="flex gap-2 overflow-x-auto pb-1" data-testid="action-strip-items">
      {#each shown as item (item.key)}
        {@const verdict = inlineVerdict(item, item.approval_id ? byId.get(item.approval_id) : undefined, auth.user)}
        {@const age = ageWords(item.created_at, Date.now())}
        {@const canAnswer = inlineAnswerVerdict(item, item.approval_id ? byId.get(item.approval_id) : undefined, auth.user)}
        {@const phaseLabel = item.phase ? (phaseLabels.get(item.phase) ?? item.phase) : null}
        <li
          class={`flex w-72 shrink-0 flex-col gap-1.5 rounded-md border p-2.5 ${TYPE_TONE[item.type]}`}
          data-testid="action-item"
          data-type={item.type}
          data-key={item.key}
        >
          <div class="flex items-baseline justify-between gap-2 text-[11px] text-[var(--color-text-muted)]">
            <span class="font-semibold uppercase tracking-wide">
              {ACTION_TYPE_WORD[item.type]}{#if phaseLabel}<span class="ml-1 rounded bg-[var(--color-surface)] px-1 py-px font-normal normal-case tracking-normal" data-testid="action-phase">{phaseLabel}</span>{/if}
            </span>
            {#if age}<span data-testid="action-age">{age}</span>{/if}
          </div>
          <p class="line-clamp-3 text-sm text-[var(--color-text)]" title={item.title}>{item.title}</p>
          {#if item.card_name}
            <p class="truncate text-[11px] text-[var(--color-text-muted)]">Card: {item.card_name}</p>
          {/if}
          {#if canAnswer}
            <label class="sr-only" for={`answer-${item.key}`}>Your answer</label>
            <textarea
              id={`answer-${item.key}`}
              rows="2"
              class="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 text-xs text-[var(--color-text)]"
              placeholder="Your answer goes to the agent"
              data-testid="action-answer-text"
              bind:value={answers[item.key]}
            ></textarea>
          {/if}
          <div class="mt-auto flex flex-wrap gap-1.5 pt-1">
            {#if canAnswer}
              <button
                type="button"
                class="rounded-[var(--radius-md)] bg-[var(--color-primary)] px-2.5 py-1 text-xs font-semibold text-[var(--color-on-primary)] disabled:opacity-50"
                data-testid="action-answer"
                disabled={busy === item.key}
                onclick={() => answer(item)}
              >
                Answer
              </button>
            {/if}
            {#if verdict.inline}
              <button
                type="button"
                class="rounded-[var(--radius-md)] bg-[var(--color-primary)] px-2.5 py-1 text-xs font-semibold text-[var(--color-on-primary)] disabled:opacity-50"
                data-testid="action-approve"
                disabled={busy === item.key}
                onclick={() => decide(item, 'approve')}
              >
                {armed?.key === item.key && armed.kind === 'approve' ? 'Confirm approve' : 'Approve'}
              </button>
              <button
                type="button"
                class="rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-semibold text-[var(--color-text)] disabled:opacity-50"
                data-testid="action-reject"
                disabled={busy === item.key}
                onclick={() => decide(item, 'reject')}
              >
                {armed?.key === item.key && armed.kind === 'reject' ? 'Confirm reject' : 'Reject'}
              </button>
            {/if}
            <a
              href={openHref(projectId, item)}
              class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-semibold text-[var(--color-link)] hover:underline"
              data-testid="action-open"
            >
              Open
            </a>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
