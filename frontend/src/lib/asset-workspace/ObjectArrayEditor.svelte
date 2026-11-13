<!--
  ObjectArrayEditor.svelte

  A repeater for `FieldDef.type === 'objectArray'`: one row per element of an
  array of flat objects, with add / remove / move-up / move-down, driven
  entirely by the field's `itemFields`.

  Built for `procedures.steps` — the field whose absence from the procedures
  editor made every procedure fr creates permanently inert — but it is generic:
  it knows nothing about steps beyond the ONE name below.

  ## Why the helpers live in `<script module>`

  Reorder-plus-renumber is the only genuinely subtle behaviour here, and a bug
  in it is invisible in a screenshot: the rows LOOK reordered while
  `step_number` still describes the old order, and the procedure then executes
  in an order nobody chose. That deserves a unit test, and a test that has to
  mount a component to reach the logic is a test people delete when jsdom gets
  slow. So `emptyRow`, `renumber` and `moveRow` are pure, exported, and
  testable without a DOM — the shape `RepositoryRepeater.svelte` already uses
  for `emptyRepoRow` / `normalisePrimary` / `coherenceError`.

  ## Immutable updates only

  Every mutation REASSIGNS `rows` rather than splicing in place. The parent
  binds `form[field.key]`, which may hold a plain (non-proxied) array straight
  out of `manifest.api.get`, and a reassignment is the one write that is
  reactive either way — the same reason `RepositoryRepeater` says so.
