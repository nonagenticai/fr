<!--
  InheritanceBreadcrumb.svelte
  =============================
  Inline string rendered on a Library entry detail surfacing where the
  asset is defined and how many descendants inherit / override / block it.

  Spec §6.4 (1):
    "Defined at: Workspace · Inherited by: 5 departments, 23 projects ·
     2 overrides, 1 block"

  We only render the segments that actually have something to say; e.g.
  hide the "overrides" tail when override_count = 0 to keep the row tidy
  on a project-scope asset that nothing has touched yet.
-->
<script lang="ts">
  type Scope = 'workspace' | 'department' | 'project';

  let {
    defined_at,
    inherited_by_depts = 0,
    inherited_by_projects = 0,
    override_count = 0,
    block_count = 0,
  }: {
    defined_at: Scope;
    inherited_by_depts?: number;
    inherited_by_projects?: number;
    override_count?: number;
    block_count?: number;
  } = $props();

  const definedAtLabel = $derived(
    {
      workspace: 'Workspace',
      department: 'Department',
      project: 'Project',
    }[defined_at]
  );

  function plural(n: number, singular: string, pluralWord?: string): string {
    return `${n} ${n === 1 ? singular : pluralWord ?? `${singular}s`}`;
  }

  const inheritedSegments = $derived(
    [
      inherited_by_depts > 0
        ? plural(inherited_by_depts, 'department')
        : null,
      inherited_by_projects > 0
        ? plural(inherited_by_projects, 'project')
        : null,
    ].filter((x): x is string => x !== null)
  );

  const adjustmentSegments = $derived(
    [
      override_count > 0 ? plural(override_count, 'override') : null,
      block_count > 0 ? plural(block_count, 'block') : null,
    ].filter((x): x is string => x !== null)
  );
</script>

<span
  data-testid="inheritance-breadcrumb"
  class="text-xs text-[var(--color-text-muted)]"
>
  <span data-testid="inheritance-defined-at">Defined at: {definedAtLabel}</span>
  {#if inheritedSegments.length > 0}
    <span aria-hidden="true"> · </span>
    <span data-testid="inheritance-inherited-by">
      Inherited by: {inheritedSegments.join(', ')}
    </span>
  {/if}
  {#if adjustmentSegments.length > 0}
    <span aria-hidden="true"> · </span>
    <span data-testid="inheritance-adjustments">
      {adjustmentSegments.join(', ')}
    </span>
  {/if}
</span>
