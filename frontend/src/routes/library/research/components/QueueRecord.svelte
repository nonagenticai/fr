<!--
  ONE RECORD IN THE SCREENING QUEUE — the thing the reviewer is judging.

  Extracted from `ScreeningPanel.svelte` because of what it did NOT render.
  The row was:

      <strong>{item.title ?? '(untitled)'}</strong>
      <span class="meta">
        {item.publication_year ?? '—'} · {item.container_title ?? '—'}
        {#if item.doi}<code class="code">{item.doi}</code>{/if}
      </span>

  and then three buttons asking for a verdict. A title-and-abstract screen was
  being conducted against the title alone. `QueueItem.abstract` was typed in
  `lib/api/reviews.ts`, served by Evidence Review through the assignment's
  sealed corpus version (`services/screening.py`), fetched on every page of the
  queue — and dropped on the floor here. The stage is literally NAMED
  "Title/abstract"; half of what names it never reached the screen.

  That is not a cosmetic gap. Screening at title-only is a different, and much
  worse, instrument: it inflates exclusion on ambiguous titles and inflates
  inclusion on promising ones, and neither error is visible afterwards, because
  the decision record looks identical either way. Two reviewers agreeing at
  title-only opens no conflict, so the disagreement that would have surfaced the
  problem never gets recorded.

  The DOI is the second half of the same defect. It was a `<code>` — a
  transcription target — so the only route from "I cannot tell from the
  abstract" to the actual paper was to select the string and paste it somewhere
  else, once per record, down a queue that pages at 200.

  A component rather than more markup inline: the panel is 4,400 lines, and
  what a reviewer is SHOWN before they are asked to judge deserves a unit test
  that does not have to stand up the whole studio to run.
-->
<script lang="ts">
  import type { QueueItem } from '$lib/api/reviews';
  import { doiHref } from '$lib/research/doi';

  interface Props {
    item: QueueItem;
    /**
     * Characters of abstract shown before the row offers to expand.
     *
     * A queue page is up to 200 records and abstracts run to 2,000+ characters;
     * rendering them all in full turns the list into something you scroll past
     * rather than read. The cut is on the STRING, not on rendered lines, so it
     * is the same on every viewport and a test can assert it.
     */
    clampChars?: number;
  }

  const { item, clampChars = 420 }: Props = $props();

  /**
   * `null`, `undefined`, `''` and `'   '` are ONE state here, and it is not
   * "has an abstract".
   *
   * The empty string is the case worth naming: an import whose abstract column
   * was present but blank is indistinguishable from a missing one to a reader,
   * and rendering it as an abstract produces an empty bordered box — which
   * reads as "this paper has nothing to say", not as "we were never given the
   * text". The row must be able to say which, because "no abstract available"
   * is itself grounds a reviewer may act on (it is a reason to go to the paper,
   * or to exclude on insufficient information), and an empty box is not.
   */
  const abstract = $derived(item.abstract?.trim() ? item.abstract.trim() : null);
  const isLong = $derived(abstract !== null && abstract.length > clampChars);

  let expanded = $state(false);
  const shown = $derived(
    abstract === null || expanded || !isLong
      ? abstract
      : `${abstract.slice(0, clampChars).trimEnd()}…`,
  );

  /**
   * `null` whenever the value cannot be proven to be a DOI — see
   * `lib/research/doi.ts`. The `{:else if item.doi}` arm below is the point of
   * the tri-state: an unresolvable value is still SHOWN, just not promised.
   */
  const href = $derived(doiHref(item.doi));
</script>

<div class="record" data-testid="queue-record" data-review-record-id={item.review_record_id}>
  <strong data-testid="queue-record-title">{item.title ?? '(untitled)'}</strong>
  <span class="meta">
    {item.publication_year ?? '—'} · {item.container_title ?? '—'}
    {#if href}
      <!--
        `rel="noreferrer"` alongside `noopener`: the queue is behind
        authentication and the referrer would leak the review's studio URL to
        doi.org and onward to the publisher.
      -->
      <a
        class="code doi"
        {href}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="queue-record-doi-link"
      >{item.doi}</a>
    {:else if item.doi}
      <code class="code" data-testid="queue-record-doi-plain" title="Not a resolvable DOI">
        {item.doi}
      </code>
    {/if}
  </span>

  {#if abstract !== null}
    <p class="abstract" data-testid="queue-record-abstract" data-truncated={isLong && !expanded}>
      {shown}
    </p>
    {#if isLong}
      <button
        type="button"
        class="link"
        onclick={() => (expanded = !expanded)}
        data-testid="queue-record-abstract-toggle"
      >
        {expanded ? 'Show less' : 'Show full abstract'}
      </button>
    {/if}
  {:else}
    <!--
      An ABSENCE, stated. Not an empty box, and not silence either: silence is
      what the row did before, and it is indistinguishable from a row whose
      abstract simply wasn't rendered — which is exactly the bug this component
      exists to close, and would hide a regression of it perfectly.
    -->
    <p class="hint no-abstract" data-testid="queue-record-no-abstract">
      No abstract in this record — judge from the title and identifiers, or open the paper.
    </p>
  {/if}
</div>

<style>
  /* Mirrors `.record` in ScreeningPanel: scoped CSS does not cross the
     component boundary, so the row's layout has to come with it. */
  .record {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1 1 20rem;
  }
  .meta {
    font-size: 0.78rem;
    color: var(--color-text-muted);
  }
  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    font-weight: 400;
    background: var(--color-surface-strong);
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    margin-left: 0.35rem;
  }
  .doi {
    color: var(--color-link);
    text-decoration: underline;
  }
  .abstract {
    margin: 0.3rem 0 0;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--color-text);
    max-width: 62ch;
    overflow-wrap: anywhere;
  }
  .no-abstract {
    margin: 0.3rem 0 0;
    font-size: 0.8rem;
    font-style: italic;
    color: var(--color-text-muted);
  }
  .link {
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 0;
    margin: 0.15rem 0 0;
    font: inherit;
    font-size: 0.78rem;
    color: var(--color-link);
    text-decoration: underline;
    cursor: pointer;
  }
</style>
