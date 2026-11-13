<!--
  /library/architecture/uml/interactions/[iid] — one interaction (a sequence).
  Edited as forms, no JSON: the participants (lifelines, each optionally
  standing for an element of the model) and the messages in time order (who
  sends what to whom; move a message up or down to change the order).

  The sequence is SHOWN as a rendered sequence diagram: the model's sequence
  diagrams that show this interaction's participants are drawn here, and if
  there is none, "Draw it" creates one (a shape per participant, a line per
  message). Activations and fragments stored on the interaction are kept as
  they are; the page says how many.
-->
<script lang="ts">
  import { page } from '$app/state';
  import DiagramViewer from '$lib/components/modeling/DiagramViewer.svelte';
  import TraceLinksPanel from '$lib/components/modeling/TraceLinksPanel.svelte';
  import UmlDeletePanel from '$lib/components/modeling/UmlDeletePanel.svelte';
  import {
    ModelingError,
    UML_MESSAGE_KINDS,
    addDiagramConnection,
    addDiagramObject,
    createUml,
    getModel,
    getUml,
    newIntentKey,
    listDiagramObjects,
    listUml,
    updateUml,
    type ArchitectureModel,
    type UmlDiagram,
    type UmlElement,
    type UmlInteraction,
    type UmlLifeline,
    type ValidationFinding,
  } from '$lib/api/modeling';
  import { UML_KIND_LABEL, documentFromRows, messageRows, newLocalId, type MessageRow } from '$lib/modeling/uml';
  import { plural } from '$lib/modeling/explain';

  const iid = $derived(decodeURIComponent(page.params.iid ?? ''));

  let doc = $state<UmlInteraction | null>(null);
  let model = $state<ArchitectureModel | null>(null);
  let elements = $state<UmlElement[]>([]);
  let sequenceDiagrams = $state<UmlDiagram[]>([]);
  let loadError = $state<string | null>(null);
  let notFound = $state(false);

  let name = $state('');
  let lifelines = $state<UmlLifeline[]>([]);
  let rows = $state<MessageRow[]>([]);

  function fill(d: UmlInteraction): void {
    name = d.name;
    lifelines = structuredClone(d.lifelines);
    rows = messageRows(d);
  }

  async function findDiagrams(d: UmlInteraction): Promise<void> {
    const lifelineIds = new Set(d.lifelines.map((l) => l.id));
    const diagrams = (await listUml<UmlDiagram>('diagrams', { model_id: d.model_id, kind: 'sequence' })).filter((x) => x.kind === 'sequence');
    const showing = await Promise.all(diagrams.map(async (x) => ((await listDiagramObjects(x.id)).some((o) => o.lifeline_id && lifelineIds.has(o.lifeline_id)) ? x : null)));
    sequenceDiagrams = showing.filter((x): x is UmlDiagram => x !== null);
  }

  async function load(): Promise<void> {
    loadError = null;
    notFound = false;
    try {
      const d = await getUml<UmlInteraction>('interactions', iid);
      doc = d;
      fill(d);
      [model, elements] = await Promise.all([getModel(d.model_id), listUml<UmlElement>('elements', { model_id: d.model_id })]);
      await findDiagrams(d);
    } catch (err) {
      if (err instanceof ModelingError && err.status === 404) notFound = true;
      else loadError = err instanceof Error ? err.message : String(err);
    }
  }
  $effect(() => {
    void iid;
    load();
  });

  const modelHref = $derived(doc ? `/library/architecture/models/${encodeURIComponent(doc.model_id)}` : '/library/architecture/models');
  const kept = $derived(doc ? documentFromRows(doc, rows).kept : 0);
  const lifelineName = (id: string) => lifelines.find((l) => l.id === id)?.name || 'a participant';

  function addMessage(): void {
    const from = lifelines[0]?.id ?? '';
    const to = lifelines[1]?.id ?? from;
    const id = newLocalId('msg');
    rows.push({ id, kind: 'synch_call', name: '', from, to, operation_ref: null, arguments: [], send: `${id}-send`, receive: `${id}-receive` });
  }
  function move(i: number, by: number): void {
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    const [r] = rows.splice(i, 1);
    rows.splice(j, 0, r!);
  }

  // --- Save ----------------------------------------------------------------------
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let findings = $state<ValidationFinding[]>([]);
  let stale = $state(false);
  let saved = $state(false);

  async function save(e: Event): Promise<void> {
    e.preventDefault();
    if (!doc) return;
    if (rows.some((r) => !r.from || !r.to)) {
      saveError = 'Every message needs a sender and a receiver.';
      return;
    }
    saving = true;
    saveError = null;
    findings = [];
    stale = false;
    saved = false;
    const { occurrences, messages } = documentFromRows(doc, rows);
    try {
      doc = await updateUml<UmlInteraction>(
        'interactions',
        doc.id,
        { name: name.trim(), owner_id: doc.owner_id, lifelines, occurrences, messages, executions: doc.executions, fragments: doc.fragments },
        model?.head,
      );
      fill(doc);
      model = await getModel(doc.model_id);
      saved = true;
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err);
      if (err instanceof ModelingError) {
        findings = err.findings ?? [];
        stale = err.code === 'stale_head';
      }
    } finally {
      saving = false;
    }
  }

  // --- Draw it as a sequence diagram ------------------------------------------
  let drawing = $state(false);
  let drawError = $state<string | null>(null);
  // One "Draw it" = one key; its shapes and lines derive theirs, so a retry after a failure re-sends the same requests.
  let drawKey = newIntentKey();
  async function draw(): Promise<void> {
    if (!doc) return;
    drawing = true;
    drawError = null;
    try {
      const d = await createUml<UmlDiagram>('diagrams', { model_id: doc.model_id, kind: 'sequence', name: `${doc.name} (sequence)` }, drawKey);
      const objectOf = new Map<string, string>();
      for (const [i, l] of doc.lifelines.entries()) {
        const o = await addDiagramObject(d.id, { lifeline_id: l.id, bounds: { x: 40 + i * 180, y: 20, w: 140, h: 400 } }, `${drawKey}:o:${l.id}`);
        objectOf.set(l.id, o.id);
      }
      const lifelineOf = new Map(doc.occurrences.map((o) => [o.id, o.lifeline]));
      for (const m of doc.messages) {
        const from = objectOf.get(lifelineOf.get(m.send_occurrence) ?? '');
        const to = objectOf.get(lifelineOf.get(m.receive_occurrence) ?? '');
        if (from && to) await addDiagramConnection(d.id, { message_id: m.id, source_object_id: from, target_object_id: to }, `${drawKey}:c:${m.id}`);
      }
      await findDiagrams(doc);
      drawKey = newIntentKey();
    } catch (err) {
      drawError = err instanceof Error ? err.message : String(err);
    } finally {
      drawing = false;
    }
  }

  const field = 'rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]';
  const small = 'text-xs font-medium text-[var(--color-link)] underline disabled:opacity-40';
  const card = 'flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4';
