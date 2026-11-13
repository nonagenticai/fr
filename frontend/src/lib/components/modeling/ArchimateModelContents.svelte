<!--
  ArchimateModelContents — what an ArchiMate model holds, on its model page:
  elements, relationships and views, each with a way to add and delete one;
  and, for the view that is open, its diagram with the shapes and lines on it.

  The metamodel is requirements_management's, never fr's: the element type
  picker lists RM's concepts grouped by layer (the layer follows from the type,
  it is never typed), and the relationship type picker offers only what RM's
  matrix allows between the two chosen elements' types. RM still checks every
  change against the whole model and refuses one that would break it
  (422 `model_integrity`); its problems are listed under the form.

  Creates, and adding or removing a shape or line, send the model head the page
  last read (If-Match): a change someone else made in between is refused (412)
  with a Reload instead of being overwritten. Deleting an element, relationship
  or view is the exception — RM's delete route carries no precondition, so a
  delete is last-write-wins — and it is DESTRUCTIVE (an element takes its
  relationships and shapes with it): the person types the item's name (a
  relationship: its name, else the sentence that names it, "Order System
  realizes Order Service") to confirm, as on the UML pages (UmlDeletePanel).

  Element, relationship and view creates carry one Idempotency-Key per distinct
  write payload (never one shared slot): it survives a failed attempt and a
  close/reopen, so retrying a change that already landed answers with its first
  row instead of creating a duplicate. A view's shapes and lines get NO key —
  requirements_management declares none there — so after an add whose outcome
  is unknown (no answer, a 5xx) the view is RE-READ before another add is
  offered: an element that landed is then on the view and no longer offered.
  After every change the lists, the open view and its diagram are read again,
  and the page's model (its head) is reloaded; a write that landed but whose
  reload failed says exactly that, because "failed" there invites a duplicate
  retry.

  A capped page is named as one: each list carries the upstream's truncation
  signal, so a model too large for one page never renders as the whole model and
  the shape/line pickers say they see only part of it.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import DiagramViewer from './DiagramViewer.svelte';
  import {
    ModelingError,
    addViewConnection,
    addViewObject,
    allowedRelationshipTypes,
    createArchimateElement,
    createArchimateRelationship,
    createArchimateView,
    deleteArchimate,
    getMetamodelConcepts,
    listArchimate,
    listViewConnections,
    listViewObjects,
    newIntentKey,
    removeViewConnection,
    removeViewObject,
    type ArchimateElement,
    type ArchimateRelationship,
    type ArchimateResource,
    type ArchimateView,
    type ArchimateViewConnection,
    type ArchimateViewObject,
    type MetamodelConcept,
    type ValidationFinding,
  } from '$lib/api/modeling';
  import {
    VIEWPOINTS,
    conceptsByLayer,
    elementLabel,
    elementTypeLabel,
    layerLabel,
    layerOfType,
    nextShapeBounds,
    relationshipLabel,
    relationshipTypeLabel,
  } from '$lib/modeling/archimate';
  import { plural } from '$lib/modeling/explain';

  let {
    modelId,
    projectId,
    visibility,
    head,
    onChange,
  }: {
    modelId: string;
    projectId: string | null;
    visibility: string;
    /** The model's draft head as the page last read it (sent as If-Match). */
    head: number | undefined;
    /** Reload the model (its head) after a change; awaited before the next write. */
    onChange?: () => Promise<unknown> | void;
  } = $props();

  let elements = $state<ArchimateElement[]>([]);
  let relationships = $state<ArchimateRelationship[]>([]);
  let views = $state<ArchimateView[]>([]);
  let concepts = $state<MetamodelConcept[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** Per list, whether the upstream page was capped: a partial model must say so. */
  let truncated = $state<Record<ArchimateResource, boolean>>({ elements: false, relationships: false, views: false });

  async function loadContents(): Promise<void> {
    const [els, rels, vs] = await Promise.all([
      listArchimate<ArchimateElement>('elements', modelId),
      listArchimate<ArchimateRelationship>('relationships', modelId),
      listArchimate<ArchimateView>('views', modelId),
    ]);
    elements = els.items;
    relationships = rels.items;
    views = vs.items;
    truncated = { elements: els.truncated, relationships: rels.truncated, views: vs.truncated };
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [, meta] = await Promise.all([loadContents(), concepts.length ? Promise.resolve(null) : getMetamodelConcepts()]);
      if (meta) concepts = meta.concepts;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void modelId;
    // Only the model id re-runs the load (it reads and writes state of its own).
    untrack(() => load());
  });

  const byId = $derived(new Map(elements.map((e) => [e.id, e])));
  const nameOf = $derived(new Map(elements.map((e) => [e.id, e.title])));
  const typeGroups = $derived(conceptsByLayer(concepts));

  // --- Problems shown under whichever form or panel is acting ------------------
  let busy = $state(false);
  let formError = $state<string | null>(null);
  let formFindings = $state<ValidationFinding[]>([]);
  let stale = $state(false);
  /** Where the last write was made, so its problems show there (and only there). */
  type At = 'element' | 'relationship' | 'view' | 'editor' | 'list';
  let problemsAt = $state<At>('list');

  function clearProblems(): void {
    formError = null;
    formFindings = [];
    stale = false;
  }

  /** Show a write's refusal where its form can (message, findings, stale head). */
  function reportProblem(err: unknown): void {
    formError = err instanceof Error ? err.message : String(err);
    if (err instanceof ModelingError) {
      if (err.findings?.length) formFindings = err.findings;
      if (err.code === 'stale_head') stale = true;
    }
  }

  /** Run one write; on success re-read everything it can have changed. */
  async function write(at: At, fn: () => Promise<unknown>): Promise<boolean> {
    busy = true;
    clearProblems();
    problemsAt = at;
    try {
      try {
        await fn();
      } catch (err) {
        reportProblem(err);
        return false;
      }
      // The write LANDED. A failure from here on is a stale page, not a failed
      // change — reporting it as a failure is how a create that had already
      // committed got retried, and duplicated (2026-10-29).
      try {
        await Promise.all([loadContents(), selectedView ? loadView() : Promise.resolve(), onChange?.()]);
        pictureKey += 1;
        return true;
      } catch (err) {
        formError = `The change was saved, but the page could not be refreshed: ${err instanceof Error ? err.message : String(err)}. Reload the page to see it.`;
        return false;
      }
    } finally {
      busy = false;
    }
  }

  async function reloadAll(): Promise<void> {
    clearProblems();
    await Promise.all([onChange?.(), loadContents(), selectedView ? loadView() : Promise.resolve()]);
    pictureKey += 1;
  }

  // --- Add forms ---------------------------------------------------------------
  let open = $state<'element' | 'relationship' | 'view' | null>(null);
  /**
   * ONE Idempotency-Key per distinct write PAYLOAD (its "intent"), held against
   * that payload. A key survives a failed attempt AND closing/reopening the
   * form, so a write that landed but whose answer or refresh failed is answered
   * with its first row instead of creating a second one. The key follows the
   * payload and never a single shared slot: a changed payload always gets a
   * fresh key (it can never replay an older row), and two different submissions
   * cannot overwrite each other's key in between. A write that succeeded
   * retires its key.
   */
  type IntentKind = 'element' | 'relationship' | 'view';
  const intentKeys = new Map<string, string>();
  /** Stable JSON: keys sorted, so the same payload always signs the same. */
  function stableJson(value: unknown): string {
    return JSON.stringify(value, (_key: string, v: unknown) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    });
  }
  function intentSignature(kind: IntentKind, input: unknown): string {
    return `${kind}:${stableJson(input)}`;
  }
  function intentKeyFor(kind: IntentKind, input: unknown): string {
    const signature = intentSignature(kind, input);
    let key = intentKeys.get(signature);
    if (!key) {
      key = newIntentKey();
      intentKeys.set(signature, key);
    }
    return key;
  }
  function endIntent(kind: IntentKind, input: unknown): void {
    intentKeys.delete(intentSignature(kind, input));
  }
  function show(which: typeof open): void {
    open = open === which ? null : which;
    clearProblems();
  }
  const opts = (idempotencyKey: string) => ({ idempotencyKey, head, visibility });

  // Element: the type is chosen from the metamodel; the layer follows from it.
  let elType = $state('');
  let elName = $state('');
  const elLayer = $derived(elType ? layerOfType(concepts, elType) : null);
  async function addElement(e: Event): Promise<void> {
    e.preventDefault();
    if (!elType || !elLayer || !elName.trim()) return;
    const input = { model_id: modelId, title: elName.trim(), element_type: elType, layer: elLayer, project_id: projectId };
    const ok = await write('element', () => createArchimateElement(input, opts(intentKeyFor('element', input))));
    if (ok) {
      elName = '';
      endIntent('element', input);
    }
  }

  // Relationship: two elements of this model; the type picker offers what the matrix allows for their types.
  let relSource = $state('');
  let relTarget = $state('');
  let relType = $state('');
  let allowed = $state<string[] | null>(null);
  let allowedError = $state<string | null>(null);
  const allowedCache = new Map<string, string[]>();
  $effect(() => {
    const s = byId.get(relSource);
    const t = byId.get(relTarget);
    allowed = null;
    allowedError = null;
    relType = '';
    if (!s || !t) return;
    const key = `${s.element_type}>${t.element_type}`;
    const hit = allowedCache.get(key);
    if (hit) {
      allowed = hit;
      relType = hit.length === 1 ? hit[0]! : '';
      return;
    }
    let cancelled = false;
    allowedRelationshipTypes(s.element_type, t.element_type)
      .then((types) => {
        if (cancelled) return;
        allowedCache.set(key, types);
        allowed = types;
        relType = types.length === 1 ? types[0]! : '';
      })
      .catch((err) => {
        if (!cancelled) allowedError = err instanceof Error ? err.message : String(err);
      });
    return () => {
      cancelled = true;
    };
  });
  async function addRelationship(e: Event): Promise<void> {
    e.preventDefault();
    if (!relSource || !relTarget || !relType) return;
    const input = { source_id: relSource, target_id: relTarget, relationship_type: relType, project_id: projectId };
    const ok = await write('relationship', () => createArchimateRelationship(input, opts(intentKeyFor('relationship', input))));
    if (ok) {
      relSource = '';
      relTarget = '';
      endIntent('relationship', input);
    }
  }

  // View.
  let viewName = $state('');
  let viewpoint = $state('');
  async function addView(e: Event): Promise<void> {
    e.preventDefault();
    if (!viewName.trim()) return;
    const input = { model_id: modelId, title: viewName.trim(), viewpoint: viewpoint || null, project_id: projectId };
    let created: ArchimateView | null = null;
    const ok = await write('view', async () => {
      created = await createArchimateView(input, opts(intentKeyFor('view', input)));
    });
    if (ok) {
      viewName = '';
      viewpoint = '';
      endIntent('view', input);
      open = null;
      if (created) await openView((created as ArchimateView).id);
    }
  }

  // --- Deleting: DESTRUCTIVE, confirmed by typing the item's name (as UmlDeletePanel) ---
  type Deletable = 'elements' | 'relationships' | 'views';
  let confirming = $state<{ resource: Deletable; id: string; name: string } | null>(null);
  let typed = $state('');
  const typedMatches = $derived(!!confirming && confirming.name.trim() !== '' && typed.trim() === confirming.name.trim());
  function askDelete(resource: Deletable, id: string, name: string): void {
    confirming = { resource, id, name };
    typed = '';
    clearProblems();
  }
  function cancelDelete(): void {
    confirming = null;
    typed = '';
  }
  async function remove(): Promise<void> {
    if (!confirming || !typedMatches) return;
    const { resource, id } = confirming;
    confirming = null;
    typed = '';
    if (resource === 'views' && selectedView === id) selectedView = null;
    await write('list', () => deleteArchimate(resource, id));
  }

  // --- The open view: its diagram, shapes and lines ------------------------------
  let selectedView = $state<string | null>(null);
  let objects = $state<ArchimateViewObject[]>([]);
  let connections = $state<ArchimateViewConnection[]>([]);
  let viewError = $state<string | null>(null);
  let pictureKey = $state(0);
  let addShape = $state('');
  let addLine = $state('');

  async function loadView(): Promise<void> {
    if (!selectedView) return;
    [objects, connections] = await Promise.all([listViewObjects(selectedView), listViewConnections(selectedView)]);
  }
  function pickView(id: string): void {
    if (!id) {
      selectedView = null;
      return;
    }
    void openView(id);
  }
  async function openView(id: string): Promise<void> {
    selectedView = id;
    objects = [];
    connections = [];
    viewError = null;
    addShape = '';
    addLine = '';
    clearProblems();
    try {
      await loadView();
      pictureKey += 1;
      // A fresh read of the view is what an unknown-outcome add was waiting for.
      mustReread = false;
    } catch (err) {
      viewError = err instanceof Error ? err.message : String(err);
    }
  }
  const currentView = $derived(views.find((v) => v.id === selectedView) ?? null);
  const shapeOf = (elementId: string) => objects.find((o) => o.kind === 'element' && o.concept_ref === elementId);
  const shapeChoices = $derived(elements.filter((e) => !shapeOf(e.id)));
  // A line can be drawn for a relationship whose two ends are both shown on the view.
  const lineChoices = $derived(relationships.filter((r) => !connections.some((c) => c.relationship_ref === r.id) && shapeOf(r.source_id) && shapeOf(r.target_id)));
  const hiddenLines = $derived(relationships.filter((r) => !connections.some((c) => c.relationship_ref === r.id) && !(shapeOf(r.source_id) && shapeOf(r.target_id))).length);

  /**
   * RM takes no Idempotency-Key on a shape or line, so an add whose OUTCOME IS
   * UNKNOWN (no answer, a 5xx — anything but RM's own 4xx refusal) may have
   * landed. Until the view has been read again, no other add is offered: the
   * re-read shows what landed, and the pickers stop offering it.
   */
  let mustReread = $state(false);
  const outcomeUnknown = (err: unknown) => !(err instanceof ModelingError) || err.status >= 500;
  async function addToView(fn: () => Promise<unknown>): Promise<boolean> {
    let unknownOutcome = false;
    const ok = await write('editor', async () => {
      try {
        await fn();
      } catch (err) {
        unknownOutcome = outcomeUnknown(err);
        throw err;
      }
    });
    if (!ok && unknownOutcome) await rereadView();
    return ok;
  }
  async function rereadView(): Promise<void> {
    mustReread = true;
    try {
      await loadView();
      pictureKey += 1;
      mustReread = false;
    } catch (err) {
      viewError = err instanceof Error ? err.message : String(err);
    }
  }

  async function placeShape(): Promise<void> {
    const view = selectedView;
    if (!view || !addShape || mustReread) return;
    const bounds = nextShapeBounds(objects.map((o) => o.bounds));
    const ok = await addToView(() => addViewObject(view, { concept_ref: addShape, bounds }, { head }));
    if (ok) addShape = '';
  }
  async function drawLine(): Promise<void> {
    const view = selectedView;
    const r = relationships.find((x) => x.id === addLine);
    if (!view || !r) return;
    const a = shapeOf(r.source_id);
    const b = shapeOf(r.target_id);
    if (!a || !b) {
      problemsAt = 'editor';
      formError = 'Place both elements on the view first.';
      return;
    }
    if (mustReread) return;
    const ok = await addToView(() => addViewConnection(view, { relationship_ref: r.id, source_object_id: a.id, target_object_id: b.id }, { head }));
    if (ok) addLine = '';
  }
  const objectLabel = (o: ArchimateViewObject) => (o.concept_ref ? (byId.get(o.concept_ref) ? elementLabel(byId.get(o.concept_ref)!) : 'An element no longer in the model') : o.name || o.text || (o.kind === 'note' ? 'A note' : 'A group'));
  const connectionLabel = (c: ArchimateViewConnection) => {
    const r = relationships.find((x) => x.id === c.relationship_ref);
    return r ? relationshipLabel(r, nameOf) : 'A line';
  };

  const field = 'rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]';
  const primary = 'rounded-md bg-[var(--color-accent)] px-3 py-1 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50';
  const addBtn = 'rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50';
  const small = 'text-xs font-medium text-[var(--color-link)] underline disabled:opacity-40';
  const danger = 'text-xs font-medium text-[var(--color-danger)] underline disabled:opacity-40';
  const card = 'flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4';
  const label = 'flex flex-col gap-1 text-xs text-[var(--color-text-muted)]';
