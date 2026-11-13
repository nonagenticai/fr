<!--
  AssetFormDrawer — shared side-drawer for the super-admin asset console.

  One component handles create / edit / view across 4 asset kinds
  (principles, requirements, decisions, projects). Workflows
  do NOT use this drawer — n8n owns workflow editing; the workflows page
  links out to the n8n UI instead.

  Inputs:
    - kind   : 'principles' | 'requirements' | 'decisions' | 'projects'
               (not 'workflows' — see above)
    - mode   : 'create' | 'edit' | 'view'
    - record : the row being edited / viewed (undefined for create)
    - onClose: () => void — fired when the user dismisses the drawer
    - onSaved: () => void — fired on a successful save (parent re-fetches)

  Form shape per kind is driven by `kindFields(kind)` below — a minimal
  whitelist of editable fields. Whether anything OUTSIDE that whitelist is
  preserved on save depends on the kind, and this used to be stated as one
  rule ("we PATCH with a merged payload") that was only true for four of the
  five: see `WHOLE_BODY_KINDS` in buildPayload. Validation is intentionally
  light — upstream services do the real validation; we surface their
  error messages inline.

  Plan ref: ~/.claude/plans/in-fr-there-are-jazzy-pine.md §Frontend
-->
<script lang="ts">
  import type { AdminAssetKind } from '$lib/api/admin-assets';
  import {
    createAdminPrinciple,
    updateAdminPrinciple,
    deleteAdminPrinciple,
    createAdminRequirement,
    updateAdminRequirement,
    deleteAdminRequirement,
    createAdminDecision,
    updateAdminDecision,
    deleteAdminDecision,
    updateAdminProject,
    deleteAdminProject,
  } from '$lib/api/admin-assets';

  type EditableKind = Exclude<AdminAssetKind, 'workflows'>;
  type Mode = 'create' | 'edit' | 'view';
  type Field = {
    name: string;
    label: string;
    kind: 'text' | 'textarea' | 'select';
    options?: readonly string[];
    optional?: boolean;
  };

  interface Props {
    kind: EditableKind;
    mode: Mode;
    record?: Record<string, unknown>;
    onClose: () => void;
    onSaved: () => void | Promise<void>;
  }

  const { kind, mode, record, onClose, onSaved }: Props = $props();

  // Per-kind editable fields. Keep this minimal: the goal is unblocking the
  // most common metadata edits. Full upstream payload is preserved by merging
  // into the existing record on update; create POSTs only what's in the form.
  const KIND_FIELDS: Record<EditableKind, readonly Field[]> = {
    principles: [
      { name: 'title', label: 'Title', kind: 'text' },
      { name: 'statement', label: 'Statement', kind: 'textarea' },
      { name: 'active', label: 'Active', kind: 'select', options: ['true', 'false'], optional: true },
    ],
    requirements: [
      { name: 'title', label: 'Title', kind: 'text' },
      { name: 'description', label: 'Description', kind: 'textarea' },
      { name: 'status', label: 'Status', kind: 'text', optional: true },
      { name: 'priority', label: 'Priority', kind: 'text', optional: true },
    ],
    decisions: [
      { name: 'title', label: 'Title', kind: 'text' },
      { name: 'statement', label: 'Statement', kind: 'textarea' },
      { name: 'status', label: 'Status', kind: 'text', optional: true },
    ],
    // ⛔ No name / description: both are requirements_management's after the
    // project request (George v4 ruling 1) — the PATCH answers 422
    // `rm_owned_field`. fr's own row status is the only admin-editable field.
    projects: [
      {
        name: 'status',
        label: 'Status',
        kind: 'select',
        // 'archived' is deliberately absent: the PATCH endpoint rejects it with 400
        // (`archive_via_delete`) because archiving must first purge the project's
        // documents' downstream PHI. Offering it here was a dead control that
        // could only ever produce an error. Archive via the Delete action.
        options: ['submitted', 'active'],
        optional: true,
      },
    ],
  };

  const fields = $derived(KIND_FIELDS[kind]);

  function seedFormValue(f: Field): string {
    if (!record) return '';
    const raw = record[f.name];
    if (raw === undefined || raw === null) return '';
    return typeof raw === 'string' ? raw : String(raw);
  }

  // Initial form values are seeded once from the record + field set; the
  // drawer is single-use (parent re-mounts it on each open) so a non-reactive
  // initialisation captures the right shape without re-running on prop drift.
  // svelte-ignore state_referenced_locally
  let values = $state<Record<string, string>>(
    Object.fromEntries(KIND_FIELDS[kind].map((f) => [f.name, seedFormValue(f)])),
  );
  let saving = $state(false);
  let serverError = $state<string | undefined>(undefined);
  const isView = $derived(mode === 'view');
  const isCreate = $derived(mode === 'create');

  // Every kind keys on `id`.
  function idFromRecord(): string | undefined {
    if (!record) return undefined;
    const id = record.id;
    return typeof id === 'string' ? id : undefined;
  }

  // Which kinds take a WHOLE-BODY write upstream, and which take a field-wise
  // PATCH. This is the difference between "spreading the existing record is the
  // only thing that preserves the fields this form does not show" and "spreading
  // it is a guaranteed 400".
  //
  // ⭐ MEASURED, not assumed:
  //   * principles / requirements / decisions reach `integrations/requirements.ts
  //     :: updateRequirement`, which issues a **whole-body PUT** upstream and
  //     `JSON.stringify`s this object straight through — there is no merge anywhere
  //     on the path. Any key this object omits is DELETED from the stored row. So
  //     the spread below is load-bearing for these three and must not be "tidied"
  //     away.
  //   * `projects` is fr-LOCAL and the exact opposite. Its PATCH body is
  //     `backend/src/routes/admin/assets/projects.ts :: PatchProjectSchema` =
  //     `z.object({ status }).strict()` (name/description are RM-owned: 422
  //     `rm_owned_field`), and the list row this
  //     drawer is handed is a full `projects` TABLE row (`db.select().from(
  //     projects)`), so spreading it shipped `id`, `owner_id`, `created_at`,
  //     `project_data`, … into a `.strict()` schema — **400 `bad_request` on every
  //     save**. Worse for a project whose stored status is 'archived': the spread
  //     re-sent `status: 'archived'`, which that handler refuses first with
  //     `archive_via_delete` (400) even though the operator never touched status.
  //     The handler applies `status` only when present, so omitting it leaves it
  //     unchanged — the whitelist below loses nothing.
  //
  // ⛔ Do NOT "simplify" this to one branch. The two halves fail in opposite
  // directions: a missing key silently destroys data on the PUT kinds, and an
  // extra key hard-rejects the save on `projects`.
  const WHOLE_BODY_KINDS: readonly EditableKind[] = [
    'principles',
    'requirements',
    'decisions',
  ];

  function buildPayload(): Record<string, unknown> {
    const base = isCreate || !WHOLE_BODY_KINDS.includes(kind) ? {} : { ...record };
    delete (base as Record<string, unknown>).is_system;
    const out: Record<string, unknown> = { ...base };
    for (const f of fields) {
      const v = values[f.name];
      if (v === '' && f.optional) {
        // leave existing value untouched on edit; omit on create
        if (isCreate) {
          // no-op
        }
        continue;
      }
      if (f.kind === 'select' && (v === 'true' || v === 'false')) {
        out[f.name] = v === 'true';
      } else {
        out[f.name] = v;
      }
    }
    return out;
  }

  async function save(): Promise<void> {
    saving = true;
    serverError = undefined;
    try {
      const payload = buildPayload();
      if (isCreate) {
        if (kind === 'projects') {
          // Projects create is not supported here by design — POST /api/projects
          // owns provisioning.
          serverError = 'Projects must be created from /projects (this drawer is edit-only for projects).';
          return;
        }
        if (kind === 'principles') await createAdminPrinciple(payload);
        else if (kind === 'requirements') await createAdminRequirement(payload);
        else if (kind === 'decisions') await createAdminDecision(payload);
      } else {
        const key = idFromRecord();
        if (!key) {
          serverError = 'Record has no id/name; cannot update.';
          return;
        }
        if (kind === 'principles') await updateAdminPrinciple(key, payload);
        else if (kind === 'requirements') await updateAdminRequirement(key, payload);
        else if (kind === 'decisions') await updateAdminDecision(key, payload);
        else if (kind === 'projects')
          await updateAdminProject(key, payload as Parameters<typeof updateAdminProject>[1]);
      }
      await onSaved();
    } catch (e) {
      const err = e as { body?: { detail?: string; error?: string }; status?: number; message: string };
      serverError = err.body?.detail ?? err.body?.error ?? err.message;
    } finally {
      saving = false;
    }
  }

  async function destroy(): Promise<void> {
    if (!record) return;
    const key = idFromRecord();
    if (!key) {
      serverError = 'Record has no id/name; cannot delete.';
      return;
    }
    if (!confirm(`Delete this ${kind.slice(0, -1)}? This cannot be undone.`)) return;
    saving = true;
    serverError = undefined;
    try {
      if (kind === 'principles') await deleteAdminPrinciple(key);
      else if (kind === 'requirements') await deleteAdminRequirement(key);
      else if (kind === 'decisions') await deleteAdminDecision(key);
      else if (kind === 'projects') await deleteAdminProject(key);
      await onSaved();
    } catch (e) {
      const err = e as { body?: { detail?: string; error?: string }; message: string };
      serverError = err.body?.detail ?? err.body?.error ?? err.message;
    } finally {
      saving = false;
    }
  }

  const TITLE = $derived(
    isCreate
      ? `New ${kind.slice(0, -1)}`
      : isView
        ? `View ${kind.slice(0, -1)}`
        : `Edit ${kind.slice(0, -1)}`,
  );
