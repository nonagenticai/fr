<!--
  /library/architecture/uml/elements/[eid] — one UML element: its name, kind and
  owner, and its features as forms (no JSON): properties, operations with their
  parameters, enumeration literals, provided / required interfaces, abstract.
  Shows the diagrams it appears on, its trace links, and deletion.

  Saving sends the whole element (RM replaces it) with the model head the page
  read, so a change someone made meanwhile is refused (412) with a Reload rather
  than overwritten. RM checks the model and lists any problem the change causes.
-->
<script lang="ts">
  import { page } from '$app/state';
  import DiagramViewer from '$lib/components/modeling/DiagramViewer.svelte';
  import TraceLinksPanel from '$lib/components/modeling/TraceLinksPanel.svelte';
  import UmlDeletePanel from '$lib/components/modeling/UmlDeletePanel.svelte';
  import {
    ModelingError,
    UML_ELEMENT_KINDS,
    getModel,
    getUml,
    listDiagramObjects,
    listUml,
    updateUml,
    type ArchitectureModel,
    type UmlAttributes,
    type UmlDiagram,
    type UmlElement,
    type UmlOperation,
    type UmlProperty,
    type ValidationFinding,
  } from '$lib/api/modeling';
  import { DEFAULT_OWNER_KINDS, FEATURES, OWNER_KINDS, UML_KIND_LABEL, newLocalId } from '$lib/modeling/uml';

  const eid = $derived(decodeURIComponent(page.params.eid ?? ''));

  let element = $state<UmlElement | null>(null);
  let model = $state<ArchitectureModel | null>(null);
  let siblings = $state<UmlElement[]>([]);
  let shownOn = $state<UmlDiagram[]>([]);
  let loadError = $state<string | null>(null);
  let notFound = $state(false);

  // Form state (a copy of the element).
  let name = $state('');
  let kind = $state('class');
  let ownerId = $state('');
  let isAbstract = $state(false);
  let properties = $state<UmlProperty[]>([]);
  let operations = $state<UmlOperation[]>([]);
  let literals = $state<string[]>([]);
  let provided = $state<string[]>([]);
  let required = $state<string[]>([]);

  function fill(e: UmlElement): void {
    name = e.name;
    kind = e.kind;
    ownerId = e.owner_id ?? '';
    const a = e.attributes ?? {};
    isAbstract = !!a.is_abstract;
    properties = structuredClone(a.properties ?? []);
    operations = structuredClone(a.operations ?? []).map((o) => ({ ...o, parameters: o.parameters ?? [] }));
    literals = [...(a.literals ?? [])];
    provided = [...(a.provided ?? [])];
    required = [...(a.required ?? [])];
  }

  async function load(): Promise<void> {
    loadError = null;
    notFound = false;
    try {
      const e = await getUml<UmlElement>('elements', eid);
      element = e;
      fill(e);
      const [m, els, diagrams] = await Promise.all([
        getModel(e.model_id),
        listUml<UmlElement>('elements', { model_id: e.model_id }),
        listUml<UmlDiagram>('diagrams', { model_id: e.model_id }),
      ]);
      model = m;
      siblings = els.filter((x) => x.id !== e.id);
      const showing = await Promise.all(diagrams.map(async (d) => ((await listDiagramObjects(d.id)).some((o) => o.element_ref === e.id) ? d : null)));
      shownOn = showing.filter((d): d is UmlDiagram => d !== null);
    } catch (err) {
      if (err instanceof ModelingError && err.status === 404) notFound = true;
      else loadError = err instanceof Error ? err.message : String(err);
    }
  }
  $effect(() => {
    void eid;
    load();
  });

  const features = $derived(FEATURES[kind] ?? FEATURES.class!);
  const ownerKinds = $derived(OWNER_KINDS[kind] ?? DEFAULT_OWNER_KINDS);
  const owners = $derived(siblings.filter((s) => ownerKinds.includes(s.kind)));
  const typeChoices = $derived(siblings.filter((s) => ['class', 'interface', 'data_type', 'enumeration', 'primitive_type', 'component'].includes(s.kind)).concat(element ? [element] : []));
  const interfaces = $derived(siblings.filter((s) => s.kind === 'interface'));
  const modelHref = $derived(element ? `/library/architecture/models/${encodeURIComponent(element.model_id)}` : '/library/architecture/models');

  // --- Save ----------------------------------------------------------------------
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let stale = $state(false);
  let findings = $state<ValidationFinding[]>([]);
  let saved = $state(false);

  async function save(e: Event): Promise<void> {
    e.preventDefault();
    if (!element || !name.trim()) {
      saveError = 'Give the element a name.';
      return;
    }
    saving = true;
    saveError = null;
    stale = false;
    findings = [];
    saved = false;
    const attributes: UmlAttributes = {};
    if (features.properties) attributes.properties = properties;
    if (features.operations) attributes.operations = operations;
    if (features.literals) attributes.literals = literals.filter((l) => l.trim());
    if (features.interfaces) {
      attributes.provided = provided;
      attributes.required = required;
    }
    if (features.abstract) attributes.is_abstract = isAbstract;
    try {
      element = await updateUml<UmlElement>('elements', element.id, { kind, name: name.trim(), owner_id: ownerId || null, attributes }, model?.head);
      fill(element);
      model = await getModel(element.model_id);
      saved = true;
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
      if (err instanceof ModelingError) {
        stale = err.code === 'stale_head';
        findings = err.findings ?? [];
      }
    } finally {
      saving = false;
    }
  }

  const field = 'rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]';
  const small = 'text-xs font-medium text-[var(--color-link)] underline';
  const card = 'flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4';
