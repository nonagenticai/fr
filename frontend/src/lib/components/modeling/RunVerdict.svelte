<!--
  RunVerdict — a validation run's verdict as requirements_management STORED it
  (status + clean + counts), with the plain-language explanation of what it means
  for the user. fr adds no judgement of its own (explain.ts runVerdict).
-->
<script lang="ts">
  import { Pill } from '$lib/components/ui';
  import type { ValidationRun } from '$lib/api/modeling';
  import { runVerdict } from '$lib/modeling/explain';

  let { run, explain = true }: { run: Pick<ValidationRun, 'status' | 'clean' | 'counts' | 'examined' | 'expected'>; explain?: boolean } = $props();
  const verdict = $derived(runVerdict(run));
</script>

<span class="inline-flex flex-col gap-1" data-testid="run-verdict" data-tone={verdict.tone}>
  <span><Pill tone={verdict.tone}>{verdict.label}</Pill></span>
  {#if explain}
    <span class="text-xs text-[var(--color-text-muted)]" data-testid="run-verdict-explanation">{verdict.explanation}</span>
  {/if}
</span>
