<!--
  PromoteOverrideBlockMenu.svelte
  ================================
  Inline action group for a Library entry detail / row. Four actions:

    - Promote to Workspace   (canPromoteWorkspace)
    - Promote to Department  (canPromoteDept)
    - Override here          (canOverride)
    - Block here             (canBlock)

  Spec §6.4 (2): "Promote / demote / override / block action buttons inline
                  in entry detail and in the project Knowledge tab."

  RBAC drives enablement (Spec §11). We render four separate buttons rather
  than a single dropdown menu so the available capabilities are visible at a
  glance — this matches the spec wording ("action buttons") and lets the
  parent surface gate each action independently via the can* props. Visual
  decision: separate buttons, ghost variant when disabled, secondary when
  enabled, accent for the most-prominent "Promote to Workspace" action.

  When the caller doesn't pass a handler for an action, the action is shown
  as disabled regardless of its can* flag — there's nothing to fire.
-->
<script lang="ts">
  let {
    canPromoteWorkspace = false,
    canPromoteDept = false,
    canOverride = false,
    canBlock = false,
    onPromoteWorkspace,
    onPromoteDept,
    onOverride,
    onBlock,
  }: {
    canPromoteWorkspace?: boolean;
    canPromoteDept?: boolean;
    canOverride?: boolean;
    canBlock?: boolean;
    onPromoteWorkspace?: () => void;
    onPromoteDept?: () => void;
    onOverride?: () => void;
    onBlock?: () => void;
  } = $props();

  const promoteWsDisabled = $derived(
    !canPromoteWorkspace || onPromoteWorkspace === undefined,
  );
  const promoteDeptDisabled = $derived(
    !canPromoteDept || onPromoteDept === undefined,
  );
  const overrideDisabled = $derived(!canOverride || onOverride === undefined);
  const blockDisabled = $derived(!canBlock || onBlock === undefined);

  const baseBtn =
    'inline-flex items-center justify-center h-8 px-3 text-sm font-medium rounded-[var(--radius-sm)] transition disabled:opacity-50 disabled:cursor-not-allowed';
  const primary =
    'bg-[var(--color-accent)] text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)]';
  const secondary =
    'bg-[var(--color-surface-strong)] text-[var(--color-text)] hover:bg-[var(--color-border)]';
  const danger = 'bg-[var(--color-danger)] text-[var(--color-on-primary)] hover:opacity-90';
</script>

<div
  data-testid="promote-override-block-menu"
  role="group"
  aria-label="Promote, override, or block"
  class="inline-flex items-center gap-2"
>
  <button
    type="button"
    data-testid="action-promote-workspace"
    disabled={promoteWsDisabled}
    onclick={onPromoteWorkspace}
    class={`${baseBtn} ${primary}`}
  >
    Promote to Workspace
  </button>

  <button
    type="button"
    data-testid="action-promote-dept"
    disabled={promoteDeptDisabled}
    onclick={onPromoteDept}
    class={`${baseBtn} ${secondary}`}
  >
    Promote to Department
  </button>

  <button
    type="button"
    data-testid="action-override"
    disabled={overrideDisabled}
    onclick={onOverride}
    class={`${baseBtn} ${secondary}`}
  >
    Override here
  </button>

  <button
    type="button"
    data-testid="action-block"
    disabled={blockDisabled}
    onclick={onBlock}
    class={`${baseBtn} ${danger}`}
  >
    Block here
  </button>
</div>
