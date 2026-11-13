<!--
  /admin/onboarding — the early-access signup queue (early-access signup v2).

  Visitors ask for access on nonagentic.ai/early-access/fr; George approves in
  Telegram (one tap) or here. Approve founds a new workspace (name editable
  here, defaulted otherwise), seats the requester as its admin, ensures the
  conveyor bundle and only THEN sends one set-password email in the person's
  language — the link lands them in fr signed in. "Invite to early access"
  does the same for someone who never filled in the form, with a language
  picker for the email.

  Super-admin only (fr is super_admin-provisioning-only, George 2026-10-12);
  every endpoint re-gates on the server. The Telegram "Open in fr" button
  deep-links here with ?signup=<id>.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    approveSignup,
    getSignupApproval,
    inviteSignup,
    listSignupApprovals,
    rejectSignup,
    removeSignup,
    resolveSignupRemoval,
    resolveSignupRepair,
    retrySignupRemoval,
    retrySignupSteps,
    SIGNUP_LOCALES,
    SignupApiError,
    type SignupApproval,
    type SignupListFilter,
    type SignupLocale,
  } from '$lib/api/signup-approvals';
  import { LOCALE_LABELS, canRemove, inviteFormError, removalRows, rowAction, statusLabel, stepRows } from './page-helpers';

  const FILTERS: Array<{ value: SignupListFilter; label: string }> = [
    { value: 'pending', label: 'Pending' },
    { value: 'needs_attention', label: 'Needs attention' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'removed', label: 'Removed' },
  ];

  let filter = $state<SignupListFilter>('pending');
  let items = $state<SignupApproval[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let notConfigured = $state(false);
  let focused = $state<SignupApproval | null>(null);

  // Per-row inputs and outcomes.
  let tenantNames = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let rowMessage = $state<Record<string, { tone: 'ok' | 'error'; text: string }>>({});
  let resolveNotes = $state<Record<string, string>>({});
  let resolveAck = $state<Record<string, boolean>>({});
  // Remove workspace: the slug typed back, per row.
  let removeOpen = $state<Record<string, boolean>>({});
  let removeConfirm = $state<Record<string, string>>({});

  // Invite form.
  let inviteEmail = $state('');
  let inviteName = $state('');
  let inviteCompany = $state('');
  let inviteTenantName = $state('');
  let inviteLocale = $state<SignupLocale>('en');
  let inviteBusy = $state(false);
  let inviteMessage = $state<{ tone: 'ok' | 'error'; text: string } | null>(null);

  function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      items = await listSignupApprovals(filter);
      notConfigured = false;
    } catch (err) {
      if (err instanceof SignupApiError && err.code === 'signup_not_configured') notConfigured = true;
      else loadError = describe(err);
      items = [];
    } finally {
      loading = false;
    }
  }

  async function loadFocused(id: string): Promise<void> {
    try {
      focused = await getSignupApproval(id);
    } catch (err) {
      loadError = `Signup ${id}: ${describe(err)}`;
    }
  }

  onMount(() => {
    void load();
    const id = page.url.searchParams.get('signup');
    if (id) void loadFocused(id);
  });

  async function selectFilter(f: SignupListFilter): Promise<void> {
    if (f === filter) return;
    filter = f;
    await load();
  }

  function replace(updated: SignupApproval): void {
    items = items.map((a) => (a.id === updated.id ? updated : a));
    if (focused?.id === updated.id) focused = updated;
  }

  async function act(id: string, run: () => Promise<{ row: SignupApproval; text: string }>): Promise<void> {
    busy = { ...busy, [id]: true };
    try {
      const { row, text } = await run();
      replace(row);
      rowMessage = { ...rowMessage, [id]: { tone: 'ok', text } };
    } catch (err) {
      rowMessage = { ...rowMessage, [id]: { tone: 'error', text: describe(err) } };
    } finally {
      busy = { ...busy, [id]: false };
    }
  }

  const approve = (a: SignupApproval) =>
    act(a.id, async () => {
      const out = await approveSignup(a.id, tenantNames[a.id]);
      return {
        row: out.approval,
        text:
          `Approved into “${out.tenant.name}” (${out.tenant.slug}). ` +
          (out.emailState === 'sent'
            ? 'The set-password email is on its way.'
            : `The email follows once every step is ok (not ok: ${out.stepsNotOk.map((s) => s.step).join(', ')}).`),
      };
    });

  const reject = (a: SignupApproval) =>
    act(a.id, async () => {
      const row = await rejectSignup(a.id);
      return { row, text: 'Rejected.' };
    });

  const retrySteps = (a: SignupApproval) =>
    act(a.id, async () => {
      const row = await retrySignupSteps(a.id);
      return { row, text: row.email_state === 'sent' ? 'All steps done; the email is sent.' : 'Retried; some steps are still not ok.' };
    });

  const resolve = (a: SignupApproval) =>
    act(a.id, async () => {
      const row = await resolveSignupRepair(a.id, resolveNotes[a.id] ?? '', resolveAck[a.id] === true);
      return { row, text: 'Cleanup closed by hand.' };
    });

  /** A refused removal still changed the row (failed / blocked): reload it so its state shows. */
  async function removalAct(a: SignupApproval, run: () => Promise<SignupApproval>, okText: string): Promise<void> {
    await act(a.id, async () => ({ row: await run(), text: okText }));
    if (rowMessage[a.id]?.tone === 'error') {
      try {
        replace(await getSignupApproval(a.id));
      } catch (err) {
        rowMessage = { ...rowMessage, [a.id]: { tone: 'error', text: `${rowMessage[a.id]!.text} (reload failed: ${describe(err)})` } };
      }
    }
  }

  const remove = (a: SignupApproval) =>
    removalAct(a, () => removeSignup(a.id, removeConfirm[a.id] ?? ''), 'Workspace removed: every licence revoked, tenant and workspace archived, login deleted.');

  const retryRemoval = (a: SignupApproval) => removalAct(a, () => retrySignupRemoval(a.id), 'Removal finished.');

  const resolveRemoval = (a: SignupApproval) =>
    act(a.id, async () => ({ row: await resolveSignupRemoval(a.id, resolveNotes[a.id] ?? '', resolveAck[a.id] === true), text: 'Removal closed by hand.' }));

  async function invite(): Promise<void> {
    const input = {
      email: inviteEmail,
      name: inviteName,
      company: inviteCompany,
      tenantName: inviteTenantName,
      locale: inviteLocale,
    };
    const problem = inviteFormError(input);
    if (problem) {
      inviteMessage = { tone: 'error', text: problem };
      return;
    }
    inviteBusy = true;
    inviteMessage = null;
    try {
      const out = await inviteSignup(input);
      inviteMessage = {
        tone: 'ok',
        text:
          `Invited ${out.approval.email} into “${out.tenant.name}” (${out.tenant.slug}). ` +
          (out.emailState === 'sent' ? 'The set-password email is on its way.' : 'The email follows once every step is ok.') +
          (out.reusedPending ? ' (Their pending request was approved.)' : ''),
      };
      inviteEmail = inviteName = inviteCompany = inviteTenantName = '';
      inviteLocale = 'en';
      await load();
    } catch (err) {
      inviteMessage = { tone: 'error', text: describe(err) };
    } finally {
      inviteBusy = false;
    }
  }

  const visible = $derived(focused && !items.some((a) => a.id === focused!.id) ? [focused, ...items] : items);
