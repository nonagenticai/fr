<!--
  ChannelsList — unified table for the /channels global list and the
  per-project streams view.

  Renders rows from `listUnifiedChannels()` (Plan 2-C Phase 1.1):
  notification-channel rows + scheduled-intake triggers. Each kind has its
  own detail link pattern:

    notification:        /channels/<id>
    scheduled_intake:    /channels/<id>?kind=schedule-intake

  The wire `kind` discriminator is snake_case (matches the
  `scheduled_trigger_runs.trigger_kind` constraint set in migrations 041 +
  042). The URL `?kind=` query param uses kebab-case purely as a
  UI-routing convention (consumed by the /channels/[id] and /channels/new
  pages in Phase 2/4).

  Plan: docs/superpowers/plans/2026-04-29-spec-2-plan-c-ui-surfaces.md §1.2.
-->
<script lang="ts">
  import type { WireUnifiedChannel } from '$lib/api/unifiedChannels';

  let {
    rows,
    projectScope = false,
  }: { rows: WireUnifiedChannel[]; projectScope?: boolean } = $props();

  function detailHref(r: WireUnifiedChannel): string {
    if (r.kind === 'scheduled_intake') {
      return `/channels/${r.id}?kind=schedule-intake`;
    }
    return `/channels/${r.id}`;
  }

  function kindLabel(k: WireUnifiedChannel['kind']): string {
    switch (k) {
      case 'scheduled_intake':
        return 'Intake';
      default:
        return k.charAt(0).toUpperCase() + k.slice(1);
    }
  }

  function kindBadgeClass(k: WireUnifiedChannel['kind']): string {
    const base =
      'inline-block px-2 py-0.5 rounded text-xs font-medium border';
    switch (k) {
      case 'teams':
        return `${base} bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent)]`;
      case 'telegram':
        return `${base} bg-[var(--color-info-bg)] text-[var(--color-info-text)] border-[var(--color-info-border)]`;
      case 'email':
        return `${base} bg-[var(--color-surface-strong)] text-[var(--color-accent)] border-[var(--color-border)]`;
      case 'web':
        return `${base} bg-[var(--color-info-bg)] text-[var(--color-info-text)] border-[var(--color-info-border)]`;
      case 'inapp':
        return `${base} bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)]`;
      case 'voice':
        return `${base} bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-bg)]`;
      case 'scheduled_intake':
        return `${base} bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent)]`;
    }
  }

  function statusCell(r: WireUnifiedChannel): string {
    if (r.kind === 'scheduled_intake') {
      return (r.enabled ?? true) ? 'Enabled' : 'Disabled';
    }
    return '—';
  }

  function projectCell(r: WireUnifiedChannel): string {
    if ('project_id' in r && typeof r.project_id === 'string') {
      return r.project_id;
    }
    if ('dept_id' in r && typeof r.dept_id === 'string' && r.dept_id) {
      return `dept:${r.dept_id}`;
    }
    return 'workspace';
  }

  function formatCreated(r: WireUnifiedChannel): string {
    if ('created_at' in r && r.created_at) {
      try {
        return new Date(r.created_at).toLocaleString();
      } catch {
        return r.created_at;
      }
    }
    return '—';
  }
</script>

<table
  class="channels-list w-full border rounded text-sm"
  data-testid="channels-list"
>
  <thead
    class="text-left text-xs uppercase text-[var(--color-text-muted)] bg-[var(--color-surface-strong)]"
  >
    <tr>
      <th class="p-3">Name</th>
      <th class="p-3">Kind</th>
      {#if !projectScope}<th class="p-3">Project</th>{/if}
      <th class="p-3">Status</th>
      <th class="p-3">Created</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as r (r.id)}
      <tr class="border-t" data-testid={`channels-row-${r.id}`}>
        <td class="p-3 font-medium">
          <a
            href={detailHref(r)}
            class="text-[var(--color-accent-strong)] hover:underline dark:text-[var(--color-accent)]"
          >
            {r.name}
          </a>
        </td>
        <td class="p-3">
          <span class={kindBadgeClass(r.kind)}>{kindLabel(r.kind)}</span>
        </td>
        {#if !projectScope}
          <td class="p-3 text-xs text-[var(--color-text-muted)]">
            {projectCell(r)}
          </td>
        {/if}
        <td class="p-3 text-xs text-[var(--color-text-muted)]">
          {statusCell(r)}
        </td>
        <td class="p-3 text-xs text-[var(--color-text-muted)]">
          {formatCreated(r)}
        </td>
      </tr>
    {/each}
    {#if rows.length === 0}
      <tr>
        <td
          colspan={projectScope ? 4 : 5}
          class="p-8 text-center text-[var(--color-text-muted)]"
          data-testid="channels-list-empty"
        >
          No channels yet.
        </td>
      </tr>
    {/if}
  </tbody>
</table>
