<!--
  AssetEditor.svelte

  Generic create/update form driven by `manifest.editor.sections` (falling
  back to `manifest.detail.sections`). Field-type → element mapping:
    text     → <input type="text">
    longtext → <textarea>
    number   → <input type="number">
    boolean  → <input type="checkbox">
    date     → <input type="date">
    select   → <select>
    tags     → <input> with comma-list parser
    json     → <textarea> with on-blur JSON validation
    objectArray → ObjectArrayEditor (repeater over `field.itemFields`, with
               add / remove / reorder and step-number renumbering). Added for
               `procedures.steps`, whose absence from the editor made every
               procedure fr created permanently inert.
    relation → RelationPicker (typeahead over HUMAN labels, plus a free-text
               escape hatch). Was a plain <input> under a "TBD: typeahead"
               comment, which is why zero manifests ever declared the type:
               a form asking a human to type a uuid is a form nobody can fill.
               The directory is named by `FieldDef.relationTo` and resolved
               through `relationDirectory.ts`.

  Plan: docs/superpowers/plans/...woolly-harp Wave 6 Task 6.1 Step 4.
-->
<script lang="ts" generics="T">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { assetItemHref, assetListHref, type AssetManifest, type FieldDef } from './manifest';
  import AssetCreateScopePicker from '$lib/components/library/AssetCreateScopePicker.svelte';
  import RelationPicker from './RelationPicker.svelte';
  import ObjectArrayEditor from './ObjectArrayEditor.svelte';
  import { bindAsset, type AssetKind } from '$lib/api/bindings';
  import type { ScopeRefState } from './scopeRefs';
  import { auth } from '$lib/stores/auth.svelte';
  import { SYSTEM_ASSET_READ_ONLY_NOTICE, isSystemReadOnly } from './systemAsset';

  let {
    manifest,
    id,
  }: { manifest: AssetManifest<T>; id?: string } = $props();

  const isEdit = $derived(id != null);

  const sections = $derived(
    manifest.editor?.sections ?? manifest.detail.sections,
  );

  // AssetCreateScopePicker — render only on NEW form when the manifest
  // opts in via `editor.scopePicker`. On submit, if scope='project',
  // AssetEditor posts a binding to /api/assets/<bindAsKind>/<new-id>/bindings
  // after the upstream create returns.
  const scopePickerCfg = $derived(
    !isEdit ? (manifest.editor?.scopePicker ?? null) : null,
  );
  let createScope = $state<'tenant' | 'project'>('tenant');
  let createProjectId = $state<string | null>(null);
  // Bound UP from AssetCreateScopePicker — see the `directoryState` prop there.
  // Read by `onSubmit`, which is the whole point: the picker's "do not switch
  // to tenant-wide on account of this" warning used to have no reader.
  let projectDirectoryState = $state<ScopeRefState>('ready');
  let projectDirectoryReason = $state<string | null>(null);
  // Apply manifest-supplied default once after mount.
  $effect(() => {
    const d = scopePickerCfg?.default;
    if (d && createScope === 'tenant') createScope = d;
  });

  // Form state lives in a single Record keyed by FieldDef.key.
  let form = $state<Record<string, unknown>>({});
  // Comma-list raw text for type='tags' (so the user can type freely).
  let tagsRaw = $state<Record<string, string>>({});
  // Raw JSON text + per-field validation message for type='json'.
  let jsonRaw = $state<Record<string, string>>({});
  let jsonError = $state<Record<string, string>>({});

  let loading = $state(false);
  let loadError = $state('');
  let saving = $state(false);
  let saveError = $state('');

  // The loaded row, kept only for the system-asset gate. A system-tenant asset
  // is read-only for everyone but a super-admin — the backend refuses the write
  // with 403 `system_asset_read_only` — so the edit form renders disabled with
  // a notice and no Save, instead of a form whose every submit fails.
  let loadedItem = $state<unknown>(null);
  const systemReadOnly = $derived(
    isEdit && isSystemReadOnly(loadedItem, auth.isSuperAdmin),
  );

  onMount(async () => {
    if (id == null) return;
    loading = true;
    loadError = '';
    try {
      const item = await manifest.api.get(id);
      loadedItem = item;
      hydrate(item);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });

  function hydrate(item: T) {
    const obj = item as unknown as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    const tags: Record<string, string> = {};
    const jsons: Record<string, string> = {};
    for (const section of sections) {
      for (const field of section.fields) {
        const v = obj[field.key];
        next[field.key] = v;
        if (field.type === 'tags') {
          tags[field.key] = Array.isArray(v) ? v.map(String).join(', ') : '';
        }
        if (field.type === 'json') {
          try {
            jsons[field.key] = v == null ? '' : JSON.stringify(v, null, 2);
          } catch {
            jsons[field.key] = String(v ?? '');
          }
        }
        if (field.type === 'objectArray') {
          // Normalise to a real array of SHALLOW COPIES. `null`/absent must
          // become `[]` so the repeater has something to bind to, and the rows
          // must be copies because every handler in ObjectArrayEditor rebuilds
          // the array immutably — handing it the objects the api response owns
          // would leave the loaded item and the form sharing row identities.
          next[field.key] = Array.isArray(v)
            ? v.map((r) => ({ ...(r as Record<string, unknown>) }))
            : [];
        }
      }
    }
    form = next;
    tagsRaw = tags;
    jsonRaw = jsons;
    jsonError = {};
  }

  function onTagsInput(field: FieldDef<T>, value: string) {
    tagsRaw[field.key] = value;
    form[field.key] = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function onJsonBlur(field: FieldDef<T>) {
    const raw = jsonRaw[field.key] ?? '';
    if (raw.trim() === '') {
      jsonError[field.key] = '';
      form[field.key] = null;
      return;
    }
    try {
      form[field.key] = JSON.parse(raw);
      jsonError[field.key] = '';
    } catch (e) {
      jsonError[field.key] = e instanceof Error ? e.message : 'Invalid JSON';
    }
  }

  function asNumber(v: unknown): number | undefined {
    if (v === '' || v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  /**
   * The control holds NO VALUE — distinct from holding a value that is falsy.
   *
   * ⚠️ `0` and `false` are legitimate entries, so this is an explicit
   * emptiness test and never a truthiness one. `bind:value` on
   * `<input type="number">` writes `null` for an empty box (Svelte's numeric
   * coercion), `hydrate` writes `undefined` for a key the loaded row omits, and
   * an unselected `<select>` sits on its placeholder `''` — all three are empty.
   * Only the `select` branch of `onSubmit` needs it: its placeholder is a real `''`.
   */
  function isBlank(v: unknown): boolean {
    return v === '' || v == null;
  }

  async function onSubmit(ev: SubmitEvent) {
    ev.preventDefault();
    // Belt to the fieldset's braces: a submit that slips through (Enter in a
    // field, a script) must not reach the api either.
    if (systemReadOnly) {
      saveError = SYSTEM_ASSET_READ_ONLY_NOTICE;
      return;
    }

    // Final pass: re-validate any json fields whose textarea hasn't blurred yet.
    for (const section of sections) {
      for (const field of section.fields) {
        if (field.type === 'json') onJsonBlur(field);
      }
    }
    const stillBad = Object.values(jsonError).some((m) => m);
    if (stillBad) {
      saveError = 'Fix invalid JSON fields before saving.';
      return;
    }

    // --- Manifest field validators, SAME pre-flight, SAME error channel ------
    //
    // Runs for EVERY field that declares `validate`, not only `objectArray`
    // ones: a validator that fires for one field type is a validator the next
    // manifest author has to re-discover, and the type it happens to be written
    // against is not the reason it exists.
    //
    // ⚠️ It reports the FIRST problem and returns, rather than collecting all of
    // them. A list of messages reads as a wall and the human fixes the top one
    // anyway; and every message here already names its own row ("Step 3: …").
    //
    // ⛔ It surfaces into `saveError` — the same box the json pre-flight, the
    // scope refusal and the upstream error already use. A second error surface
    // is how a form ends up showing one message while refusing for another.
    for (const section of sections) {
      for (const field of section.fields) {
        if (!field.validate) continue;
        const msg = field.validate(form[field.key]);
        if (msg) {
          saveError = `${field.label}: ${msg}`;
          return;
        }
      }
    }

    // --- Stream E: the warning becomes a constraint -------------------------
    //
    // A tenant-wide create is REFUSED while the project directory is
    // unreadable. Not because tenant-wide is wrong — it is a legitimate,
    // common choice — but because this particular tenant-wide create cannot be
    // distinguished from one the user made only because the picker showed them
    // nothing to bind to. Broadening an asset's scope is not reversible by
    // simply saving again: the row is visible tenant-wide the moment it exists.
    //
    // ⚠️ Three conditions, not one, and each carries its own weight:
    //   - `!isEdit`            — an EDIT never re-scopes anything; blocking it
    //                            would be pure obstruction.
    //   - `scopePickerCfg`     — only manifests that actually offer the choice.
    //   - `createScope==='tenant'` — a PROJECT create is already gated by
    //                            needing a project id, and refusing it would
    //                            leave the user no way forward at all.
    // Collapsing these into a single flag is exactly the shape that made the
    // older `hasEconomicField` guard vacuous.
    //
    // `empty` and `ready` both pass: a deliberate tenant-wide create stays
    // possible whenever the directory was READ. Only `unreadable` refuses.
    if (
      !isEdit &&
      scopePickerCfg &&
      createScope === 'tenant' &&
      projectDirectoryState === 'unreadable'
    ) {
      saveError =
        'Refused: the project list could not be read, so a tenant-wide create ' +
        'cannot be told apart from one forced by the outage. Retry once the ' +
        'project list loads, then choose the scope deliberately. ' +
        `(${projectDirectoryReason ?? 'project list read failed'})`;
      return;
    }

    saving = true;
    saveError = '';
    try {
      // Build the payload, coercing numeric strings. An empty number or an
      // unselected optional <select> is OMITTED, never sent as '' (a
      // nullable/enum upstream field rejects an empty string with a 422).
      // On an update converted to `mergeReplacingUpdate`
      // (`backend/src/integrations/_lib/merge-update.ts`) an omitted key is
      // PRESERVED, so this form cannot clear such a field.
      const payload: Record<string, unknown> = {};
      for (const section of sections) {
        for (const field of section.fields) {
          const v = form[field.key];
          if (field.type === 'number') {
            const n = asNumber(v);
            if (n !== undefined) payload[field.key] = n;
          } else if (field.type === 'select' && isBlank(v)) {
            // omitted (see above)
          } else {
            payload[field.key] = v;
          }
        }
      }
      let saved: T;
      if (isEdit && manifest.api.update && id != null) {
        saved = await manifest.api.update(id, payload as Partial<T>);
      } else if (manifest.api.create) {
        saved = await manifest.api.create(payload as Partial<T>);
      } else {
        throw new Error(
          `Manifest "${manifest.name}" has no ${isEdit ? 'update' : 'create'} api`,
        );
      }
      const idField = manifest.idField ?? 'id';
      const savedId = String(
        (saved as unknown as Record<string, unknown>)[idField] ?? id ?? '',
      );

      // Auto-bind to a project if the user picked project scope on the
      // new form. Idempotent on the backend; a failure here surfaces as
      // a save error but the upstream row is already persisted (visible
      // tenant-wide). The user can manually bind later from the project
      // tab.
      if (!isEdit && scopePickerCfg && createScope === 'project' && createProjectId && savedId) {
        try {
          await bindAsset(
            scopePickerCfg.bindAsKind as AssetKind,
            savedId,
            [createProjectId],
          );
        } catch (e) {
          saveError =
            'Asset created tenant-wide, but binding to project failed: ' +
            (e instanceof Error ? e.message : String(e));
          // Skip navigation so the user sees the warning — the row still
          // exists and they can retry the bind from the project tab.
          return;
        }
      }

      await goto(
        savedId
          ? assetItemHref(manifest, savedId)
          : assetListHref(manifest),
      );
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<div
  class="px-6 py-4 max-w-3xl"
  data-testid="asset-editor"
  data-manifest={manifest.name}
  data-mode={isEdit ? 'edit' : 'new'}
>
  <div class="flex items-center justify-between mb-4">
    <h1 class="text-2xl font-semibold">
      {isEdit ? `Edit ${manifest.singular.toLowerCase()}` : `New ${manifest.singular.toLowerCase()}`}
    </h1>
    <a href={assetListHref(manifest)} class="text-sm text-[var(--color-text)] hover:underline dark:text-[var(--color-text-muted)]">← Back</a>
  </div>

  {#if loading}
    <p class="text-[var(--color-text-muted)] text-sm dark:text-[var(--color-text-muted)]">Loading…</p>
  {:else if loadError}
    <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm">
      {loadError}
    </div>
  {:else}
    {#if systemReadOnly}
      <p
        class="text-sm text-[var(--color-text-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 mb-4"
        data-testid="asset-system-readonly-notice"
      >
        {SYSTEM_ASSET_READ_ONLY_NOTICE}
      </p>
    {/if}
    <form
      onsubmit={onSubmit}
      class="space-y-6"
      data-readonly={systemReadOnly ? 'system' : undefined}
    >
      <!-- A disabled <fieldset> disables every control inside it, including
           the ones rendered by child components (RelationPicker,
           ObjectArrayEditor).

           ⚠️ It is NOT the only lock, and must not be: a control disabled only
           by an ancestor fieldset still reports `el.disabled === false`, has no
           `disabled` attribute, and was measured in prod as 6 (principle) / 30
           (procedure) "editable" inputs plus enabled Remove buttons. So every
           control below ALSO carries `disabled={systemReadOnly}` and each child
           editor gets the `disabled` prop. Block-level (not `display:contents`)
           with the UA border/padding/margin/min-width reset so layout is
           unchanged. -->
      <fieldset
        disabled={systemReadOnly}
        class="asset-editor-fieldset space-y-6"
        data-testid="asset-editor-fieldset"
      >
      {#if scopePickerCfg}
        <AssetCreateScopePicker
          bind:scope={createScope}
          bind:projectId={createProjectId}
          bind:directoryState={projectDirectoryState}
          bind:directoryUnreadableReason={projectDirectoryReason}
          defaultScope={scopePickerCfg.default}
        />
      {/if}
      {#each sections as section (section.title)}
        <section class="space-y-3">
          <h2 class="text-lg font-semibold">{section.title}</h2>
          {#each section.fields as field (field.key)}
            {@const fieldId = `field-${manifest.name}-${field.key}`}
            <div>
              <label for={fieldId} class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
                {field.label}{#if field.required}<span class="text-[var(--color-danger)] ml-0.5">*</span>{/if}
              </label>

              {#if field.type === 'text'}
                <input
                  id={fieldId}
                  type="text"
                  bind:value={form[field.key]}
                  required={field.required}
                  disabled={systemReadOnly}
                  class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)]"
                />
              {:else if field.type === 'longtext'}
                <textarea
                  id={fieldId}
                  rows="4"
                  bind:value={form[field.key]}
                  required={field.required}
                  disabled={systemReadOnly}
                  class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)]"
                ></textarea>
              {:else if field.type === 'number'}
                <input
                  id={fieldId}
                  type="number"
                  bind:value={form[field.key]}
                  required={field.required}
                  disabled={systemReadOnly}
                  class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)]"
                />
              {:else if field.type === 'boolean'}
                <input
                  id={fieldId}
                  type="checkbox"
                  checked={Boolean(form[field.key])}
                  disabled={systemReadOnly}
                  oninput={(e) =>
                    (form[field.key] = (e.currentTarget as HTMLInputElement).checked)}
                  class="h-4 w-4 align-middle"
                />
              {:else if field.type === 'date'}
                <input
                  id={fieldId}
                  type="date"
                  bind:value={form[field.key]}
                  required={field.required}
                  disabled={systemReadOnly}
                  class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)]"
                />
              {:else if field.type === 'select'}
                <select
                  id={fieldId}
                  bind:value={form[field.key]}
                  required={field.required}
                  disabled={systemReadOnly}
                  class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm bg-[var(--color-bg)] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
                >
                  <option value="">— select —</option>
                  {#each field.options ?? [] as opt (opt.value)}
                    <option value={opt.value}>{opt.label}</option>
                  {/each}
                </select>
              {:else if field.type === 'tags'}
                <input
                  id={fieldId}
                  type="text"
                  value={tagsRaw[field.key] ?? ''}
                  oninput={(e) =>
                    onTagsInput(field, (e.currentTarget as HTMLInputElement).value)}
                  placeholder="comma, separated, values"
                  disabled={systemReadOnly}
                  class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)]"
                />
              {:else if field.type === 'json'}
                <textarea
                  id={fieldId}
                  rows="6"
                  bind:value={jsonRaw[field.key]}
                  onblur={() => onJsonBlur(field)}
                  disabled={systemReadOnly}
                  class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm font-mono dark:border-[var(--color-border-strong)]"
                ></textarea>
                {#if jsonError[field.key]}
                  <p class="text-xs text-[var(--color-danger)] mt-1">{jsonError[field.key]}</p>
                {/if}
              {:else if field.type === 'objectArray'}
                <ObjectArrayEditor
                  {fieldId}
                  itemFields={field.itemFields ?? []}
                  bind:rows={form[field.key]}
                  itemLabel={field.label.replace(/s$/i, '').toLowerCase()}
                  disabled={systemReadOnly}
                />
              {:else if field.type === 'relation'}
                <RelationPicker
                  {fieldId}
                  fieldKey={field.key}
                  bind:value={form[field.key]}
                  relationTo={field.relationTo}
                  required={field.required}
                  disabled={systemReadOnly}
                />
              {/if}

              {#if field.advise}
                {@const advice = field.advise(form[field.key])}
                {#if advice}
                  <!--
                    NON-BLOCKING. Deliberately not `saveError`: this field's
                    value is one the upstream service ACCEPTS, and a warning
                    rendered in the refusal box teaches the human that the form
                    is broken when it is not. See `FieldDef.advise`.
                  -->
                  <p
                    class="text-xs text-[var(--color-warning-text)] bg-[var(--color-warning-bg)] border border-[var(--color-warning-border)] rounded px-2 py-1 mt-1"
                    data-testid="asset-editor-field-advice"
                    data-field={field.key}
                  >
                    {advice}
                  </p>
                {/if}
              {/if}

              {#if field.helpText}
                <p class="text-xs text-[var(--color-text-muted)] mt-1 dark:text-[var(--color-text-muted)]">{field.helpText}</p>
              {/if}
            </div>
          {/each}
        </section>
      {/each}

      {#if saveError}
        <div
          class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm"
          data-testid="asset-editor-save-error"
        >
          {saveError}
        </div>
      {/if}

      </fieldset>

      <div class="flex items-center gap-3">
        {#if !systemReadOnly}
          <button
            type="submit"
            disabled={saving}
            class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded hover:bg-[var(--color-accent-strong)] disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)] text-sm"
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : `Create ${manifest.singular.toLowerCase()}`}
          </button>
        {/if}
        <a href={assetListHref(manifest)} class="text-sm text-[var(--color-text)] hover:underline dark:text-[var(--color-text-muted)]">{systemReadOnly ? 'Back' : 'Cancel'}</a>
      </div>
    </form>
  {/if}
</div>

<style>
  /* Strip the UA fieldset chrome so wrapping the form body changes nothing
     visually; `min-width: 0` undoes the UA `min-content` that would otherwise
     let a wide child overflow the column. */
  .asset-editor-fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
</style>
