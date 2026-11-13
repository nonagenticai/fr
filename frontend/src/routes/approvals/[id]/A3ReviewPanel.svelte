<!--
  G-12 A3 review panel (execution.feature_design_approval). Shows the design George approves
  together with its acceptance tests: hashes, write_set, every unit (spec, scope, criteria,
  test code) and the scenarios. EVERYTHING here is producer metadata rendered as TEXT — there
  is deliberately no {@html} in this file. The decision itself goes through the page's
  ApprovalDecisionSurface → recordDecision (a3DecisionBody); this panel only owns the reject
  reason code, bound back to the page.
-->
<script lang="ts">
  import { shortHash, type A3ReviewModel } from './page-helpers';

  interface Props {
    model: A3ReviewModel;
    busy?: boolean;
    rejectReasonCode?: string;
  }

  let { model, busy = false, rejectReasonCode = $bindable('') }: Props = $props();
</script>

<section
  data-testid="a3-review"
  class="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
>
  <h2 class="font-semibold text-[var(--color-text)]">Feature design + acceptance tests</h2>

  <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
    <dt>Design artifact</dt>
    <dd class="break-all font-mono text-[var(--color-text)]" data-testid="a3-design-id">{model.designArtifactId ?? '—'}</dd>
    <dt>design_hash</dt>
    <dd class="font-mono" title={model.designHash ?? ''} data-testid="a3-design-hash">{shortHash(model.designHash)}</dd>
    <dt>contract_hash</dt>
    <dd class="font-mono" title={model.contractHash ?? ''}>{shortHash(model.contractHash)}</dd>
    <dt>scenarios_hash</dt>
    <dd class="font-mono" title={model.scenariosHash ?? ''}>{shortHash(model.scenariosHash)}</dd>
  </dl>

  {#if model.disabledReason}
    <p class="text-xs text-[var(--color-danger-text)]" data-testid="a3-disabled-reason">{model.disabledReason}</p>
  {/if}

  <div>
    <h3 class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Write set</h3>
    {#if model.writeSet.length > 0}
      <ul class="font-mono text-xs text-[var(--color-text)]" data-testid="a3-write-set">
        {#each model.writeSet as p (p)}
          <li class="break-all">{p}</li>
        {/each}
      </ul>
    {:else}
      <p class="text-xs text-[var(--color-text-muted)]">No write_set on this approval.</p>
    {/if}
  </div>

  {#each model.units as u, i (u.unitKey || i)}
    <article class="space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-2" data-testid="a3-unit">
      <p class="font-mono text-xs text-[var(--color-text)]" data-testid="a3-unit-spec">
        {u.kind} · {u.file} · {u.fn}{u.childCardType ? ` → ${u.childCardType}` : ''}
      </p>
      {#if u.summary}<p class="text-[var(--color-text)]">{u.summary}</p>{/if}
      {#if u.targetFiles.length > 0}
        <p class="break-all text-xs text-[var(--color-text-muted)]">Target files: {u.targetFiles.join(', ')}</p>
      {/if}
      <ul class="space-y-1 text-xs">
        {#each u.criteria as c (c.id)}
          <li data-testid="a3-criterion"><span class="font-mono">{c.id}</span> — {c.text}</li>
        {/each}
      </ul>
      {#each u.tests as t, j (t.id + t.path + j)}
        <details class="text-xs" data-testid="a3-test">
          <summary class="cursor-pointer"><span class="font-mono">{t.id}</span> · <span class="font-mono">{t.path}</span></summary>
          <pre class="mt-1 overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--color-bg)] p-2 font-mono text-xs"><code
              data-testid="a3-test-code">{t.code}</code></pre>
        </details>
      {/each}
      {#if u.covers.length > 0 || u.requires.length > 0}
        <p class="text-xs text-[var(--color-text-muted)]">
          {#if u.covers.length > 0}Covers: {u.covers.join(', ')}{/if}
          {#if u.requires.length > 0} · Requires: {u.requires.join(', ')}{/if}
        </p>
      {/if}
    </article>
  {/each}

  {#if model.scenarios.length > 0}
    <div>
      <h3 class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Scenarios</h3>
      <ul class="space-y-1 text-xs">
        {#each model.scenarios as sc, k (sc.scenarioId || k)}
          <li data-testid="a3-scenario">
            <span class="text-[var(--color-text)]">{sc.title}</span>
            <span class="font-mono text-[var(--color-text-muted)]"> ({sc.criterionId})</span>
            {#if sc.gherkin}
              <pre class="mt-1 overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--color-bg)] p-2 font-mono">{sc.gherkin}</pre>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if model.template && !model.disabledReason}
    <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
      Reject reason code (required for Reject)
      <select
        data-testid="a3-reject-code"
        bind:value={rejectReasonCode}
        disabled={busy}
        class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]"
      >
        <option value="">— choose —</option>
        {#each model.template.reject_codes as code (code)}
          <option value={code}>{code}</option>
        {/each}
      </select>
    </label>
    <p class="text-xs text-[var(--color-text-muted)]">
      This approval takes no free-text comment — leave the comment box empty. Approve accepts the design and its
      acceptance tests together.
    </p>
  {/if}
</section>
