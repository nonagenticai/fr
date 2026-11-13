<!--
  RelationPicker.svelte

  The typeahead behind `FieldDef.type === 'relation'`.

  ## The defect it replaces

  `relation` shipped in the type union with `relationTo`, and `AssetEditor`
  rendered it as `<input type="text" placeholder="… id">` under a `TBD` comment.
  Zero manifests declared it — a form that asks a human to type a uuid is a form
  nobody can fill, so the type stayed on the shelf and the FKs stayed as plain
  text fields labelled "Project ID". This builds the mechanism ONCE, so the
  declaration sites become a one-line change.

  ## Three states, not two

  Shared through `scopeRefs.scopeRefState` (it was first modelled on the kanban
  member picker, removed 2026-10-10):

    - `unreadable` — the directory read FAILED. What can be picked is UNKNOWN.
    - `empty`      — the read succeeded and there is genuinely nothing.
    - `ready`      — there are options.

  ⚠️ An unreadable directory must NEVER render as an empty one. The two look
  identical from `options.length === 0`, and only one of them justifies telling
  a user there is nothing to pick.

  ## Two invariants that outrank the picker

  1. **Never block save.** The free-text input below is rendered in ALL states,
     including `unreadable`, and carries the field's `required`. A dead
     directory must not make the asset uncreatable.
  2. **Never clear an existing value.** ~30% of well-formed `project_id` values
     in the estate resolve to no project. Those rows are editable today; a
     picker that dropped an unresolvable value on mount would silently rewrite
     data on every unrelated save. The value is preserved verbatim and
     DISCLOSED as unresolved.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { scopeRefState } from './scopeRefs';
  import {
    relationDirectoryFor,
    type RelationOption,
  } from './relationDirectory';

  interface Props {
    /** DOM id for the <label for=…> the editor already renders. */
    fieldId: string;
    /** The stored FK. Bound both ways; never rewritten by this component. */
    value: unknown;
    relationTo?: string;
    required?: boolean;
    /** The field's key; it scopes the testids so two relation fields on one form differ. */
    fieldKey: string;
    /** Read-only mode (e.g. a system asset): every control is disabled. */
    disabled?: boolean;
  }

  let {
    fieldId,
    // ⚠️ No fallback value: `$bindable(null)` refuses `bind:value={undefined}`,
    // and AssetEditor binds into a `Record<string, unknown>` whose keys are
    // undefined until the row hydrates.
    value = $bindable<unknown>(),
    relationTo,
    required = false,
    fieldKey,
    disabled = false,
  }: Props = $props();

  let options = $state<RelationOption[]>([]);
  let unreadable = $state<string | null>(null);
  let loading = $state(true);
  let query = $state('');

  const loader = $derived(relationDirectoryFor(relationTo));

  /**
   * ⭐ The options a human may NEWLY PICK — `selectable !== false`.
   *
   * ## Why the picker has two pools and the label resolver has one
   *
   * `options` is the DIRECTORY: everything the field's value could legitimately
   * already be, so the stored id can be NAMED. For `projects` that includes
   * fr's soft-deleted rows, which on production is 262 of 263 — measured
   * 2026-09-24, and 85 of the 86 referenced-by-an-asset projects. Naming them
   * is mandatory; the alternative is the bare-uuid render this component
   * exists to end.
   *
   * ⛔ OFFERING them is a DIFFERENT permission and must not follow. A new
   * reference to an archived project points at a project whose documents were
   * PHI-purged, whose approvals were voided and whose Planka board was torn
   * down — the picker would be manufacturing broken data. So every list a click
   * can reach is built from THIS pool, and `currentOption` (display) is the
   * only thing that reads the full `options`.
   */
  const selectableOptions = $derived(options.filter((o) => o.selectable !== false));

  // ⚠️ NOT named `state`: a local called `state` makes every `$state(...)`
  // rune above parse as store-access on it (`$<name>`), and svelte-check reports
  // 10 errors with no obvious cause. Measured.
  //
  // ⚠️ Keyed on the SELECTABLE count, not `options.length`. A directory of 262
  // options none of which may be picked genuinely has nothing to pick from, and
  // reporting `ready` there renders a search box over an empty list with no
  // explanation. Unchanged whenever nothing is marked unselectable, which is
  // every other directory and every test double that returns `{ id, label }`.
  const pickerState = $derived(scopeRefState(selectableOptions.length, unreadable));

  /** Displayable-but-unpickable count, for the honest version of the empty state. */
  const unselectableCount = $derived(options.length - selectableOptions.length);

  /** Verbatim, for the escape-hatch input — never trimmed back under the user. */
  const rawText = $derived(value == null ? '' : String(value));
  const currentId = $derived(rawText.trim());
  const currentOption = $derived(
    currentId ? (options.find((o) => o.id === currentId) ?? null) : null,
  );
  /**
   * A value that is set, from a directory that READ FINE, and matches nothing
   * in it. Deliberately false while `unreadable` or still loading: "we could
   * not read the directory" is not evidence that the value is bad, and saying
   * so would be the same over-claim the empty state used to make.
   */
  const unresolved = $derived(
    currentId !== '' && !loading && unreadable === null && currentOption == null,
  );

  /**
   * The current value resolves to a directory row that may not be picked again
   * (an archived project). NOT `unresolved` — the opposite: it is known, and
   * saying so is the point. Disclosed so an editor is not surprised that the
   * name on screen is absent from the list below it.
   */
  const currentUnselectable = $derived(currentOption != null && currentOption.selectable === false);

  const matches = $derived.by(() => {
    const q = query.trim().toLowerCase();
    // ⛔ `selectableOptions`, never `options` — this pool is what a click writes
    // into `value`. Filtering only the rendered list would leave the archived
    // rows one keystroke away.
    const pool = q
      ? selectableOptions.filter((o) => o.label.toLowerCase().includes(q))
      : selectableOptions;
    // Bounded: a 263-row directory rendered in full is a wall, and the search
    // box is the way through it.
    return pool.slice(0, 20);
  });

  onMount(async () => {
    if (!loader) {
      // No directory registered for this relation — free text only, exactly as
      // before this component existed. Not an error, and NOT `unreadable`:
      // nothing was read, so there is nothing to report as failed.
      loading = false;
      return;
    }
    try {
      const res = await loader();
      options = res.options;
      unreadable = res.unreadable;
    } finally {
      loading = false;
    }
  });

  function choose(opt: RelationOption): void {
    // ⛔ CORRECTED 2026-09-24 — this used to claim the guard below made
    // `selectable:false` "refused at the write point", full stop. That
    // overstates it: this guard covers ONLY writes that go through `choose()`
    // (a click on a rendered option). `matches` already excludes these, so
    // this branch is unreachable today — which is exactly why it is here: the
    // next render path that forgets to filter (a "recently used" row, a
    // keyboard shortcut, a paste handler ONTO THIS LIST) would otherwise
    // silently create a reference to a soft-deleted project, and a filter in
    // the template cannot stop it.
    //
    // ⚠️ IT IS NOT THE ONLY WRITE POINT. The free-text `<input>` rendered
    // below (the escape hatch, every state) assigns `value` directly on
    // `oninput` and never calls this function — typing or pasting an
    // archived project's uuid there writes the exact reference this guard
    // exists to prevent, and NO BACKEND PREDICATE refuses an archived
    // relation target either (checked 2026-09-24: nothing in the asset write
    // path validates a `relation`-typed field's target against the
    // directory's `selectable` state). The hole predates this component.
    //
    // DECIDED: left open, not closed. The hatch exists so a human can paste
    // an id the directory cannot offer — this estate's rule is that humans
    // should never have to TYPE a uuid, so a paste is the exception that
    // proves it, and hard-refusing it here would break that one legitimate
    // use while doing nothing about the missing backend predicate. Disclosure
    // is what actually covers the escape hatch: `value` is the ONE prop both
    // write paths share, so `currentOption`/`currentUnselectable` below
    // re-derive from whatever was just typed or pasted exactly as they do for
    // a value that arrived by any other path, and the "archived" notice
    // renders for it once the directory has loaded. That is a WARNING, not a
    // refusal — save is never blocked (invariant 1 above) — and it is silent
    // only while the directory is `unreadable` or still `loading`, same as
    // every other disclosure in this component.
    if (opt.selectable === false) return;
    value = opt.id;
    query = '';
  }