</script>

{#snippet problems(at: At)}
  {#if problemsAt === at && formError}
    <div class="flex flex-wrap items-center gap-2" data-testid="archimate-form-error">
      <p class="text-sm text-[var(--color-danger)]">{formError}</p>
      {#if stale}<button type="button" class={small} onclick={reloadAll} data-testid="archimate-reload">Reload the latest version</button>{/if}
    </div>
  {/if}
  {#if problemsAt === at && formFindings.length > 0}
    <ul class="list-disc pl-5 text-sm text-[var(--color-danger)]" data-testid="archimate-form-findings">{#each formFindings as f, i (i)}<li title={`Rule ${f.rule_id}`}>{f.message}</li>{/each}</ul>
  {/if}
{/snippet}

{#snippet deleteButton(resource: Deletable, id: string, name: string, testid: string)}
  <button type="button" class={danger} disabled={busy} onclick={() => askDelete(resource, id, name)} data-testid={testid}>Delete…</button>
{/snippet}

{#snippet deleteConfirm(resource: Deletable, id: string, what: string, effect: string)}
  {#if confirming && confirming.resource === resource && confirming.id === id}
    <div class="flex w-full flex-col gap-2 rounded-md border border-[var(--color-danger-border)] p-2" data-testid="archimate-delete-confirm">
      <p class="text-sm text-[var(--color-text)]">{effect} Type <strong>{confirming.name}</strong> to confirm.</p>
      <input class={field} bind:value={typed} autocomplete="off" aria-label={`The ${what}'s name`} data-testid="archimate-delete-typed" />
      <div class="flex gap-2">
        <button type="button" class="rounded-md bg-[var(--color-danger)] px-3 py-1 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50" disabled={!typedMatches || busy} onclick={remove} data-testid="archimate-delete-confirm-button">{`Delete the ${what}`}</button>
        <button type="button" class="px-3 py-1 text-sm text-[var(--color-text-muted)]" onclick={cancelDelete}>Cancel</button>
      </div>
    </div>
  {/if}
{/snippet}

<div class="flex flex-col gap-4" data-testid="archimate-contents">
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the model's contents…</p>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2" data-testid="archimate-contents-error">
      <p class="text-sm text-[var(--color-danger)]">The model's contents could not be loaded: {error}</p>
      <button type="button" class="text-sm font-medium text-[var(--color-link)] underline" onclick={load}>Try again</button>
    </div>
  {:else}
    {@render problems('list')}
    <!-- Elements -->
    <section class={card} data-testid="archimate-elements">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Elements ({elements.length})</h2>
        <button type="button" class={addBtn} onclick={() => show('element')} disabled={concepts.length === 0} data-testid="archimate-add-element">Add an element</button>
      </div>
      {#if truncated.elements}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="archimate-elements-truncated">This page is capped, so there may be more elements than are listed here — this list and the shape picker below may be incomplete.</p>
      {/if}
      {#if open === 'element'}
        <form class="flex flex-wrap items-end gap-2" onsubmit={addElement} data-testid="archimate-element-form">
          <label class={label}>Type
            <select class={field} bind:value={elType} required data-testid="archimate-element-type">
              <option value="">Choose a type…</option>
              {#each typeGroups as g (g.layer)}
                <optgroup label={g.label}>{#each g.concepts as c (c.type)}<option value={c.type}>{elementTypeLabel(c.type)}</option>{/each}</optgroup>
              {/each}
            </select>
          </label>
          <span class="pb-1.5 text-xs text-[var(--color-text-muted)]" data-testid="archimate-element-layer">Layer: {elLayer ? layerLabel(elLayer) : '—'}</span>
          <label class={label}>Name<input class={field} bind:value={elName} required maxlength="300" data-testid="archimate-element-name" /></label>
          <button type="submit" class={primary} disabled={busy || !elType || !elName.trim()} data-testid="archimate-element-create">{busy ? 'Adding…' : 'Add'}</button>
        </form>
        {@render problems('element')}
      {/if}
      {#if elements.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No elements yet.</p>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each elements as e (e.id)}
            <li class="flex flex-wrap items-center justify-between gap-2" data-testid="archimate-element-row">
              <span class="text-sm text-[var(--color-text)]"><a class="text-[var(--color-link)] hover:underline" href={`/library/architecture/elements/${encodeURIComponent(e.id)}`}>{e.title}</a> <span class="text-xs text-[var(--color-text-muted)]">{elementTypeLabel(e.element_type)} · {layerLabel(e.layer)}</span></span>
              <span class="flex items-center gap-2">{@render deleteButton('elements', e.id, e.title, 'archimate-element-delete')}</span>
              {@render deleteConfirm('elements', e.id, 'element', 'Its relationships and the shapes showing it on every view are deleted with it.')}
            </li>
          {/each}
        </ul>
        <p class="text-xs text-[var(--color-text-muted)]">Deleting an element also removes its relationships and the shapes showing it.</p>
      {/if}
    </section>

    <!-- Relationships -->
    <section class={card} data-testid="archimate-relationships">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Relationships ({relationships.length})</h2>
        <button type="button" class={addBtn} onclick={() => show('relationship')} disabled={elements.length < 1} data-testid="archimate-add-relationship">Add a relationship</button>
      </div>
      {#if truncated.relationships}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="archimate-relationships-truncated">This page is capped, so there may be more relationships than are listed here — this list and the line picker below may be incomplete.</p>
      {/if}
      {#if open === 'relationship'}
        <form class="flex flex-wrap items-end gap-2" onsubmit={addRelationship} data-testid="archimate-relationship-form">
          <label class={label}>From
            <select class={field} bind:value={relSource} data-testid="archimate-relationship-source"><option value="">Choose…</option>{#each elements as e (e.id)}<option value={e.id}>{elementLabel(e)}</option>{/each}</select>
          </label>
          <label class={label}>To
            <select class={field} bind:value={relTarget} data-testid="archimate-relationship-target"><option value="">Choose…</option>{#each elements as e (e.id)}<option value={e.id}>{elementLabel(e)}</option>{/each}</select>
          </label>
          <label class={label}>Relationship
            <select class={field} bind:value={relType} disabled={!allowed || allowed.length === 0} data-testid="archimate-relationship-type">
              <option value="">{!relSource || !relTarget ? 'Choose both elements first' : allowed === null ? 'Looking up what ArchiMate allows…' : allowed.length === 0 ? 'Nothing is allowed here' : 'Choose…'}</option>
              {#each allowed ?? [] as t (t)}<option value={t}>{relationshipTypeLabel(t)}</option>{/each}
            </select>
          </label>
          <button type="submit" class={primary} disabled={busy || !relType} data-testid="archimate-relationship-create">{busy ? 'Adding…' : 'Add'}</button>
        </form>
        {#if allowed && allowed.length === 0}
          <p class="text-sm text-[var(--color-text-muted)]" data-testid="archimate-relationship-none">ArchiMate allows no relationship from a {elementTypeLabel(byId.get(relSource)?.element_type ?? '')} to a {elementTypeLabel(byId.get(relTarget)?.element_type ?? '')}.</p>
        {/if}
        {#if allowedError}<p class="text-sm text-[var(--color-danger)]">The allowed relationships could not be looked up: {allowedError}</p>{/if}
        {@render problems('relationship')}
      {/if}
      {#if relationships.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No relationships yet.</p>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each relationships as r (r.id)}
            <li class="flex flex-wrap items-center justify-between gap-2" data-testid="archimate-relationship-row">
              <span class="text-sm text-[var(--color-text)]">{relationshipLabel(r, nameOf)} <span class="text-xs text-[var(--color-text-muted)]">{relationshipTypeLabel(r.relationship_type)}</span></span>
              <span class="flex items-center gap-2">{@render deleteButton('relationships', r.id, r.name?.trim() || relationshipLabel(r, nameOf), 'archimate-relationship-delete')}</span>
              {@render deleteConfirm('relationships', r.id, 'relationship', 'The lines showing it on every view are deleted with it.')}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Views -->
    <section class={card} data-testid="archimate-views">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Views ({views.length})</h2>
        <button type="button" class={addBtn} onclick={() => show('view')} data-testid="archimate-add-view">Add a view</button>
      </div>
      <p class="text-xs text-[var(--color-text-muted)]">A view is a diagram of some of the model's elements and relationships.</p>
      {#if truncated.views}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="archimate-views-truncated">This page is capped, so there may be more views than are listed here — this list and the view picker below may be incomplete.</p>
      {/if}
      {#if open === 'view'}
        <form class="flex flex-wrap items-end gap-2" onsubmit={addView} data-testid="archimate-view-form">
          <label class={label}>Name<input class={field} bind:value={viewName} required maxlength="300" data-testid="archimate-view-name" /></label>
          <label class={label}>Viewpoint (optional)
            <select class={field} bind:value={viewpoint} data-testid="archimate-view-viewpoint"><option value="">None</option>{#each VIEWPOINTS as [id, name] (id)}<option value={id}>{name}</option>{/each}</select>
          </label>
          <button type="submit" class={primary} disabled={busy || !viewName.trim()} data-testid="archimate-view-create">{busy ? 'Adding…' : 'Add'}</button>
        </form>
        {@render problems('view')}
      {/if}
      {#if views.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No views yet.</p>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each views as v (v.id)}
            <li class="flex flex-wrap items-center justify-between gap-2" data-testid="archimate-view-row">
              <span class="text-sm text-[var(--color-text)]">
                <a class="font-medium text-[var(--color-link)] hover:underline" href={`/library/architecture/views/${encodeURIComponent(v.id)}`}>{v.title}</a>
                {#if v.viewpoint}<span class="text-xs text-[var(--color-text-muted)]">{VIEWPOINTS.find(([id]) => id === v.viewpoint)?.[1] ?? v.viewpoint}</span>{/if}
              </span>
              <span class="flex items-center gap-2">{@render deleteButton('views', v.id, v.title, 'archimate-view-delete')}</span>
              {@render deleteConfirm('views', v.id, 'view', 'Only the diagram goes; its elements and relationships stay in the model.')}
            </li>
          {/each}
        </ul>
        <!-- Which view to edit here: a picker over the one list above, not a menu of pages. -->
        <label class="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">Edit a view on this page
          <select class={field} value={selectedView ?? ''} onchange={(e) => pickView((e.currentTarget as HTMLSelectElement).value)} data-testid="archimate-view-pick">
            <option value="">Choose a view…</option>
            {#each views as v (v.id)}<option value={v.id}>{v.title}</option>{/each}
          </select>
        </label>
      {/if}
    </section>

    {#if currentView}
      <!-- The open view -->
      <section class={card} data-testid="archimate-view-editor">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-base font-semibold text-[var(--color-text)]" data-testid="archimate-view-title">{currentView.title}</h2>
          <a class={small} href={`/library/architecture/views/${encodeURIComponent(currentView.id)}`}>Open the view's page</a>
        </div>
        {#key `${currentView.id}:${pictureKey}`}<DiagramViewer viewId={currentView.id} title={currentView.title} />{/key}
        {#if viewError}
          <div class="flex flex-wrap items-center gap-2"><p class="text-sm text-[var(--color-danger)]">What the view shows could not be loaded: {viewError}</p><button type="button" class={small} onclick={() => openView(currentView!.id)}>Try again</button></div>
        {:else}
          <div class="grid gap-4 md:grid-cols-2">
            <div class="flex flex-col gap-2">
              <h3 class="text-sm font-semibold text-[var(--color-text)]">Shapes ({objects.length})</h3>
              <ul class="flex flex-col gap-1">
                {#each objects as o (o.id)}
                  <li class="flex items-center justify-between gap-2 text-sm text-[var(--color-text)]" data-testid="archimate-view-object">
                    <span>{objectLabel(o)}</span>
                    <button type="button" class={small} disabled={busy} onclick={() => write('editor', () => removeViewObject(currentView!.id, o.id, head))} data-testid="archimate-view-object-remove">Remove from view</button>
                  </li>
                {/each}
              </ul>
              <div class="flex flex-wrap items-end gap-2">
                <select class={field} bind:value={addShape} aria-label="Place an element on the view" data-testid="archimate-view-add-shape">
                  <option value="">{shapeChoices.length ? 'Choose an element to place…' : elements.length ? 'Every element is already on the view' : 'Add elements to the model first'}</option>
                  {#each shapeChoices as e (e.id)}<option value={e.id}>{elementLabel(e)}</option>{/each}
                </select>
                <button type="button" class={addBtn} disabled={!addShape || busy || mustReread} onclick={placeShape} data-testid="archimate-view-add-shape-button">Place</button>
              </div>
              {#if truncated.elements}
                <p class="text-xs text-[var(--color-warning-text)]">Only the elements this page read can be placed; the model holds more.</p>
              {/if}
            </div>
            <div class="flex flex-col gap-2">
              <h3 class="text-sm font-semibold text-[var(--color-text)]">Lines ({connections.length})</h3>
              <ul class="flex flex-col gap-1">
                {#each connections as c (c.id)}
                  <li class="flex items-center justify-between gap-2 text-sm text-[var(--color-text)]" data-testid="archimate-view-connection">
                    <span>{connectionLabel(c)}</span>
                    <button type="button" class={small} disabled={busy} onclick={() => write('editor', () => removeViewConnection(currentView!.id, c.id, head))} data-testid="archimate-view-connection-remove">Remove from view</button>
                  </li>
                {/each}
              </ul>
              <div class="flex flex-wrap items-end gap-2">
                <select class={field} bind:value={addLine} aria-label="Draw a relationship on the view" data-testid="archimate-view-add-line">
                  <option value="">{lineChoices.length ? 'Choose a relationship to draw…' : 'Nothing to draw yet'}</option>
                  {#each lineChoices as r (r.id)}<option value={r.id}>{relationshipLabel(r, nameOf)}</option>{/each}
                </select>
                <button type="button" class={addBtn} disabled={!addLine || busy || mustReread} onclick={drawLine} data-testid="archimate-view-add-line-button">Draw</button>
              </div>
              {#if truncated.relationships}
                <p class="text-xs text-[var(--color-warning-text)]">Only the relationships this page read can be drawn; the model holds more.</p>
              {/if}
              {#if hiddenLines > 0}
                <p class="text-xs text-[var(--color-text-muted)]">{plural(hiddenLines, 'relationship')} can be drawn once both of {hiddenLines === 1 ? 'its' : 'their'} elements are on the view.</p>
              {/if}
            </div>
          </div>
          {@render problems('editor')}
          {#if mustReread}
            <div class="flex flex-wrap items-center gap-2" data-testid="archimate-view-reread">
              <p class="text-sm text-[var(--color-warning-text)]">It is not known whether the last change reached the view. Read the view again before adding anything else.</p>
              <button type="button" class={small} disabled={busy} onclick={rereadView} data-testid="archimate-view-reread-button">Read the view again</button>
            </div>
          {/if}
        {/if}
      </section>
    {/if}
  {/if}
</div>