-->
<script lang="ts" module>
  import type { FieldDef } from './manifest';

  /** A single row: a flat bag of string-keyed values. */
  export type ObjectRow = Record<string, unknown>;

  export type RowFieldDef = FieldDef<Record<string, unknown>>;

  /**
   * The ONE domain name this generic component knows.
   *
   * `renumber` rewrites this key and no other. A row field called
   * `retry_budget` is a number the human typed and must survive a reorder
   * untouched; `step_number` is POSITION, and a position that disagrees with
   * the visible order is the defect this component exists to prevent.
   */
  export const ORDINAL_KEY = 'step_number';

  /**
   * A blank row for `itemFields`.
   *
   * ⚠️ Every declared key is SET, including the ones set to `undefined`. That
   * looks pointless and is not: `renumber` asks `ORDINAL_KEY in row`, and a row
   * built by omission would answer `false` and never get numbered — a new step
   * would then post with no `step_number` at all, which upstream rejects
   * (`@minimum 1`, required).
   */
  export function emptyRow(itemFields: readonly RowFieldDef[]): ObjectRow {
    const row: ObjectRow = {};
    for (const f of itemFields) {
      switch (f.type) {
        case 'tags':
          row[f.key] = [];
          break;
        case 'boolean':
          row[f.key] = false;
          break;
        case 'number':
          row[f.key] = undefined;
          break;
        case 'json':
          row[f.key] = null;
          break;
        default:
          row[f.key] = '';
      }
    }
    return row;
  }

  /**
   * Rewrite `key` to each row's 1-based position.
   *
   * ⚠️ Guarded on the key being DECLARED on the rows (`key in row`), not on the
   * value being a number: a row whose `step_number` is currently `undefined`
   * (a freshly added one) is exactly the row that most needs numbering, and a
   * `typeof === 'number'` guard would skip it. Conversely a row shape that has
   * no such key at all — any other asset's objectArray — must come back
   * untouched rather than growing a `step_number` field the upstream schema
   * will reject as unknown.
   *
   * Contiguous and 1-based because that is what `validateSteps` demands and
   * what the procedures service stores; renumbering is the reason a human never
   * has to satisfy that by hand.
   */
  export function renumber(
    rows: readonly ObjectRow[],
    key: string = ORDINAL_KEY,
  ): ObjectRow[] {
    const declared = rows.some((r) => r != null && key in r);
    if (!declared) return rows.map((r) => ({ ...r }));
    return rows.map((r, i) => ({ ...r, [key]: i + 1 }));
  }

  /**
   * Move the element at `from` to index `to`, returning a NEW array.
   *
   * Out-of-range and no-op moves return a copy rather than throwing: the
   * up-arrow on row 0 and the down-arrow on the last row are disabled in the
   * markup, but a keyboard or test path that reaches them must not corrupt the
   * array. ⚠️ It does NOT renumber — callers compose `renumber(moveRow(...))`,
   * so the two concerns stay separately testable.
   */
  export function moveRow<R>(
    rows: readonly R[],
    from: number,
    to: number,
  ): R[] {
    const next = rows.slice();
    if (
      from < 0 ||
      to < 0 ||
      from >= next.length ||
      to >= next.length ||
      from === to
    ) {
      return next;
    }
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved as R);
    return next;
  }

  /** Comma-list → `string[]`, matching AssetEditor's own `tags` parser. */
  export function parseTagList(value: string): string[] {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Initial raw text for the free-text-backed row controls (`tags`, `json`). */
  export function rawTextFor(field: RowFieldDef, value: unknown): string {
    if (field.type === 'tags') {
      return Array.isArray(value) ? value.map(String).join(', ') : '';
    }
    if (field.type === 'json') {
      if (value == null) return '';
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return '';
  }
</script>

<script lang="ts">
  interface Props {
    fieldId: string;
    itemFields: readonly RowFieldDef[];
    /**
     * ⚠️ Typed `unknown`, and bindable with NO default — the same shape
     * `RelationPicker` uses and for the same two reasons. The parent binds
     * `form[field.key]` out of a `Record<string, unknown>`, so anything narrower
     * fails the bind at the type level; and `$bindable(null)` REFUSES a
     * `bind:` whose current value is `undefined`, which is exactly the state of
     * every field on the create form before the user touches it.
     *
     * A non-array (null, undefined, or a malformed value straight out of the api)
     * degrades to zero rows rather than throwing.
     */
    rows: unknown;
    /** Label for each row and the add button, e.g. 'step'. */
    itemLabel?: string;
    disabled?: boolean;
  }

  let {
    fieldId,
    itemFields,
    rows = $bindable<unknown>(),
    itemLabel = 'row',
    disabled = false,
  }: Props = $props();

  const list = $derived<ObjectRow[]>(
    Array.isArray(rows) ? (rows as ObjectRow[]) : [],
  );

  // Raw text for the `tags` / `json` row controls, kept in a PARALLEL array so
  // it survives a reorder.
  //
  // ⚠️ The obvious alternative — deriving the textbox value from the row array
  // on every keystroke — normalises the text out from under the typist: a
  // half-typed `a, ` round-trips through `parseTagList`/`join` and comes back
  // `a`, so the comma cannot be typed. And the other obvious alternative — a
  // per-row generated id used as a map key — would have to be stripped from the
  // payload, and the strip is the line someone eventually forgets.
  //
  // Every handler below mutates `raws` in lockstep with `rows`, and the effect
  // re-seeds it whenever the array is replaced from OUTSIDE (the edit form's
  // async hydrate).
  let raws = $state<Record<string, string>[]>([]);

  $effect(() => {
    // Length agreement is the ONLY trigger. Every in-component mutation keeps
    // the two arrays the same length, so reaching this body means the row array
    // was replaced from outside and the raw text must be re-seeded from it.
    // Re-seeding on any other signal would clobber what the human is typing.
    if (raws.length === list.length) return;
    raws = list.map((row) => {
      const seeded: Record<string, string> = {};
      for (const f of itemFields) seeded[f.key] = rawTextFor(f, row?.[f.key]);
      return seeded;
    });
  });

  // Per-row, per-field JSON parse errors. Advisory HERE (the blocking refusal
  // is the manifest's `validate`, run by AssetEditor's submit pre-flight) —
  // this only tells the human WHICH cell is malformed, which a single
  // form-level message cannot.
  let rowJsonError = $state<Record<string, string>>({});

  function commit(next: ObjectRow[], nextRaws: Record<string, string>[]): void {
    rows = next;
    raws = nextRaws;
  }

  function setField(i: number, key: string, value: unknown): void {
    commit(
      list.map((r, j) => (j === i ? { ...r, [key]: value } : r)),
      raws,
    );
  }

  function onTagsInput(i: number, key: string, text: string): void {
    raws[i] = { ...(raws[i] ?? {}), [key]: text };
    setField(i, key, parseTagList(text));
  }

  function onJsonInput(i: number, key: string, text: string): void {
    raws[i] = { ...(raws[i] ?? {}), [key]: text };
    const slot = `${i}:${key}`;
    if (text.trim() === '') {
      rowJsonError[slot] = '';
      setField(i, key, null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      rowJsonError[slot] = '';
      setField(i, key, parsed);
    } catch (e) {
      rowJsonError[slot] = e instanceof Error ? e.message : 'Invalid JSON';
    }
  }

  function addRow(): void {
    const seeded: Record<string, string> = {};
    for (const f of itemFields) seeded[f.key] = rawTextFor(f, undefined);
    commit(renumber([...list, emptyRow(itemFields)]), [...raws, seeded]);
  }

  function removeRow(i: number): void {
    commit(
      renumber(list.filter((_, j) => j !== i)),
      raws.filter((_, j) => j !== i),
    );
    rowJsonError = {};
  }

  function move(i: number, delta: number): void {
    const to = i + delta;
    // ⭐ Renumber AFTER the move, every time. A reorder that does not renumber
    // leaves `step_number` describing the OLD order, and the procedure then
    // runs in an order the human never chose — visible nowhere on screen.
    commit(renumber(moveRow(list, i, to)), moveRow(raws, i, to));
    rowJsonError = {};
  }

  const inputClass =
    'w-full border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm dark:border-[var(--color-border-strong)]';
  const btnClass =
    'px-2 py-1 text-xs rounded border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface)] disabled:opacity-40 disabled:cursor-not-allowed';
</script>

<div class="space-y-3" data-testid="object-array-editor" id={fieldId}>
  {#each list as row, i (i)}
    <div
      class="rounded border border-[var(--color-border)] p-3 space-y-2"
      data-testid="object-array-row"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-semibold text-[var(--color-text-muted)]">
          {itemLabel} {i + 1}
        </span>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class={btnClass}
            data-testid="object-array-up-{i}"
            aria-label="Move {itemLabel} {i + 1} up"
            disabled={disabled || i === 0}
            onclick={() => move(i, -1)}>↑</button
          >
          <button
            type="button"
            class={btnClass}
            data-testid="object-array-down-{i}"
            aria-label="Move {itemLabel} {i + 1} down"
            disabled={disabled || i === list.length - 1}
            onclick={() => move(i, 1)}>↓</button
          >
          <button
            type="button"
            class="{btnClass} text-[var(--color-danger)]"
            data-testid="object-array-remove-{i}"
            aria-label="Remove {itemLabel} {i + 1}"
            {disabled}
            onclick={() => removeRow(i)}>Remove</button
          >
        </div>
      </div>

      {#each itemFields as f (f.key)}
        {@const cellId = `${fieldId}-${i}-${f.key}`}
        <div>
          <label
            for={cellId}
            class="block text-[0.7rem] font-semibold uppercase text-[var(--color-text-muted)] mb-0.5"
          >
            {f.label}{#if f.required}<span class="text-[var(--color-danger)] ml-0.5"
                >*</span
              >{/if}
          </label>

          {#if f.type === 'text'}
            <input
              id={cellId}
              type="text"
              class={inputClass}
              {disabled}
              placeholder={f.helpText ?? ''}
              value={String(row?.[f.key] ?? '')}
              oninput={(e) => setField(i, f.key, e.currentTarget.value)}
            />
          {:else if f.type === 'longtext'}
            <textarea
              id={cellId}
              rows="3"
              class={inputClass}
              {disabled}
              placeholder={f.helpText ?? ''}
              value={String(row?.[f.key] ?? '')}
              oninput={(e) => setField(i, f.key, e.currentTarget.value)}
            ></textarea>
          {:else if f.type === 'number'}
            <input
              id={cellId}
              type="number"
              class={inputClass}
              {disabled}
              value={row?.[f.key] == null ? '' : String(row[f.key])}
              oninput={(e) => {
                const raw = e.currentTarget.value;
                const n = Number(raw);
                setField(
                  i,
                  f.key,
                  raw === '' || !Number.isFinite(n) ? undefined : n,
                );
              }}
            />
          {:else if f.type === 'boolean'}
            <input
              id={cellId}
              type="checkbox"
              class="h-4 w-4 align-middle"
              {disabled}
              checked={Boolean(row?.[f.key])}
              oninput={(e) => setField(i, f.key, e.currentTarget.checked)}
            />
          {:else if f.type === 'tags'}
            <input
              id={cellId}
              type="text"
              class={inputClass}
              {disabled}
              placeholder={f.helpText ?? 'comma, separated, values'}
              value={raws[i]?.[f.key] ?? ''}
              oninput={(e) => onTagsInput(i, f.key, e.currentTarget.value)}
            />
          {:else if f.type === 'json'}
            <textarea
              id={cellId}
              rows="3"
              class="{inputClass} font-mono"
              {disabled}
              value={raws[i]?.[f.key] ?? ''}
              oninput={(e) => onJsonInput(i, f.key, e.currentTarget.value)}
            ></textarea>
            {#if rowJsonError[`${i}:${f.key}`]}
              <p class="text-xs text-[var(--color-danger)] mt-0.5">
                {rowJsonError[`${i}:${f.key}`]}
              </p>
            {/if}
          {/if}

          {#if f.helpText && f.type !== 'text' && f.type !== 'longtext' && f.type !== 'tags'}
            <p class="text-[0.7rem] text-[var(--color-text-muted)] mt-0.5">
              {f.helpText}
            </p>
          {/if}
        </div>
      {/each}
    </div>
  {/each}

  {#if list.length === 0}
    <p
      class="text-sm text-[var(--color-text-muted)]"
      data-testid="object-array-empty"
    >
      No {itemLabel}s yet.
    </p>
  {/if}

  <button
    type="button"
    class={btnClass}
    data-testid="object-array-add"
    {disabled}
    onclick={addRow}>+ Add {itemLabel}</button
  >
</div>
