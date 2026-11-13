<!--
  U2 — typed renderer for a `bug_report` (bug_report/v1) stored report.

  Shows H_r (the server-recomputed content hash, migration 147) and one row per
  bug: location, failing test, fix outline. Bugs arrive sorted by id — the order
  H_r hashes them in. The page falls back to the generic JSON view when
  `parseBugReportDetails` returns null, so this component only ever sees a
  well-formed v1 body.

  hunt: shows status and scanned/tracked file counts (and the analyzer's
  root_cause_analysis). The backend stores only a COMPLETE hunt; if a row that
  is not complete ever reaches this view (written around the route), it is a
  LOUD danger banner and the bugs list reads "result unknown" — an empty list
  from a crashed or partial hunt must never read as "no bugs". A complete hunt
  with zero bugs says so explicitly. Each bug shows its `kind`.
  trace_id (AA-TRACE join key) is shown when present, "none (orphan write)" when not.
-->
<script lang="ts">
  import { isHuntComplete, type BugReportDetails } from '$lib/api/bug-report';

  let {
    details,
    contentHash,
    traceId = null,
  }: { details: BugReportDetails; contentHash: string | null; traceId?: string | null } = $props();

  const failed = $derived(!isHuntComplete(details.hunt));

  const label = 'text-xs uppercase tracking-wide text-[var(--color-text-muted)]';
  const cell = 'border-t border-[var(--color-border)] px-3 py-2 align-top text-sm text-[var(--color-text)]';
</script>

<section class="mb-6" data-testid="bug-report-view">
  {#if failed}
    <div
      role="alert"
      data-testid="bug-report-hunt-failed"
      class="mb-4 rounded-[var(--radius-md)] border-2 border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-4"
    >
      <p class="text-base font-bold uppercase tracking-wide text-[var(--color-danger-text)]">
        Bug hunt incomplete — the analyzer crashed or did not scan every file
      </p>
      <p class="mt-1 text-sm text-[var(--color-danger-text)]">
        This report does NOT mean the code is free of bugs; the hunt has to be re-run.
      </p>
    </div>
  {/if}
  <dl class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
    <div>
      <dt class={label}>Hunt status</dt>
      <dd
        data-testid="bug-report-hunt-status"
        class="mt-0.5 font-mono text-xs {failed
          ? 'font-bold text-[var(--color-danger-text)]'
          : 'text-[var(--color-text)]'}"
      >
        {details.hunt.status}
      </dd>
    </div>
    <div>
      <dt class={label}>Files scanned / tracked</dt>
      <dd
        data-testid="bug-report-hunt-coverage"
        class="mt-0.5 font-mono text-xs {details.hunt.scanned_files !== details.hunt.tracked_source_files
          ? 'font-bold text-[var(--color-danger-text)]'
          : 'text-[var(--color-text)]'}"
      >
        {details.hunt.scanned_files} / {details.hunt.tracked_source_files}
      </dd>
    </div>
    <div>
      <dt class={label}>Repository</dt>
      <dd class="mt-0.5 font-mono text-xs text-[var(--color-text)]">{details.repo}</dd>
    </div>
    <div>
      <dt class={label}>Commit</dt>
      <dd class="mt-0.5 break-all font-mono text-xs text-[var(--color-text)]">{details.commit_sha}</dd>
    </div>
    <div>
      <dt class={label}>Content hash (H<sub>r</sub>)</dt>
      <dd data-testid="bug-report-hash" class="mt-0.5 break-all font-mono text-xs text-[var(--color-text)]">
        {contentHash ?? '—'}
      </dd>
    </div>
    <div>
      <dt class={label}>Trace</dt>
      <dd data-testid="bug-report-trace" class="mt-0.5 break-all font-mono text-xs text-[var(--color-text)]">
        {traceId ?? 'none (orphan write)'}
      </dd>
    </div>
  </dl>

  {#if details.hunt.root_cause_analysis}
    <p data-testid="bug-report-rca" class="mb-4 whitespace-pre-wrap text-sm text-[var(--color-text)]">
      <span class={label}>Analyzer summary</span><br />{details.hunt.root_cause_analysis}
    </p>
  {/if}

  {#if failed}
    <p data-testid="bug-report-result-unknown" class="text-sm font-medium text-[var(--color-danger-text)]">
      Bugs: result unknown (the hunt did not complete).
    </p>
  {:else if details.bugs.length === 0}
    <p data-testid="bug-report-no-bugs" class="text-sm text-[var(--color-text)]">
      The hunt completed and found no bugs.
    </p>
  {:else}
  <h2 class="mb-1 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
    Bugs ({details.bugs.length})
  </h2>
  <div class="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
    <table class="w-full min-w-[48rem] border-collapse text-left">
      <thead class="bg-[var(--color-surface)]">
        <tr>
          <th class="px-3 py-2 {label}">Bug</th>
          <th class="px-3 py-2 {label}">Location</th>
          <th class="px-3 py-2 {label}">Failing test</th>
          <th class="px-3 py-2 {label}">Fix outline</th>
        </tr>
      </thead>
      <tbody>
        {#each details.bugs as bug (bug.id)}
          <tr data-testid="bug-report-row">
            <td class={cell}>
              <div class="text-xs font-medium" data-testid="bug-report-kind">{bug.kind}</div>
              <span class="font-mono text-[10px] text-[var(--color-text-muted)]" title={bug.id}>{bug.id.slice(0, 12)}</span>
              {#if bug.severity}
                <div class="mt-0.5 text-xs text-[var(--color-text-muted)]">{bug.severity}</div>
              {/if}
            </td>
            <td class="{cell} font-mono text-xs">{bug.location.file}:{bug.location.line}</td>
            <td class={cell}>
              <div class="font-mono text-xs">{bug.failing_test.path}</div>
              <div class="mt-0.5 text-xs text-[var(--color-text-muted)]">{bug.failing_test.name}</div>
            </td>
            <td class={cell}>
              <ol class="list-decimal pl-4 text-sm">
                {#each bug.fix_outline as step, i (i)}
                  <li>{step}</li>
                {/each}
              </ol>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {/if}
</section>