</script>

<section class="flex flex-col gap-6 p-6" data-testid="admin-onboarding-page">
  <header>
    <h1 class="text-xl font-semibold">Early access</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      Requests from nonagentic.ai/early-access/fr and invites. Approve founds a workspace on the conveyor bundle and
      sends one set-password email in the person’s language. Super-admin only.
    </p>
  </header>

  {#if !auth.isSuperAdmin}
    <div class="rounded-md border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-4 text-sm text-[var(--color-danger)]" role="alert">
      Super-admin role required.
    </div>
  {:else if notConfigured}
    <div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm" role="status" data-testid="signup-not-configured">
      Early-access signup is not enabled on this deployment (FR_SIGNUP_ENABLED).
    </div>
  {:else}
    <!-- Invite -->
    <form
      class="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      data-testid="invite-form"
      onsubmit={(e) => {
        e.preventDefault();
        void invite();
      }}
    >
      <h2 class="text-base font-semibold">Invite to early access</h2>
      <div class="grid grid-cols-1 gap-3 md:grid-cols-5">
        <label class="flex flex-col gap-1 text-sm">
          Email
          <input class="rounded border border-[var(--color-border)] px-2 py-1" type="email" required bind:value={inviteEmail} data-testid="invite-email" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Name
          <input class="rounded border border-[var(--color-border)] px-2 py-1" required maxlength="160" bind:value={inviteName} data-testid="invite-name" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Company (optional)
          <input class="rounded border border-[var(--color-border)] px-2 py-1" maxlength="160" bind:value={inviteCompany} />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Workspace name (optional)
          <input class="rounded border border-[var(--color-border)] px-2 py-1" maxlength="120" bind:value={inviteTenantName} />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          Email language
          <select class="rounded border border-[var(--color-border)] px-2 py-1" bind:value={inviteLocale} data-testid="invite-locale">
            {#each SIGNUP_LOCALES as l (l)}
              <option value={l}>{LOCALE_LABELS[l]}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="flex items-center gap-3">
        <button
          type="submit"
          class="rounded bg-[var(--color-accent)] px-3 py-1 text-sm text-white disabled:opacity-50"
          disabled={inviteBusy}
        >{inviteBusy ? 'Inviting…' : 'Invite'}</button>
        {#if inviteMessage}
          <p class="text-sm {inviteMessage.tone === 'ok' ? '' : 'text-[var(--color-danger)]'}" role={inviteMessage.tone === 'ok' ? 'status' : 'alert'}>
            {inviteMessage.text}
          </p>
        {/if}
      </div>
    </form>

    <!-- Queue -->
    <div class="flex gap-2 text-xs" data-testid="signup-filters">
      {#each FILTERS as f (f.value)}
        <button
          type="button"
          class="rounded border px-2 py-1 {filter === f.value ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] bg-[var(--color-surface)]'}"
          onclick={() => selectFilter(f.value)}
        >{f.label}</button>
      {/each}
    </div>

    {#if loading}
      <p class="text-sm text-[var(--color-text-muted)]" role="status">Loading signups…</p>
    {:else if loadError}
      <div class="rounded-md border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-4 text-sm text-[var(--color-danger)]" role="alert">
        {loadError}
      </div>
    {:else if visible.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="signup-empty">No signups in this view.</p>
    {:else}
      <ul class="flex flex-col gap-3" data-testid="signup-list">
        {#each visible as a (a.id)}
          {@const action = rowAction(a)}
          <li
            class="flex flex-col gap-2 rounded-[var(--radius-md)] border p-4 {focused?.id === a.id ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'} bg-[var(--color-surface)]"
            data-testid="signup-row"
          >
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <div class="min-w-0">
                <p class="font-semibold break-words">{a.name} <span class="font-normal text-[var(--color-text-muted)]">&lt;{a.email}&gt;</span></p>
                <p class="text-xs text-[var(--color-text-muted)]">
                  {a.company ?? 'no company'} · {a.source} · {a.locale ? LOCALE_LABELS[a.locale] : 'English (not told)'} · {new Date(a.created_at).toLocaleString()}
                </p>
              </div>
              <span class="text-xs" data-testid="signup-status">{statusLabel(a)}</span>
            </div>
            {#if a.message}
              <p class="whitespace-pre-wrap break-words text-sm">{a.message}</p>
            {/if}
            {#if a.status !== 'pending' || Object.keys(a.steps ?? {}).length > 0}
              <div class="overflow-x-auto">
                <table class="min-w-[32rem] text-xs">
                  <tbody>
                    {#each stepRows(a) as s (s.step)}
                      <tr>
                        <td class="pr-3">{s.label}</td>
                        <td class="pr-3 {s.status === 'failed' || s.status === 'unknown' ? 'text-[var(--color-danger)]' : ''}">{s.status}</td>
                        <td class="break-words text-[var(--color-text-muted)]">{s.detail ?? ''}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
            {#if a.tenant_slug}
              <p class="text-xs text-[var(--color-text-muted)]">Workspace: {a.tenant_name} ({a.tenant_slug}){a.tenant_id ? ` · ${a.tenant_id}` : ''}</p>
            {/if}
            {#if a.removal}
              <div class="overflow-x-auto" data-testid="signup-removal">
                <p class="text-xs font-semibold">
                  Removal {a.removal.state}{a.removal.last_error ? `: ${a.removal.last_error}` : ''}{a.removal.blockers.length ? ` (blocked by ${a.removal.blockers.join('; ')})` : ''}
                </p>
                <table class="min-w-[32rem] text-xs">
                  <tbody>
                    {#each removalRows(a) as s (s.step)}
                      <tr>
                        <td class="pr-3">{s.label}</td>
                        <td class="pr-3 {s.status === 'failed' || s.status === 'blocked' ? 'text-[var(--color-danger)]' : ''}">{s.status}</td>
                        <td class="break-words text-[var(--color-text-muted)]">{s.detail ?? ''}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
            {#if a.reject_repair && a.reject_repair.state !== 'done'}
              <p class="text-xs text-[var(--color-warning-text)]">
                Cleanup {a.reject_repair.state}{a.reject_repair.last_error ? `: ${a.reject_repair.last_error}` : ''}{a.reject_repair.blockers.length ? ` (blocked by ${a.reject_repair.blockers.join(', ')})` : ''}
              </p>
            {/if}

            {#if action === 'decide'}
              <div class="flex flex-wrap items-end gap-2">
                <label class="flex flex-col gap-1 text-xs">
                  Workspace name
                  <input
                    class="rounded border border-[var(--color-border)] px-2 py-1 text-sm"
                    placeholder={a.suggested_tenant_name}
                    maxlength="120"
                    bind:value={tenantNames[a.id]}
                  />
                </label>
                <button type="button" class="rounded bg-[var(--color-accent)] px-3 py-1 text-sm text-white disabled:opacity-50" disabled={busy[a.id]} onclick={() => approve(a)} data-testid="signup-approve">Approve</button>
                <button type="button" class="rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50" disabled={busy[a.id]} onclick={() => reject(a)} data-testid="signup-reject">Reject</button>
              </div>
            {:else if action === 'retry_steps'}
              <button type="button" class="self-start rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50" disabled={busy[a.id]} onclick={() => retrySteps(a)}>Retry unfinished steps</button>
            {:else if action === 'retry_cleanup'}
              <button type="button" class="self-start rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50" disabled={busy[a.id]} onclick={() => reject(a)}>Retry cleanup</button>
            {:else if action === 'resolve_cleanup'}
              <div class="flex flex-col gap-2">
                <button type="button" class="self-start rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50" disabled={busy[a.id]} onclick={() => reject(a)}>Retry cleanup</button>
                <label class="flex flex-col gap-1 text-xs">
                  Close it by hand — note
                  <input class="rounded border border-[var(--color-border)] px-2 py-1 text-sm" maxlength="1000" bind:value={resolveNotes[a.id]} />
                </label>
                <label class="flex items-center gap-2 text-xs">
                  <input type="checkbox" bind:checked={resolveAck[a.id]} />
                  I understand the requester’s login, licence or workspace may stay live.
                </label>
                <button
                  type="button"
                  class="self-start rounded border border-[var(--color-danger-border)] px-3 py-1 text-sm text-[var(--color-danger)] disabled:opacity-50"
                  disabled={busy[a.id] || !(resolveNotes[a.id] ?? '').trim() || !resolveAck[a.id]}
                  onclick={() => resolve(a)}
                >Close cleanup</button>
              </div>
            {:else if action === 'retry_removal'}
              <div class="flex flex-col gap-2">
                <button type="button" class="self-start rounded border border-[var(--color-border)] px-3 py-1 text-sm disabled:opacity-50" disabled={busy[a.id]} onclick={() => retryRemoval(a)} data-testid="signup-removal-retry">Retry removal</button>
                {#if a.removal && a.removal.state !== 'pending'}
                  <label class="flex flex-col gap-1 text-xs">
                    Close it by hand — note
                    <input class="rounded border border-[var(--color-border)] px-2 py-1 text-sm" maxlength="1000" bind:value={resolveNotes[a.id]} />
                  </label>
                  <label class="flex items-center gap-2 text-xs">
                    <input type="checkbox" bind:checked={resolveAck[a.id]} />
                    I understand the login, a licence or the workspace may stay live.
                  </label>
                  <button
                    type="button"
                    class="self-start rounded border border-[var(--color-danger-border)] px-3 py-1 text-sm text-[var(--color-danger)] disabled:opacity-50"
                    disabled={busy[a.id] || !(resolveNotes[a.id] ?? '').trim() || !resolveAck[a.id]}
                    onclick={() => resolveRemoval(a)}
                  >Close removal</button>
                {/if}
              </div>
            {/if}
            {#if canRemove(a)}
              {#if !removeOpen[a.id]}
                <button
                  type="button"
                  class="self-start rounded border border-[var(--color-danger-border)] px-3 py-1 text-sm text-[var(--color-danger)]"
                  onclick={() => (removeOpen = { ...removeOpen, [a.id]: true })}
                  data-testid="signup-remove-open"
                >Remove workspace…</button>
              {:else}
                <div class="flex flex-col gap-2 rounded border border-[var(--color-danger-border)] p-3" data-testid="signup-remove-form">
                  <p class="text-xs">
                    Revokes EVERY licence of this workspace (the person’s and the conveyor bundle’s), archives the licences tenant and
                    the workspace, removes the role grants and deletes the login. Type <code>{a.tenant_slug}</code> to confirm.
                  </p>
                  <div class="flex flex-wrap items-end gap-2">
                    <input
                      class="rounded border border-[var(--color-border)] px-2 py-1 text-sm"
                      placeholder={a.tenant_slug ?? ''}
                      maxlength="64"
                      bind:value={removeConfirm[a.id]}
                      data-testid="signup-remove-confirm"
                    />
                    <button
                      type="button"
                      class="rounded border border-[var(--color-danger-border)] px-3 py-1 text-sm text-[var(--color-danger)] disabled:opacity-50"
                      disabled={busy[a.id] || (removeConfirm[a.id] ?? '').trim() !== a.tenant_slug}
                      onclick={() => remove(a)}
                      data-testid="signup-remove"
                    >Remove workspace</button>
                    <button type="button" class="rounded border border-[var(--color-border)] px-3 py-1 text-sm" onclick={() => (removeOpen = { ...removeOpen, [a.id]: false })}>Cancel</button>
                  </div>
                </div>
              {/if}
            {/if}
            {#if rowMessage[a.id]}
              <p class="text-sm {rowMessage[a.id]!.tone === 'ok' ? '' : 'text-[var(--color-danger)]'}" role={rowMessage[a.id]!.tone === 'ok' ? 'status' : 'alert'}>
                {rowMessage[a.id]!.text}
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
