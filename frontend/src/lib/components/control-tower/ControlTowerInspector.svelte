<script lang="ts">
  // Right-hand inspector for the control tower. Super-admin surface, so raw ids
  // are allowed. Hydrated entirely from the already-fetched blocks (no sub-fetch)
  // via the shared inspector selection. Two selection kinds: a tenant row or
  // an alert. Sections follow the proposal:
  // the selected object's detail (workflow pointer / identity), honest mandate
  // checks (data-gaps are named, not faked), and an advisory recommended action
  // (copy, NOT a control).
  import Tag from '$lib/components/ui/Tag.svelte';
  import type {
    InspectKind,
    TenantHealthRow,
    ControlAlert,
  } from '$lib/types/control-tower';
  import {
    alertTone,
    tenantKindLabel,
  } from './logic';

  interface Props {
    kind: InspectKind;
    payload: TenantHealthRow | ControlAlert;
    onclose: () => void;
  }
  let { kind, payload, onclose }: Props = $props();

  const tenant = $derived(kind === 'tenant' ? (payload as TenantHealthRow) : null);
  const alert = $derived(kind === 'alert' ? (payload as ControlAlert) : null);

  const heading = $derived(
    tenant ? tenant.name : (alert?.title ?? 'Selection'),
  );
</script>

<aside class="flex h-full flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="control-tower-inspector">
  <div class="flex items-start justify-between gap-2 border-b border-[var(--color-border)] p-3">
    <div class="min-w-0">
      <p class="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Selected {kind}</p>
      <h2 class="truncate text-sm font-bold text-[var(--color-text)]">{heading}</h2>
    </div>
    <button type="button" onclick={onclose} class="rounded-md px-2 py-1 text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-strong)]" aria-label="Close inspector">✕</button>
  </div>

  <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
    {#if tenant}
      <section>
        <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Workspace</h3>
        <dl class="space-y-1 text-xs">
          <div class="flex justify-between gap-2"><dt class="text-[var(--color-text-muted)]">Tenant</dt><dd class="font-mono text-[var(--color-text)]">{tenant.tenant_id}</dd></div>
          <div class="flex justify-between gap-2"><dt class="text-[var(--color-text-muted)]">Kind</dt><dd class="text-[var(--color-text)]">{tenantKindLabel(tenant.kind)}</dd></div>
          <div class="flex justify-between gap-2"><dt class="text-[var(--color-text-muted)]">Board</dt><dd class="font-mono text-[var(--color-text)]">{tenant.board_id ?? 'none'}</dd></div>
          <div class="flex justify-between gap-2"><dt class="text-[var(--color-text-muted)]">WIP / blocked</dt><dd class="text-[var(--color-text)]">{tenant.wip} / {tenant.blocked}</dd></div>
          <div class="flex justify-between gap-2"><dt class="text-[var(--color-text-muted)]">Andon</dt><dd><Tag tone={tenant.andon_engaged ? 'danger' : 'success'}>{tenant.andon_engaged ? 'engaged' : 'clear'}</Tag></dd></div>
        </dl>
      </section>
      <section>
        <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Mandate checks</h3>
        <p class="text-xs text-[var(--color-text-muted)]">
          {tenant.board_available ? 'Board reachable.' : 'Board unreachable — WIP/blocked counts default to 0.'}
          {tenant.archived ? ' Workspace archived.' : ''}
        </p>
      </section>
    {:else if alert}
      <section>
        <div class="mb-2"><Tag tone={alertTone(alert.severity)} dot>{alert.severity}</Tag></div>
        <p class="text-sm font-semibold text-[var(--color-text)]">{alert.title}</p>
        <p class="mt-1 text-xs text-[var(--color-text-muted)]">{alert.detail}</p>
        {#if alert.link}<p class="mt-2 font-mono text-[11px] text-[var(--color-text-muted)]">→ {alert.link}</p>{/if}
      </section>
    {/if}
  </div>
</aside>