</script>

<div
  data-testid="relation-picker-{fieldKey}"
  data-relation={relationTo ?? ''}
  data-state={loading ? 'loading' : pickerState}
  class="space-y-1"
>
  {#if currentId}
    <p
      class="text-xs"
      data-testid="relation-picker-current-{fieldKey}"
      data-resolved={currentOption != null}
    >
      <span class="text-[var(--color-text-muted)]">Selected:</span>
      <span class="font-medium text-[var(--color-text)]"
        >{currentOption?.label ?? currentId}</span
      >
      {#if unresolved}
        <span
          class="ml-1 text-[var(--color-warning-text)]"
          data-testid="relation-picker-unresolved-{fieldKey}"
        >
          — this id matches no {relationTo ?? 'record'} in the directory. Kept as
          stored; it is not cleared for you.
        </span>
      {/if}
      {#if currentUnselectable}
        <span
          class="ml-1 text-[var(--color-text-muted)]"
          data-testid="relation-picker-current-archived-{fieldKey}"
        >
          — archived. Kept as stored and shown by name, but it is not offered in the
          list below, so it cannot be picked again.
        </span>
      {/if}
    </p>
  {/if}

  {#if loader}
    {#if loading}
      <p
        class="text-xs text-[var(--color-text-muted)]"
        data-testid="relation-picker-loading-{fieldKey}"
      >
        Loading {relationTo ?? 'options'}…
      </p>
    {:else if pickerState === 'unreadable'}
      <p
        class="text-xs text-[var(--color-warning-text)]"
        data-testid="relation-picker-unreadable-{fieldKey}"
        title={`Directory read failed — ${unreadable}`}
      >
        The {relationTo ?? 'options'} list could not be read, so which ones exist
        is unknown. This is NOT a claim that there are none. You can still type or
        keep an id below and save. <span class="font-mono text-[var(--color-text-muted)]"
          >({unreadable})</span
        >
      </p>
    {:else if pickerState === 'empty'}
      <p
        class="text-xs text-[var(--color-text-muted)]"
        data-testid="relation-picker-empty-{fieldKey}"
      >
        No {relationTo ?? 'options'} to pick from.{#if unselectableCount > 0}
          <span data-testid="relation-picker-all-archived-{fieldKey}">
            All {unselectableCount} are archived — they can still be shown by name
            above, but none may be newly selected.
          </span>
        {/if}
      </p>
    {:else}
      <input
        type="text"
        value={query}
        oninput={(e) => (query = (e.currentTarget as HTMLInputElement).value)}
        placeholder={`Search ${relationTo ?? 'records'} by name…`}
        {disabled}
        data-testid="relation-picker-search-{fieldKey}"
        class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)]"
      />
      <ul
        data-testid="relation-picker-options-{fieldKey}"
        class="max-h-48 overflow-y-auto border border-[var(--color-border)] rounded divide-y divide-[var(--color-border)]"
      >
        {#each matches as opt (opt.id)}
          <li>
            <button
              type="button"
              onclick={() => choose(opt)}
              {disabled}
              data-testid="relation-picker-option-{fieldKey}-{opt.id}"
              class="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--color-surface-strong)] {opt.id ===
              currentId
                ? 'font-semibold'
                : ''}"
            >
              {opt.label}
            </button>
          </li>
        {/each}
        {#if matches.length === 0}
          <li
            class="px-3 py-1.5 text-xs text-[var(--color-text-muted)]"
            data-testid="relation-picker-no-match-{fieldKey}"
          >
            No {relationTo ?? 'records'} match “{query}”.
          </li>
        {/if}
      </ul>
    {/if}
  {/if}

  <!--
    The escape hatch, rendered in EVERY state including `unreadable`. It holds
    the canonical value: the option buttons above write into it. Without this,
    a directory outage would make the whole asset uncreatable, and an existing
    unresolvable id would be uneditable.
  -->
  <input
    id={fieldId}
    type="text"
    value={rawText}
    oninput={(e) => (value = (e.currentTarget as HTMLInputElement).value)}
    {required}
    {disabled}
    placeholder={relationTo ? `${relationTo} id` : 'related id'}
    data-testid="relation-picker-raw-{fieldKey}"
    class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm font-mono dark:border-[var(--color-border-strong)]"
  />
</div>