</script>

<div class="flex flex-col gap-4 px-6 py-4" data-testid="uml-element-page">
  <a href={modelHref} class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">← {model?.title ?? 'Model'}</a>
  {#if notFound}
    <p class="text-sm text-[var(--color-text)]" data-testid="uml-not-found">This element does not exist, or you do not have access to it. It may have been deleted.</p>
  {:else if loadError}
    <div class="flex flex-wrap items-center gap-2"><p class="text-sm text-[var(--color-danger)]">The element could not be loaded: {loadError}</p><button type="button" class={small} onclick={load}>Try again</button></div>
  {:else if !element}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the element…</p>
  {:else}
    <header>
      <h1 class="text-2xl font-semibold text-[var(--color-text)]" data-testid="uml-element-title">{element.name || '(no name)'}</h1>
      <p class="text-sm text-[var(--color-text-muted)]">{UML_KIND_LABEL[element.kind] ?? element.kind} in {model?.title ?? 'a UML model'}</p>
    </header>

    <form class={card} onsubmit={save} data-testid="uml-element-edit">
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name<input class={field} bind:value={name} maxlength="300" data-testid="uml-element-edit-name" /></label>
        <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Kind
          <select class={field} bind:value={kind} data-testid="uml-element-edit-kind">{#each UML_ELEMENT_KINDS as k (k)}<option value={k}>{UML_KIND_LABEL[k]}</option>{/each}</select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Owned by
          <select class={field} bind:value={ownerId}><option value="">Nothing (top level)</option>{#each owners as o (o.id)}<option value={o.id}>{o.name}</option>{/each}</select>
        </label>
        {#if features.abstract}<label class="flex items-center gap-2 text-sm text-[var(--color-text)]"><input type="checkbox" bind:checked={isAbstract} /> Abstract</label>{/if}
      </div>

      {#if features.properties}
        <fieldset class="flex flex-col gap-2" data-testid="uml-properties">
          <legend class="text-sm font-semibold text-[var(--color-text)]">Properties</legend>
          {#each properties as p, i (p.id)}
            <div class="flex flex-wrap items-end gap-2" data-testid="uml-property-row">
              <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name<input class={field} bind:value={p.name} /></label>
              <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Type
                <select class={field} value={p.type_ref ?? ''} onchange={(e) => (p.type_ref = (e.currentTarget as HTMLSelectElement).value || null)}>
                  <option value="">No type</option>{#each typeChoices as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
                </select>
              </label>
              <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">How many<input class="{field} w-20" value={p.multiplicity ?? ''} oninput={(e) => (p.multiplicity = (e.currentTarget as HTMLInputElement).value || null)} placeholder="1, 0..1, *" /></label>
              <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Visibility
                <select class={field} value={p.visibility ?? ''} onchange={(e) => (p.visibility = (e.currentTarget as HTMLSelectElement).value || null)}>
                  <option value="">Not set</option><option value="public">Public</option><option value="private">Private</option><option value="protected">Protected</option><option value="package">Package</option>
                </select>
              </label>
              <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Default<input class="{field} w-24" value={p.default ?? ''} oninput={(e) => (p.default = (e.currentTarget as HTMLInputElement).value || null)} /></label>
              <label class="flex items-center gap-1 text-xs text-[var(--color-text)]"><input type="checkbox" bind:checked={p.is_static} /> Static</label>
              <button type="button" class={small} onclick={() => properties.splice(i, 1)}>Remove</button>
            </div>
          {/each}
          <button type="button" class="{small} self-start" onclick={() => properties.push({ id: newLocalId('p'), name: '', type_ref: null, multiplicity: null, visibility: null, is_static: false, default: null })} data-testid="uml-property-add">Add a property</button>
        </fieldset>
      {/if}

      {#if features.operations}
        <fieldset class="flex flex-col gap-2" data-testid="uml-operations">
          <legend class="text-sm font-semibold text-[var(--color-text)]">Operations</legend>
          {#each operations as o, i (o.id)}
            <div class="flex flex-col gap-2 rounded-md border border-[var(--color-border)] p-2" data-testid="uml-operation-row">
              <div class="flex flex-wrap items-end gap-2">
                <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name<input class={field} bind:value={o.name} /></label>
                <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Returns
                  <select class={field} value={o.return_type_ref ?? ''} onchange={(e) => (o.return_type_ref = (e.currentTarget as HTMLSelectElement).value || null)}>
                    <option value="">Nothing</option>{#each typeChoices as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
                  </select>
                </label>
                <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Visibility
                  <select class={field} value={o.visibility ?? ''} onchange={(e) => (o.visibility = (e.currentTarget as HTMLSelectElement).value || null)}>
                    <option value="">Not set</option><option value="public">Public</option><option value="private">Private</option><option value="protected">Protected</option><option value="package">Package</option>
                  </select>
                </label>
                <label class="flex items-center gap-1 text-xs text-[var(--color-text)]"><input type="checkbox" bind:checked={o.is_abstract} /> Abstract</label>
                <label class="flex items-center gap-1 text-xs text-[var(--color-text)]"><input type="checkbox" bind:checked={o.is_static} /> Static</label>
                <button type="button" class={small} onclick={() => operations.splice(i, 1)}>Remove</button>
              </div>
              <div class="flex flex-col gap-1 pl-4">
                <span class="text-xs text-[var(--color-text-muted)]">Parameters</span>
                {#each o.parameters ?? [] as prm, j (prm.id)}
                  <div class="flex flex-wrap items-end gap-2" data-testid="uml-parameter-row">
                    <input class={field} bind:value={prm.name} placeholder="name" aria-label="Parameter name" />
                    <select class={field} value={prm.type_ref ?? ''} aria-label="Parameter type" onchange={(e) => (prm.type_ref = (e.currentTarget as HTMLSelectElement).value || null)}>
                      <option value="">No type</option>{#each typeChoices as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
                    </select>
                    <select class={field} value={prm.direction ?? 'in'} aria-label="Direction" onchange={(e) => (prm.direction = (e.currentTarget as HTMLSelectElement).value)}>
                      <option value="in">in</option><option value="out">out</option><option value="inout">in and out</option><option value="return">return</option>
                    </select>
                    <button type="button" class={small} onclick={() => o.parameters!.splice(j, 1)}>Remove</button>
                  </div>
                {/each}
                <button type="button" class="{small} self-start" onclick={() => (o.parameters = [...(o.parameters ?? []), { id: newLocalId('prm'), name: '', type_ref: null, direction: 'in', multiplicity: null }])} data-testid="uml-parameter-add">Add a parameter</button>
              </div>
            </div>
          {/each}
          <button type="button" class="{small} self-start" onclick={() => operations.push({ id: newLocalId('op'), name: '', visibility: null, is_abstract: false, is_static: false, parameters: [], return_type_ref: null })} data-testid="uml-operation-add">Add an operation</button>
        </fieldset>
      {/if}

      {#if features.literals}
        <fieldset class="flex flex-col gap-2" data-testid="uml-literals">
          <legend class="text-sm font-semibold text-[var(--color-text)]">Values</legend>
          {#each literals as _l, i (i)}
            <div class="flex items-center gap-2"><input class={field} bind:value={literals[i]} aria-label="Value" /><button type="button" class={small} onclick={() => literals.splice(i, 1)}>Remove</button></div>
          {/each}
          <button type="button" class="{small} self-start" onclick={() => literals.push('')}>Add a value</button>
        </fieldset>
      {/if}

      {#if features.interfaces}
        <div class="flex flex-wrap gap-6" data-testid="uml-interfaces">
          {#each [['Provides', provided], ['Requires', required]] as [label, list] (label)}
            <fieldset class="flex flex-col gap-1">
              <legend class="text-sm font-semibold text-[var(--color-text)]">{label}</legend>
              {#if interfaces.length === 0}<span class="text-xs text-[var(--color-text-muted)]">Add an interface to the model first.</span>{/if}
              {#each interfaces as itf (itf.id)}
                <label class="flex items-center gap-2 text-sm text-[var(--color-text)]">
                  <input
                    type="checkbox"
                    checked={(list as string[]).includes(itf.id)}
                    onchange={(e) => {
                      const arr = label === 'Provides' ? provided : required;
                      const on = (e.currentTarget as HTMLInputElement).checked;
                      const next = on ? [...arr, itf.id] : arr.filter((x) => x !== itf.id);
                      if (label === 'Provides') provided = next;
                      else required = next;
                    }}
                  />
                  {itf.name}
                </label>
              {/each}
            </fieldset>
          {/each}
        </div>
      {/if}

      {#if saveError}
        <div class="flex flex-col gap-1" data-testid="uml-element-save-error">
          <p class="text-sm text-[var(--color-danger)]">{saveError}</p>
          {#each findings as f, i (i)}<p class="text-sm text-[var(--color-danger)]" title={`Rule ${f.rule_id}`}>• {f.message}</p>{/each}
          {#if stale}<button type="button" class="{small} self-start" onclick={load}>Reload the latest version</button>{/if}
        </div>
      {/if}
      {#if saved}<p class="text-sm text-[var(--color-success-text)]" data-testid="uml-element-saved">Saved.</p>{/if}
      <button type="submit" class="self-start rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50" disabled={saving} data-testid="uml-element-save">{saving ? 'Saving…' : 'Save'}</button>
    </form>

    <section class={card} data-testid="uml-element-diagrams">
      <h2 class="text-base font-semibold text-[var(--color-text)]">Shown on {shownOn.length === 1 ? '1 diagram' : `${shownOn.length} diagrams`}</h2>
      {#if shownOn.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No diagram shows this element yet. Open a diagram to add it.</p>
      {:else}
        <ul class="flex flex-wrap gap-3">{#each shownOn as d (d.id)}<li><a class="text-sm text-[var(--color-link)] hover:underline" href={`/library/architecture/uml/diagrams/${encodeURIComponent(d.id)}`}>{d.name}</a></li>{/each}</ul>
        {#key shownOn[0]!.id}<DiagramViewer umlDiagramId={shownOn[0]!.id} title={shownOn[0]!.name} />{/key}
      {/if}
    </section>

    {#key element.id}<TraceLinksPanel kind="uml_element" itemId={element.id} />{/key}
    <UmlDeletePanel resource="elements" itemId={element.id} name={element.name} noun="element" backHref={modelHref} head={model?.head} />
  {/if}
</div>
