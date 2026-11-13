<script lang="ts">
  /**
   * A count in the nav rail.
   *
   * ⛔ THE DEFECT (fr#1140's surviving half, measured 2026-09-26). A BARE NUMBER
   * BESIDE A WORKSPACE NAME IS A CLAIM ABOUT SCOPE, AND IT WAS THE WRONG ONE.
   * The Approvals badge is fed `GET /api/approvals/all?status=pending&limit=1`,
   * which for a super-admin in their home view counts EVERY workspace. Measured
   * on the prod primary: fleet pending 5 (`system` 3, `nonagentic-exec` 2),
   * `fr-test` 0. So this component rendered `5` a few pixels from a workspace
   * switcher reading `fr-test` — a workspace holding none of the five — with
   * `aria-label="5 pending"`, which for a screen reader is the same lie with no
   * visual context at all to soften it.
   *
   * ⭐ WHAT WAS ADDED AND WHAT WAS DELIBERATELY NOT. Not more text: the rail is
   * 220px and the label beside this badge already renders under `truncate`
   * ("Procedure improvement" → "Procedure improveme…"), so every character
   * spent here is taken from the label. What is added is
   *   1. ONE character of visible marker — a trailing `*`, the universal "this
   *      figure is qualified, read the note" — shown ONLY on the fleet-wide
   *      case, so it is a signal and not decoration;
   *   2. the note itself, in `title` (hover — see `qualified`, which is why the
   *      hover note appears ONLY where there is a note) AND `aria-label` (the
   *      sentence a screen reader gets INSTEAD of the digits, which is why the
   *      marker is `aria-hidden`: "5 asterisk" is not the qualifier);
   *   3. a ring, so the distinction survives for a reader who does not hover,
   *      does not use a screen reader, and does not know what the `*` means.
   *
   * ⚠️ `scope === undefined` IS A THIRD CASE, not a default for either claim. It
   * means the envelope did not state a scope (a pre-#855 backend), and the only
   * honest rendering is the unqualified number this component always showed.
   * Printing "in this workspace" there would invent the confinement the fleet
   * bug invented, just quieter; printing the fleet note would cry wolf on every
   * count such a server ever returns. The other badge source
   * (unread-notifications) states no scope and lands here too —
   * this component must not widen a claim about a counter it was told nothing
   * about. What they DO state is `what` they count, because the one thing this
   * component must not do for them is borrow the approvals vocabulary.
   */
  import { scopedCountLabel, type CountScope } from '$lib/stores/count-scope';

  let {
    count,
    what,
    scope = undefined,
    stale = false,
  }: {
    count: number;
    /**
     * WHAT IS BEING COUNTED, in the caller's own words — the noun phrase that
     * follows the number ("pending", "unread", "of your cards in Doing").
     *
     * ⛔ REQUIRED, AND IT USED TO BE THE HARD-CODED WORD `pending`. This
     * component serves more than one source and only one of them counts pending
     * anything: `unread-notifications` counts UNREAD NOTIFICATIONS, so `aria-label="3
     * pending"` told a screen-reader user a fact about a queue that row does not
     * lead to — and when a `title` was added beside it, the same wrong word
     * became a tooltip for everyone. No default is offered on purpose: a default
     * is how one source's vocabulary got applied to all of them, and `svelte-check`
     * (CI) fails a new call site that does not say what it counts.
     */
    what: string;
    /** What the count covers, as its ENVELOPE stated it — never re-derived here. */
    scope?: CountScope;
    /** Last refresh did not confirm this number; it is the last one we ever got. */
    stale?: boolean;
  } = $props();

  /**
   * The count with its noun — or the BARE count when the caller named no noun.
   *
   * An empty `what` is unreachable from the rail (a row with no badge source
   * counts 0 and this component renders nothing at 0), and it degrades to the
   * unqualified number rather than to a borrowed word: a badge that cannot say
   * what it counts must not guess.
   */
  const counted = $derived(what.trim() === '' ? `${count}` : `${count} ${what.trim()}`);

  /**
   * The whole claim, in one sentence, for `title` and `aria-label` alike.
   *
   * ⭐ ONE STRING FOR BOTH. They used to be able to disagree (only `aria-label`
   * existed, and it was the one that was wrong), and a tooltip that says
   * something a screen reader does not is the same defect with a smaller
   * audience.
   * ⚠️ AMENDED — THE WORDING MOVED, THE OUTPUT DID NOT. It now comes from
   * `$lib/stores/count-scope :: scopedCountLabel`, byte-for-byte the expression that
   * used to be inline here, because TWO MORE surfaces off the same store field needed
   * the identical sentence (the Home hero and `PendingApprovalsCard`, neither of which
   * qualified its count at all). Pasting it into them would have made three copies of
   * one claim. ⛔ Do not re-inline it.
   */
  const label = $derived(scopedCountLabel(counted, scope, stale));

  /**
   * Does this badge have a SENTENCE to add, or only the digits already on screen?
   *
   * ⛔ WHY `title` IS CONDITIONAL WHILE `aria-label` IS NOT. A byte comparison of
   * main against this change found the my-cards and unread badges pixel-identical
   * — except for a NEW `title`, which main had never rendered. That attribute is
   * not free: the row's own `title={label}` (SidebarNav's leaf snippet, added so a
   * `truncate`d rail label like "Procedure improveme…" is readable on hover) is
   * SHADOWED wherever the pointer sits over a child that has its own. So a badge
   * tooltip that only restates the digits costs the reader the row's label and
   * returns nothing.
   *
   * A qualification is different: "across every workspace — not just the one
   * selected" and "not confirmed by the latest refresh" are facts no amount of
   * hovering elsewhere reveals, and they are the whole point of the change. So the
   * tooltip appears exactly when there is one, and the two unqualified badges go
   * back to having none — while `aria-label` stays unconditional, because a screen
   * reader would otherwise announce a naked integer.
   */
  const qualified = $derived(scope !== undefined || stale);

  const FRESH_CLS = 'bg-[var(--color-accent)] text-[var(--color-on-primary)]';
  // Unfilled, muted, outlined: reads as "not live" at a glance without spending
  // a single extra character of rail width, and is the same treatment whatever
  // the scope — staleness and scope are independent facts and the badge shows
  // both at once (a stale fleet count keeps its `*` and its ring).
  const STALE_CLS =
    'bg-transparent text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-strong)]';
</script>

{#if count > 0}
  <span
    class={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${stale ? STALE_CLS : FRESH_CLS} ${
      scope === 'fleet' && !stale ? 'ring-1 ring-inset ring-[var(--color-on-primary)]' : ''
    }`}
    title={qualified ? label : undefined}
    aria-label={label}
    data-testid="sidebar-badge"
  >
    {count > 99 ? '99+' : count}{#if scope === 'fleet'}<span aria-hidden="true">*</span>{/if}
  </span>
{/if}
