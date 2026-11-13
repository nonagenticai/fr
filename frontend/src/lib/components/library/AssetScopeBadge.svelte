<!--
  AssetScopeBadge.svelte
  ======================
  Plan: ~/.claude/plans/fr-asset-bindings-and-reuse.md (Phase D)

  Small chip rendering an asset's origin (Tenant / Project / Auto).
  Origin is immutable provenance — separate from bindings, which are
  the mutable many-to-many to projects.
-->
<script lang="ts">
  type OriginKind = 'tenant' | 'project' | 'workflow';

  let {
    origin_kind,
    origin_project_id = null,
    origin_workflow_run_id = null,
    project_name = null,
    workflow_name = null,
  }: {
    origin_kind: OriginKind;
    origin_project_id?: string | null;
    origin_workflow_run_id?: string | null;
    project_name?: string | null;
    workflow_name?: string | null;
  } = $props();

  const label = $derived(
    origin_kind === 'tenant'
      ? 'Tenant'
      : origin_kind === 'project'
        ? `Project${project_name ? `: ${project_name}` : ''}`
        : `Auto${workflow_name ? `: ${workflow_name}` : ''}`,
  );

  // Re-use the same design-token colour buckets as the existing
  // ScopePill (workspace=warning, project=success), with a new "auto"
  // bucket for workflow-origin to visually mark it as machine-authored.
  const cls = $derived(
    origin_kind === 'tenant'
      ? 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-border)]'
      : origin_kind === 'project'
        ? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success-border)]'
        : 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent-border)]',
  );

  const title = $derived(
    origin_kind === 'workflow' && origin_workflow_run_id
      ? `Authored by workflow run ${origin_workflow_run_id}`
      : origin_kind === 'project' && origin_project_id
        ? `Created inside project ${origin_project_id}`
        : 'Created at tenant level',
  );
</script>

<span
  data-testid="asset-scope-badge"
  data-origin={origin_kind}
  class={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium border rounded ${cls}`}
  {title}
>
  {label}
</span>
