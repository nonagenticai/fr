<!--
  /library/architecture/uml/diagrams/[did] — one UML diagram: the picture as
  requirements_management draws it (sandboxed; PNG download), its name and
  notes, and what it shows: shapes (elements on a class or component diagram,
  participants on a sequence diagram) and lines (relationships, or messages).
  Adding a line picks the shapes at both ends automatically. Trace links and
  deletion below.
-->
<script lang="ts">
  import { page } from '$app/state';
  import DiagramViewer from '$lib/components/modeling/DiagramViewer.svelte';
  import TraceLinksPanel from '$lib/components/modeling/TraceLinksPanel.svelte';
  import UmlDeletePanel from '$lib/components/modeling/UmlDeletePanel.svelte';
  import {
    ModelingError,
    addDiagramConnection,
    addDiagramObject,
    getModel,
    getUml,
    listDiagramConnections,
    listDiagramObjects,
    listUml,
    newIntentKey,
    removeDiagramConnection,
    removeDiagramObject,
    updateUml,
    type ArchitectureModel,
    type UmlDiagram,
    type UmlDiagramConnection,
    type UmlDiagramObject,
    type UmlElement,
    type UmlInteraction,
    type UmlRelationship,
  } from '$lib/api/modeling';
  import { UML_KIND_LABEL, umlRelationshipLabel } from '$lib/modeling/uml';

  const did = $derived(decodeURIComponent(page.params.did ?? ''));

  let diagram = $state<UmlDiagram | null>(null);
  let model = $state<ArchitectureModel | null>(null);
  let objects = $state<UmlDiagramObject[]>([]);
  let connections = $state<UmlDiagramConnection[]>([]);
  let elements = $state<UmlElement[]>([]);
  let relationships = $state<UmlRelationship[]>([]);
  let interactions = $state<UmlInteraction[]>([]);
  let loadError = $state<string | null>(null);
  let notFound = $state(false);
  let pictureKey = $state(0);

  async function loadOccurrences(): Promise<void> {
    [objects, connections] = await Promise.all([listDiagramObjects(did), listDiagramConnections(did)]);
    pictureKey += 1;
  }

  async function load(): Promise<void> {
    loadError = null;
    notFound = false;
    try {
      const d = await getUml<UmlDiagram>('diagrams', did);
      diagram = d;
      name = d.name;
      documentation = d.documentation ?? '';
      const f = { model_id: d.model_id };
      [model, elements, relationships, interactions] = await Promise.all([
        getModel(d.model_id),
        listUml<UmlElement>('elements', f),
        listUml<UmlRelationship>('relationships', f),
        listUml<UmlInteraction>('interactions', f),
      ]);
      await loadOccurrences();
    } catch (err) {
      if (err instanceof ModelingError && err.status === 404) notFound = true;
      else loadError = err instanceof Error ? err.message : String(err);
    }
  }
  $effect(() => {
    void did;
    load();
  });

  const isSequence = $derived(diagram?.kind === 'sequence');
  const nameOf = $derived(new Map(elements.map((e) => [e.id, e.name])));
  const lifelines = $derived(interactions.flatMap((i) => i.lifelines.map((l) => ({ ...l, interaction: i }))));
  const messages = $derived(
    interactions.flatMap((i) => {
      const lifelineOf = new Map(i.occurrences.map((o) => [o.id, o.lifeline]));
      return i.messages.map((m) => ({ ...m, from: lifelineOf.get(m.send_occurrence) ?? '', to: lifelineOf.get(m.receive_occurrence) ?? '', interaction: i }));
    }),
  );
  const objectLabel = (o: UmlDiagramObject) =>
    o.element_ref ? (nameOf.get(o.element_ref) ?? 'an element') : (lifelines.find((l) => l.id === o.lifeline_id)?.name ?? 'a participant');
  const connectionLabel = (c: UmlDiagramConnection) => {
    if (c.relationship_ref) {
      const r = relationships.find((x) => x.id === c.relationship_ref);
      return r ? umlRelationshipLabel(r, nameOf) : 'a relationship';
    }
    const m = messages.find((x) => x.id === c.message_id);
    return m ? `${m.name || UML_KIND_LABEL[m.kind]}` : 'a message';
  };
  const modelHref = $derived(diagram ? `/library/architecture/models/${encodeURIComponent(diagram.model_id)}` : '/library/architecture/models');

  // Endpoints of a relationship / message, and the shapes showing them.
  function endsOf(choice: string): [string, string] | null {
    if (isSequence) {
      const m = messages.find((x) => x.id === choice);
      return m ? [m.from, m.to] : null;
    }
    const r = relationships.find((x) => x.id === choice);
    if (!r) return null;
    if (r.kind === 'association' && r.ends?.length === 2) return [r.ends[0]!.element_ref, r.ends[1]!.element_ref];
    return r.source && r.target ? [r.source, r.target] : null;
  }
  const shapeFor = (ref: string) => objects.find((o) => (isSequence ? o.lifeline_id === ref : o.element_ref === ref));

  // --- Edit name / notes -------------------------------------------------------
  let name = $state('');
  let documentation = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let saved = $state(false);
  async function save(e: Event): Promise<void> {
    e.preventDefault();
    if (!diagram) return;
    saving = true;
    saveError = null;
    saved = false;
    try {
      diagram = await updateUml<UmlDiagram>('diagrams', diagram.id, { kind: diagram.kind, name: name.trim(), documentation: documentation.trim() || null }, model?.head);
      model = await getModel(diagram.model_id);
      saved = true;
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  // --- Shapes and lines --------------------------------------------------------
  let addShape = $state('');
  let addLine = $state('');
  // One key per thing being added: kept across a retry, renewed once it is added.
  let shapeKey = newIntentKey();
  let lineKey = newIntentKey();
  let occError = $state<string | null>(null);
  let busy = $state(false);

  async function run(fn: () => Promise<unknown>): Promise<void> {
    busy = true;
    occError = null;
    try {
      await fn();
      await loadOccurrences();
      model = diagram ? await getModel(diagram.model_id) : model;
    } catch (err) {
      occError = err instanceof Error ? err.message : String(err);
      if (err instanceof ModelingError && err.findings?.length) occError += ` ${err.findings.map((f) => f.message).join('; ')}`;
    } finally {
      busy = false;
    }
  }

  function addTheShape(): void {
    if (!addShape) return;
    const x = 40 + (objects.length % 4) * 180;
    const y = 40 + Math.floor(objects.length / 4) * 140;
    const body = isSequence ? { lifeline_id: addShape, bounds: { x, y: 20, w: 140, h: 400 } } : { element_ref: addShape, bounds: { x, y, w: 140, h: 80 } };
    run(() => addDiagramObject(did, body, shapeKey)).then(() => {
      if (!occError) {
        addShape = '';
        shapeKey = newIntentKey();
      }
    });
  }
  function addTheLine(): void {
    const ends = endsOf(addLine);
    const a = ends ? shapeFor(ends[0]) : undefined;
    const b = ends ? shapeFor(ends[1]) : undefined;
    if (!a || !b) {
      occError = `Add shapes for both ${isSequence ? 'participants' : 'elements'} first.`;
      return;
    }
    run(() => addDiagramConnection(did, { ...(isSequence ? { message_id: addLine } : { relationship_ref: addLine }), source_object_id: a.id, target_object_id: b.id }, lineKey)).then(() => {
      if (!occError) {
        addLine = '';
        lineKey = newIntentKey();
      }
    });
  }

  const shapeChoices = $derived(
    isSequence
      ? lifelines.filter((l) => !objects.some((o) => o.lifeline_id === l.id)).map((l) => ({ id: l.id, label: `${l.name || 'unnamed'} (${l.interaction.name})` }))
      : elements
          .filter((e) => !objects.some((o) => o.element_ref === e.id) && (diagram?.kind === 'component' ? ['component', 'interface', 'port', 'package'].includes(e.kind) : e.kind !== 'port'))
          .map((e) => ({ id: e.id, label: `${e.name} (${UML_KIND_LABEL[e.kind]})` })),
  );
  const lineChoices = $derived(
    isSequence
      ? messages.filter((m) => !connections.some((c) => c.message_id === m.id)).map((m) => ({ id: m.id, label: m.name || UML_KIND_LABEL[m.kind] || m.kind }))
      : relationships.filter((r) => !connections.some((c) => c.relationship_ref === r.id)).map((r) => ({ id: r.id, label: umlRelationshipLabel(r, nameOf) })),
  );

  const field = 'rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]';
  const small = 'text-xs font-medium text-[var(--color-link)] underline disabled:opacity-40';
  const card = 'flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4';
</script>

<div class="flex flex-col gap-4 px-6 py-4" data-testid="uml-diagram-page">
  <a href={modelHref} class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">← {model?.title ?? 'Model'}</a>
  {#if notFound}
    <p class="text-sm text-[var(--color-text)]" data-testid="uml-not-found">This diagram does not exist, or you do not have access to it.</p>
  {:else if loadError}
    <div class="flex flex-wrap items-center gap-2"><p class="text-sm text-[var(--color-danger)]">The diagram could not be loaded: {loadError}</p><button type="button" class={small} onclick={load}>Try again</button></div>
  {:else if !diagram}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the diagram…</p>
  {:else}
    <header>
      <h1 class="text-2xl font-semibold text-[var(--color-text)]" data-testid="uml-diagram-title">{diagram.name || '(no name)'}</h1>
      <p class="text-sm text-[var(--color-text-muted)]">{UML_KIND_LABEL[`${diagram.kind}_diagram`] ?? diagram.kind} in {model?.title ?? 'a UML model'}</p>
    </header>

    {#key `${diagram.id}:${pictureKey}`}<DiagramViewer umlDiagramId={diagram.id} title={diagram.name || 'Diagram'} />{/key}

    <section class={card} data-testid="uml-diagram-contents">
      <h2 class="text-base font-semibold text-[var(--color-text)]">What it shows</h2>
      <div class="grid gap-4 md:grid-cols-2">
        <div class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold text-[var(--color-text)]">{isSequence ? 'Participants' : 'Elements'} ({objects.length})</h3>
          <ul class="flex flex-col gap-1">
            {#each objects as o (o.id)}
              <li class="flex items-center justify-between gap-2 text-sm text-[var(--color-text)]" data-testid="uml-diagram-object">
                <span>{objectLabel(o)}</span>
                <button type="button" class={small} disabled={busy} onclick={() => run(() => removeDiagramObject(did, o.id))}>Remove from diagram</button>
              </li>
            {/each}
          </ul>
          <div class="flex flex-wrap items-end gap-2">
            <select class={field} bind:value={addShape} aria-label="Add to the diagram" data-testid="uml-diagram-add-shape">
              <option value="">{shapeChoices.length ? 'Choose one to add…' : 'Everything is already shown'}</option>
              {#each shapeChoices as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
            </select>
            <button type="button" class="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-sm font-medium text-[var(--color-text)] disabled:opacity-50" disabled={!addShape || busy} onclick={addTheShape} data-testid="uml-diagram-add-shape-button">Add</button>
          </div>
        </div>
        <div class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold text-[var(--color-text)]">{isSequence ? 'Messages' : 'Relationships'} ({connections.length})</h3>
          <ul class="flex flex-col gap-1">
            {#each connections as c (c.id)}
              <li class="flex items-center justify-between gap-2 text-sm text-[var(--color-text)]" data-testid="uml-diagram-connection">
                <span>{connectionLabel(c)}</span>
                <button type="button" class={small} disabled={busy} onclick={() => run(() => removeDiagramConnection(did, c.id))}>Remove from diagram</button>
              </li>
            {/each}
          </ul>
          <div class="flex flex-wrap items-end gap-2">
            <select class={field} bind:value={addLine} aria-label="Add a line" data-testid="uml-diagram-add-line">
              <option value="">{lineChoices.length ? 'Choose one to add…' : 'Nothing left to add'}</option>
              {#each lineChoices as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
            </select>
            <button type="button" class="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-sm font-medium text-[var(--color-text)] disabled:opacity-50" disabled={!addLine || busy} onclick={addTheLine}>Add</button>
          </div>
        </div>
      </div>
      {#if occError}<p class="text-sm text-[var(--color-danger)]" data-testid="uml-diagram-error">{occError}</p>{/if}
    </section>

    <form class={card} onsubmit={save} data-testid="uml-diagram-edit">
      <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name<input class="{field} max-w-md" bind:value={name} maxlength="300" /></label>
      <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Notes<textarea class={field} rows="3" bind:value={documentation}></textarea></label>
      {#if saveError}<p class="text-sm text-[var(--color-danger)]">{saveError}</p>{/if}
      {#if saved}<p class="text-sm text-[var(--color-success-text)]">Saved.</p>{/if}
      <button type="submit" class="self-start rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </form>

    {#key diagram.id}<TraceLinksPanel kind="diagram" itemId={diagram.id} />{/key}
    <UmlDeletePanel resource="diagrams" itemId={diagram.id} name={diagram.name} noun="diagram" backHref={modelHref} head={model?.head} />
  {/if}
</div>
