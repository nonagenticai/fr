<script lang="ts">
  // The plan's recorded FACTS (CONVEYOR-TAXONOMY §3 B): template@hash, size
  // class, repo count, risk flags, optional phases. Every value is the server's;
  // an absent one is said to be "not recorded" — never defaulted, never guessed.
  import type { PlanFacts } from '$lib/types/plan';

  interface Props {
    template: { id: string; hash: string };
    phasePlanHash: string;
    facts: PlanFacts;
  }
  let { template, phasePlanHash, facts }: Props = $props();

  function show(v: unknown): string {
    if (v === null || v === undefined) return 'not recorded';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v) && v.length === 0) return 'none';
    return JSON.stringify(v);
  }
  const short = (h: string) => (h.length > 12 ? `${h.slice(0, 12)}…` : h);
</script>

<aside
  class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs"
  data-testid="plan-facts-panel"
  aria-label="Plan facts"
>
  <h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Plan facts</h3>
  <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
    <dt class="text-[var(--color-text-muted)]">Template</dt>
    <dd data-testid="plan-fact-template" title={template.hash}>{template.id}@{short(template.hash)}</dd>
    <dt class="text-[var(--color-text-muted)]">Plan hash</dt>
    <dd title={phasePlanHash}>{short(phasePlanHash)}</dd>
    <dt class="text-[var(--color-text-muted)]">Size class</dt>
    <dd data-testid="plan-fact-size">{show(facts.size_class)}</dd>
    <dt class="text-[var(--color-text-muted)]">Repositories</dt>
    <dd data-testid="plan-fact-repos">{show(facts.repo_count)}</dd>
    <dt class="text-[var(--color-text-muted)]">Risk flags</dt>
    <dd data-testid="plan-fact-risk">{show(facts.risk_flags)}</dd>
    <dt class="text-[var(--color-text-muted)]">Optional phases</dt>
    <dd data-testid="plan-fact-optional">{show(facts.optional_phases)}</dd>
  </dl>
</aside>