</script>

<div class="flex flex-col gap-4 px-6 py-4" data-testid="uml-interaction-page">
  <a href={modelHref} class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">← {model?.title ?? 'Model'}</a>
  {#if notFound}
    <p class="text-sm text-[var(--color-text)]" data-testid="uml-not-found">This interaction does not exist, or you do not have access to it.</p>
  {:else if loadError}
    <div class="flex flex-wrap items-center gap-2"><p class="text-sm text-[var(--color-danger)]">The interaction could not be loaded: {loadError}</p><button type="button" class={small} onclick={load}>Try again</button></div>
  {:else if !doc}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the interaction…</p>
  {:else}
    <header>
      <h1 class="text-2xl font-semibold text-[var(--color-text)]">{doc.name || '(no name)'}</h1>
      <p class="text-sm text-[var(--color-text-muted)]">Interaction (a sequence) in {model?.title ?? 'a UML model'}</p>
    </header>

    <section class={card} data-testid="uml-interaction-diagrams">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">As a sequence diagram</h2>
        {#if sequenceDiagrams.length === 0}
          <button type="button" class="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-sm font-medium text-[var(--color-text)] disabled:opacity-50" disabled={drawing || doc.lifelines.length === 0} onclick={draw} data-testid="uml-interaction-draw">{drawing ? 'Drawing…' : 'Draw it'}</button>
        {/if}
      </div>
      {#if drawError}<p class="text-sm text-[var(--color-danger)]">{drawError}</p>{/if}
      {#if sequenceDiagrams.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">{doc.lifelines.length === 0 ? 'Add participants and messages, save, then draw the sequence.' : 'No sequence diagram shows this interaction yet.'}</p>
      {:else}
        {#each sequenceDiagrams as d (d.id)}
          <DiagramViewer umlDiagramId={d.id} title={d.name} />
          <a class={small} href={`/library/architecture/uml/diagrams/${encodeURIComponent(d.id)}`}>Open the diagram</a>
        {/each}
      {/if}
    </section>

    <form class={card} onsubmit={save} data-testid="uml-interaction-edit">
      <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name<input class="{field} max-w-md" bind:value={name} maxlength="300" /></label>

      <fieldset class="flex flex-col gap-2" data-testid="uml-lifelines">
        <legend class="text-sm font-semibold text-[var(--color-text)]">Participants</legend>
        {#each lifelines as l, i (l.id)}
          <div class="flex flex-wrap items-end gap-2" data-testid="uml-lifeline-row">
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name<input class={field} bind:value={l.name} /></label>
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Stands for
              <select class={field} value={l.represents_ref ?? ''} onchange={(e) => (l.represents_ref = (e.currentTarget as HTMLSelectElement).value || null)}>
                <option value="">Nothing in the model</option>
                {#each elements.filter((x) => ['class', 'component', 'interface', 'actor'].includes(x.kind)) as el (el.id)}<option value={el.id}>{el.name} ({UML_KIND_LABEL[el.kind]})</option>{/each}
              </select>
            </label>
            <button type="button" class={small} disabled={rows.some((r) => r.from === l.id || r.to === l.id)} title="Remove its messages first" onclick={() => lifelines.splice(i, 1)}>Remove</button>
          </div>
        {/each}
        <button type="button" class="{small} self-start" onclick={() => lifelines.push({ id: newLocalId('ll'), name: '', represents_ref: null })} data-testid="uml-lifeline-add">Add a participant</button>
      </fieldset>

      <fieldset class="flex flex-col gap-2" data-testid="uml-messages">
        <legend class="text-sm font-semibold text-[var(--color-text)]">Messages, in order</legend>
        {#each rows as r, i (r.id)}
          <div class="flex flex-wrap items-end gap-2" data-testid="uml-message-row">
            <span class="w-6 text-right text-xs text-[var(--color-text-muted)]">{i + 1}.</span>
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">From
              <select class={field} bind:value={r.from}>{#each lifelines as l (l.id)}<option value={l.id}>{l.name || 'unnamed'}</option>{/each}</select>
            </label>
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">To
              <select class={field} bind:value={r.to}>{#each lifelines as l (l.id)}<option value={l.id}>{l.name || 'unnamed'}</option>{/each}</select>
            </label>
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Kind
              <select class={field} bind:value={r.kind}>{#each UML_MESSAGE_KINDS as k (k)}<option value={k}>{UML_KIND_LABEL[k]}</option>{/each}</select>
            </label>
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Message<input class={field} bind:value={r.name} placeholder="e.g. pay(amount)" /></label>
            <span class="flex gap-2">
              <button type="button" class={small} disabled={i === 0} onclick={() => move(i, -1)} aria-label="Earlier">Earlier</button>
              <button type="button" class={small} disabled={i === rows.length - 1} onclick={() => move(i, 1)} aria-label="Later">Later</button>
              <button type="button" class={small} onclick={() => rows.splice(i, 1)}>Remove</button>
            </span>
          </div>
        {/each}
        <button type="button" class="{small} self-start" disabled={lifelines.length === 0} onclick={addMessage} data-testid="uml-message-add">Add a message</button>
        {#if rows.length > 0}
          <p class="text-xs text-[var(--color-text-muted)]">Reads as: {rows.map((r) => `${lifelineName(r.from)} → ${lifelineName(r.to)}${r.name ? ` "${r.name}"` : ''}`).join(', then ')}.</p>
        {/if}
      </fieldset>
      {#if doc.executions.length > 0 || doc.fragments.length > 0 || kept > 0}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="uml-interaction-kept">
          {plural(doc.executions.length, 'activation')}, {plural(doc.fragments.length, 'fragment')} (alternatives, loops) and {kept === 1 ? '1 other point' : `${kept} other points`} in time are kept as they are; this page does not edit them. Check the diagram after saving.
        </p>
      {/if}

      {#if saveError}
        <div class="flex flex-col gap-1" data-testid="uml-interaction-save-error">
          <p class="text-sm text-[var(--color-danger)]">{saveError}</p>
          {#each findings as f, i (i)}<p class="text-sm text-[var(--color-danger)]" title={`Rule ${f.rule_id}`}>• {f.message}</p>{/each}
          {#if stale}<button type="button" class="{small} self-start" onclick={load}>Reload the latest version</button>{/if}
        </div>
      {/if}
      {#if saved}<p class="text-sm text-[var(--color-success-text)]" data-testid="uml-interaction-saved">Saved.</p>{/if}
      <button type="submit" class="self-start rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50" disabled={saving} data-testid="uml-interaction-save">{saving ? 'Saving…' : 'Save'}</button>
    </form>

    {#key doc.id}<TraceLinksPanel kind="interaction" itemId={doc.id} />{/key}
    <UmlDeletePanel resource="interactions" itemId={doc.id} name={doc.name} noun="interaction" backHref={modelHref} head={model?.head} />
  {/if}
</div>
