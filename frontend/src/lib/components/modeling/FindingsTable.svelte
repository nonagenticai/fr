<!--
  FindingsTable — the findings requirements_management stored for one validation
  run, filterable by severity and by rule (both filters are sent to RM, which
  does the filtering). Rule titles and descriptions come from the run's rule set
  so a finding reads in plain words; the rule id stays visible for reference.
-->
<script lang="ts">
  import { Pill } from '$lib/components/ui';
  import { getRuleset, listFindings, type RuleInfo, type Severity, type ValidationFinding } from '$lib/api/modeling';
  import { SEVERITY_HELP, SEVERITY_LABEL, SEVERITY_TONE } from '$lib/modeling/explain';

  let { runId, rulesetId, counts = {} }: { runId: string; rulesetId: string; counts?: Partial<Record<Severity, number>> } = $props();

  let severity = $state<'' | Severity>('');
  let ruleId = $state('');
  let findings = $state<ValidationFinding[]>([]);
  let truncated = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let rules = $state<Map<string, RuleInfo>>(new Map());

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const page = await listFindings(runId, { ...(severity ? { severity } : {}), ...(ruleId ? { rule_id: ruleId } : {}) });
      findings = page.items;
      truncated = page.truncated;
    } catch (e) {
      findings = [];
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void severity;
    void ruleId;
    void runId;
    load();
  });

  $effect(() => {
    const ref = rulesetId;
    if (!ref) return;
    getRuleset(ref)
      .then((r) => (rules = new Map((r.rules ?? []).map((x) => [x.rule_id, x]))))
      // Without the rule set the table still shows each finding's own message and rule id.
      .catch((e) => console.warn('[FindingsTable] rule titles unavailable', e));
  });

  const ruleOptions = $derived([...rules.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id)));
  const SEVERITIES: Severity[] = ['error', 'warning', 'advice'];
</script>

<section class="flex flex-col gap-3" data-testid="findings-table">
  <div class="flex flex-wrap items-center gap-3 text-sm">
    {#each SEVERITIES as s (s)}
      <span class="inline-flex items-center gap-1" title={SEVERITY_HELP[s]} data-testid={`findings-count-${s}`}>
        <Pill tone={SEVERITY_TONE[s]}>{SEVERITY_LABEL[s]}: {counts[s] ?? 0}</Pill>
      </span>
    {/each}
  </div>
  <div class="flex flex-wrap items-end gap-3">
    <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
      Severity
      <select bind:value={severity} class="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]" data-testid="findings-filter-severity">
        <option value="">All</option>
        {#each SEVERITIES as s (s)}<option value={s}>{SEVERITY_LABEL[s]}</option>{/each}
      </select>
    </label>
    <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
      Rule
      <select bind:value={ruleId} class="max-w-xs rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]" data-testid="findings-filter-rule">
        <option value="">All rules</option>
        {#each ruleOptions as r (r.rule_id)}<option value={r.rule_id} title={`Rule ${r.rule_id}`}>{r.title || r.rule_id}</option>{/each}
      </select>
    </label>
  </div>

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the findings…</p>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2" data-testid="findings-error">
      <p class="text-sm text-[var(--color-danger)]">The findings could not be loaded: {error}</p>
      <button type="button" class="text-sm font-medium text-[var(--color-link)] underline" onclick={load}>Try again</button>
    </div>
  {:else if findings.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="findings-empty">
      {severity || ruleId ? 'Nothing matches these filters.' : 'This check found nothing to report.'}
    </p>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full min-w-[44rem] text-left text-sm" data-testid="findings-rows">
        <thead class="text-xs text-[var(--color-text-muted)]">
          <tr>
            <th class="py-1 pr-3 font-medium">Severity</th>
            <th class="py-1 pr-3 font-medium">Rule</th>
            <th class="py-1 pr-3 font-medium">What was found</th>
            <th class="py-1 font-medium">Concerns</th>
          </tr>
        </thead>
        <tbody>
          {#each findings as f, i (i)}
            {@const rule = rules.get(f.rule_id)}
            <tr class="border-t border-[var(--color-border)] align-top" data-testid="finding-row" data-severity={f.severity}>
              <td class="py-2 pr-3"><Pill tone={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity] ?? f.severity}</Pill></td>
              <td class="py-2 pr-3">
                <span class="text-[var(--color-text)]">{rule?.title ?? f.rule_id}</span>
                {#if rule}<span class="block text-xs text-[var(--color-text-muted)]">{f.rule_id}</span>{/if}
              </td>
              <td class="py-2 pr-3 text-[var(--color-text)]">
                {f.message}
                {#if rule?.description}<span class="block text-xs text-[var(--color-text-muted)]">{rule.description}</span>{/if}
              </td>
              <td class="py-2 text-xs text-[var(--color-text-muted)]">
                {#each f.targets as t, j (j)}
                  <span class="block break-all">{t.kind.replace(/_/g, ' ')} {t.id}</span>
                {:else}—{/each}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if truncated}
      <p class="text-xs text-[var(--color-warning-text)]" data-testid="findings-truncated">Only the first 1,000 findings are shown. Narrow the list with the filters above.</p>
    {/if}
  {/if}
</section>
