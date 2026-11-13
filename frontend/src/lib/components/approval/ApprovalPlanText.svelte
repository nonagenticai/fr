<script lang="ts">
  // The text the decider is asked to approve — `approvals.change_summary` — shown
  // ABOVE the decision bar, with its line breaks kept. For a conveyor sign-off
  // (`metadata.ask_kind = 'signoff'`) this column IS the plan; see
  // $lib/approvals/plan-text.ts for where it comes from and why it used to be lost.
  //
  // ⛔ Plain interpolation, never `{@html}`: producer text is untrusted, and
  // `markUnreadableProducerOutput` is applied exactly as the queue applies it.
  import DossierSection from './DossierSection.svelte';
  import { markUnreadableProducerOutput } from '$lib/approvals/rationale';
  import { changeSummaryTitle, summaryRepeatsQuestion } from '$lib/approvals/plan-text';
  import type { Approval } from '$lib/types/api';

  interface Props {
    approval: Pick<Approval, 'change_summary' | 'metadata'>;
  }
  let { approval }: Props = $props();
</script>

<!-- A summary that only repeats the stated question is not shown twice: the decision surface's
     "Question for you" box carries it (summaryRepeatsQuestion; never a sign-off's plan). -->
{#if approval.change_summary && !summaryRepeatsQuestion(approval)}
  <DossierSection title={changeSummaryTitle(approval)}>
    <p class="whitespace-pre-wrap break-words" data-testid="approval-plan-text">{markUnreadableProducerOutput(approval.change_summary)}</p>
  </DossierSection>
{/if}
