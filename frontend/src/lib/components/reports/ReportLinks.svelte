<!--
  ReportLinks — U2 design item 3: link the stored reports (project_reports,
  e.g. a `bug_report`) from the project cockpit and the card detail view.

  Reads GET /api/reports?project_id= or ?card_id= (tenant-scoped server-side)
  and lists each row as a link to /reports/<id>.

  G5: the CONVEYOR does not write project_reports — it stores each card's
  report as a `report.json` in the artifacts service, keyed on the fr project id.
  The cockpit passes those in (`conveyorReports`, the cockpit's `reports` block,
  read with the same artifacts call as the Needs-you queue) and they are listed
  here with their own review status. Four states, and "could not
  read" is never collapsed into "none": a failed read says so.

  On a CLOSED project (`closed`, from rm_status) drafts are never offered: only the final
  report is listed, the other published reports sit in a collapsed list, and drafts are
  hidden (cockpit spec C2/C6 — nothing on a closed project asks for review).
-->
<script lang="ts">
  import { listReports, type ListReportsOptions, type ProjectReport } from '$lib/api/reports';
  import { isHuntComplete, parseBugReportDetails } from '$lib/api/bug-report';
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { CockpitReport } from '$lib/types/cockpit';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';

  let {
    projectId = undefined,
    cardId = undefined,
    limit = 10,
    conveyorReports = undefined,
    storedReports = undefined,
    closed = false,
  }: {
    projectId?: string;
    cardId?: string;
    limit?: number;
    /** The cockpit's `reports` block (artifacts `report.json`); absent off the cockpit. */
    conveyorReports?: Panel<CockpitReport[]>;
    /** The cockpit's `stored_reports` panel: when given, fr's own reports are NOT fetched again. */
    storedReports?: Panel<ProjectReport[]>;
    /** The project is closed (rm_status=closed): drafts hidden, final report first, others collapsed. */
    closed?: boolean;
  } = $props();

  type View =
    | { kind: 'reading' }
    | { kind: 'failed'; message: string }
    | { kind: 'listed'; rows: ProjectReport[] };
  let view = $state<View>({ kind: 'reading' });

  $effect(() => {
    const opts: ListReportsOptions = { projectId, cardId, limit };
    if (storedReports) {
      // Cockpit mode: the read model already read them (one call for the page).
      view = hasData(storedReports)
        ? { kind: 'listed', rows: storedReports.data.slice(0, limit) }
        : { kind: 'failed', message: '' };
      return;
    }
    if (!projectId && !cardId) return;
    view = { kind: 'reading' };
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listReports(opts);
        if (!cancelled) view = { kind: 'listed', rows };
      } catch (e) {
        if (!cancelled) view = { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // A stored bug_report is always a complete hunt (the backend refuses any
  // other), but a row written around the route must still not read as clean.
  function failedHunt(r: ProjectReport): boolean {
    if (r.report_type !== 'bug_report') return false;
    const parsed = parseBugReportDetails(r.details);
    return parsed !== null && !isHuntComplete(parsed.hunt);
  }

  const allConveyorRows = $derived(conveyorReports && hasData(conveyorReports) ? conveyorReports.data : []);
  /** Closed project: the final report (else the newest published one) — never a draft. */
  const finalReport = $derived.by((): CockpitReport | null => {
    if (!closed) return null;
    const published = allConveyorRows.filter((r) => r.publish_status === 'published');
    return (
      published.find((r) => r.is_final) ??
      [...published].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ??
      null
    );
  });
  /** Closed project: the other PUBLISHED reports, collapsed. Drafts are not listed at all. */
  const earlierReports = $derived(
    closed ? allConveyorRows.filter((r) => r.publish_status === 'published' && r.id !== finalReport?.id) : [],
  );
  const conveyorRows = $derived(closed ? (finalReport ? [finalReport] : []) : allConveyorRows);
  const conveyorFailed = $derived(conveyorReports !== undefined && conveyorReports.health === 'down');
  const total = $derived(
    (view.kind === 'listed' ? view.rows.length : 0) + conveyorRows.length + earlierReports.length,
  );

  function when(iso: string): string {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  }
  /**
   * The conveyor stores reports with no card link (card_id/step NULL on run 7), so
   * the label is the time; a card name is used only when the card id resolves on
   * this board. The newest PUBLISHED one is the project's final report.
   */
  function reportName(r: CockpitReport): string {
    if (r.is_final) return 'Final report';
    return r.card_name ?? `Report · ${when(r.created_at)}`;
  }
  const PUBLISH_LABEL: Record<string, string> = { published: 'Published', draft: 'Draft' };
  // No per-id artifact route exists; the tenant Artifacts page anchors each row by id.
  const artifactHref = (id: string): string => `/library/artifacts#artifact-${encodeURIComponent(id)}`;

  // Known types get a human label; anything else shows its raw type.
  const TYPE_LABELS: Record<string, string> = { phase_gate: 'Phase gate' };
  function typeLabel(t: string): string {
    return TYPE_LABELS[t] ?? t;
  }
</script>

<section data-testid="report-links">
  <h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
    Reports{total > 0 ? ` · ${total}` : ''}
  </h3>
  {#if view.kind === 'reading'}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="report-links-reading">Reading reports…</p>
  {:else if view.kind === 'failed'}
    <div class="text-xs text-[var(--color-warning-text)]" data-testid="report-links-failed">
      {#if storedReports}
        <PanelNote panel={storedReports} title="The reports" />
      {:else}
        Reports could not be read — this is not "none". Retrying on the next refresh.
      {/if}
    </div>
  {:else if view.rows.length === 0 && closed}
    <!-- A closed project's outcome is its final report; "no gate report yet" would read as unfinished. -->
    {#if !finalReport && !conveyorFailed}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="report-links-no-final">
        No final report was published for this project.
      </p>
    {/if}
  {:else if view.rows.length === 0 && conveyorRows.length > 0}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="report-links-no-gate">
      No phase-gate report yet.
    </p>
  {:else if view.rows.length === 0}
    <!-- UI review 2026-10-07: "No reports yet" read as "wait and one will
         appear". Project reports are PHASE-GATE reports (George 2026-10-08):
         fr writes one each time the project passes a lifecycle gate. Say that,
         and point at the live computed status report meanwhile. -->
    {#if projectId}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="report-links-none">
        A report is written each time this project passes a lifecycle gate; it has not passed one yet.
        <a
          class="text-[var(--color-accent)] hover:underline"
          href={`/reports/project-status/${encodeURIComponent(projectId)}`}
          data-testid="report-links-live-status">View the live project status report</a
        >.
      </p>
    {:else}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="report-links-none">No reports yet.</p>
    {/if}
  {:else}
    <ul class="space-y-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
      {#each view.rows as r (r.id)}
        <li class="flex flex-wrap items-baseline gap-2 text-xs" data-testid="report-link-row">
          <a class="text-[var(--color-accent)] hover:underline" href={`/reports/${encodeURIComponent(r.id)}`}>
            {r.title}
          </a>
          <span class="font-mono text-[11px] text-[var(--color-text-muted)]" data-testid="report-link-type"
            >{typeLabel(r.report_type)}</span
          >
          {#if failedHunt(r)}
            <span class="font-bold uppercase text-[var(--color-danger-text)]" data-testid="report-link-hunt-failed">
              hunt incomplete
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if conveyorFailed}
    <div class="mt-1" data-testid="conveyor-reports-failed">
      {#if conveyorReports}<PanelNote panel={conveyorReports} title="The conveyor's reports" />{/if}
    </div>
  {:else if conveyorRows.length > 0}
    <ul
      class="mt-1 space-y-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
      data-testid="conveyor-reports"
    >
      {#each conveyorRows as r (r.id)}
        <li class="flex flex-wrap items-baseline gap-2 text-xs" data-testid="conveyor-report-row">
          <a class="text-[var(--color-accent)] hover:underline" href={artifactHref(r.id)} data-testid="conveyor-report-link">
            {reportName(r)}
          </a>
          {#if r.publish_status}
            <span
              class={`rounded border px-1 text-[10px] ${r.publish_status === 'published' ? 'border-[var(--color-success-border)] text-[var(--color-success-text)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}`}
              data-testid="conveyor-report-publish"
              data-state={r.publish_status}>{PUBLISH_LABEL[r.publish_status]}</span
            >
          {/if}
          <!-- Review status only once someone reviewed it: every conveyor report is
               born `pending`, and "pending" next to a published report read as "not ready". -->
          {#if r.status && r.status !== 'pending'}
            <span
              class="rounded border border-[var(--color-border)] px-1 text-[10px] text-[var(--color-text-muted)]"
              data-testid="conveyor-report-status">{r.status.replace('_', ' ')}</span
            >
          {/if}
          {#if r.is_final || r.card_name}
            <span class="text-[11px] text-[var(--color-text-muted)]" data-testid="conveyor-report-created"
              >{when(r.created_at)}</span
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if !conveyorFailed && earlierReports.length > 0}
    <details class="mt-1 text-xs" data-testid="conveyor-reports-earlier">
      <summary class="cursor-pointer text-[var(--color-text-muted)]">
        Earlier reports ({earlierReports.length})
      </summary>
      <ul class="mt-1 space-y-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
        {#each earlierReports as r (r.id)}
          <li class="flex flex-wrap items-baseline gap-2" data-testid="conveyor-report-earlier-row">
            <a class="text-[var(--color-accent)] hover:underline" href={artifactHref(r.id)}>{reportName(r)}</a>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</section>