</script>

<!-- Backdrop -->
<button
  type="button"
  aria-label="Close drawer"
  class="fixed inset-0 z-40 bg-black/40"
  onclick={onClose}
></button>

<!-- Drawer -->
<div
  class="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
  role="dialog"
  aria-modal="true"
  aria-labelledby="asset-form-drawer-title"
>
  <header class="flex items-start justify-between gap-4 border-b border-[var(--color-border)] p-4">
    <div>
      <h2 id="asset-form-drawer-title" class="text-base font-semibold text-[var(--color-text)]">
        {TITLE}
      </h2>
      {#if isView}
        <p class="mt-1 text-xs text-[var(--color-text-muted)]">
          Read-only — switch to the system workspace to edit inherited rows.
        </p>
      {/if}
    </div>
    <button
      type="button"
      onclick={onClose}
      class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      aria-label="Close"
    >
      ×
    </button>
  </header>

  <form
    class="flex-1 space-y-4 overflow-y-auto p-4"
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
  >
    {#each fields as f (f.name)}
      <label class="block">
        <span class="block text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          {f.label}{f.optional ? '' : ' *'}
        </span>
        {#if f.kind === 'text'}
          <input
            type="text"
            bind:value={values[f.name]}
            disabled={isView}
            required={!f.optional && !isView}
            class="mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-3 py-2 text-sm text-[var(--color-text)] disabled:opacity-60"
          />
        {:else if f.kind === 'textarea'}
          <textarea
            bind:value={values[f.name]}
            disabled={isView}
            required={!f.optional && !isView}
            rows="4"
            class="mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-3 py-2 text-sm text-[var(--color-text)] disabled:opacity-60"
          ></textarea>
        {:else if f.kind === 'select'}
          <select
            bind:value={values[f.name]}
            disabled={isView}
            class="mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-3 py-2 text-sm text-[var(--color-text)] disabled:opacity-60"
          >
            {#if f.optional}<option value=""></option>{/if}
            {#each f.options ?? [] as opt}
              <option value={opt}>{opt}</option>
            {/each}
          </select>
        {/if}
      </label>
    {/each}

    {#if serverError}
      <p class="text-sm text-[var(--color-danger)]" role="alert">{serverError}</p>
    {/if}

    <footer class="mt-6 flex items-center justify-between border-t border-[var(--color-border)] pt-4">
      {#if !isCreate && !isView}
        <button
          type="button"
          onclick={() => void destroy()}
          disabled={saving}
          class="h-9 rounded-[var(--radius-md)] border border-[var(--color-danger)] px-3 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 disabled:opacity-60"
        >
          Delete
        </button>
      {:else}
        <span></span>
      {/if}
      <div class="flex gap-2">
        <button
          type="button"
          onclick={onClose}
          class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
        >
          {isView ? 'Close' : 'Cancel'}
        </button>
        {#if !isView}
          <button
            type="submit"
            disabled={saving}
            class="h-9 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-60"
          >
            {saving ? 'Saving…' : isCreate ? 'Create' : 'Save'}
          </button>
        {/if}
      </div>
    </footer>
  </form>
</div>
