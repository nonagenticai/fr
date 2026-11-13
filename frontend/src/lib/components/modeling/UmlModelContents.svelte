<!--
  UmlModelContents — what a UML model holds, on its model page: elements,
  relationships, interactions (sequences) and diagrams, each listed with a way
  to add one. Every row opens its own page (edit, delete, diagrams, trace links).

  requirements_management checks every change against the whole model and
  refuses one that would break it (422 `model_integrity`, with the problems):
  the problems are listed under the form, in the words RM gives.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    ModelingError,
    UML_DIAGRAM_KINDS,
    UML_ELEMENT_KINDS,
    UML_RELATIONSHIP_KINDS,
    createUml,
    newIntentKey,
    listUml,
    type UmlDiagram,
    type UmlElement,
    type UmlInteraction,
    type UmlRelationship,
    type ValidationFinding,
  } from '$lib/api/modeling';
  import { UML_KIND_LABEL, umlRelationshipLabel } from '$lib/modeling/uml';
  import { plural } from '$lib/modeling/explain';

  let { modelId, projectId, onChange }: { modelId: string; projectId: string | null; onChange?: () => void } = $props();

  let elements = $state<UmlElement[]>([]);
  let relationships = $state<UmlRelationship[]>([]);
  let interactions = $state<UmlInteraction[]>([]);
  let diagrams = $state<UmlDiagram[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const f = { model_id: modelId };
      [elements, relationships, interactions, diagrams] = await Promise.all([
        listUml<UmlElement>('elements', f),
        listUml<UmlRelationship>('relationships', f),
        listUml<UmlInteraction>('interactions', f),
        listUml<UmlDiagram>('diagrams', f),
      ]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void modelId;
    load();
  });

  const nameOf = $derived(new Map(elements.map((e) => [e.id, e.name || UML_KIND_LABEL[e.kind] || e.kind])));

  // --- Add forms ---------------------------------------------------------------
  let open = $state<'element' | 'relationship' | 'interaction' | 'diagram' | null>(null);
  let busy = $state(false);
  let formError = $state<string | null>(null);
  let formFindings = $state<ValidationFinding[]>([]);

  let elKind = $state<string>('class');
  let elName = $state('');
  let relKind = $state<string>('association');
  let relName = $state('');
  let relSource = $state('');
  let relTarget = $state('');
  let relConnector = $state<'assembly' | 'delegation'>('assembly');
  let intName = $state('');
  let diaKind = $state<string>('class');
  let diaName = $state('');

  // One key per form the user opened: a retry after a failure reuses it.
  let intentKey = newIntentKey();

  function show(which: typeof open): void {
    open = open === which ? null : which;
    intentKey = newIntentKey();
    formError = null;
    formFindings = [];
  }

  async function submit(e: Event, resource: 'elements' | 'relationships' | 'interactions' | 'diagrams', body: Record<string, unknown>, path: string): Promise<void> {
    e.preventDefault();
    busy = true;
    formError = null;
    formFindings = [];
    try {
      // Exactly RM's create fields: the model names the project (a relationship's body has no project_id at all).
      const row = await createUml<{ id: string }>(resource, { model_id: modelId, ...body }, intentKey);
      onChange?.();
      await goto(`/library/architecture/uml/${path}/${encodeURIComponent(row.id)}`);
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
      if (err instanceof ModelingError && err.findings) formFindings = err.findings;
    } finally {
      busy = false;
    }
  }

  function relationshipBody(): Record<string, unknown> | null {
    if (!relSource || !relTarget) {
      formError = 'Choose both elements.';
      return null;
    }
    const body: Record<string, unknown> = { kind: relKind, name: relName.trim() };
    if (relKind === 'association') {
      body.ends = [
        { element_ref: relSource, aggregation: 'none', navigable: true },
        { element_ref: relTarget, aggregation: 'none', navigable: true },
      ];
    } else {
      body.source = relSource;
      body.target = relTarget;
      if (relKind === 'connector') body.connector_kind = relConnector;
    }
    return body;
  }

  const field = 'rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]';
  const primary = 'rounded-md bg-[var(--color-accent)] px-3 py-1 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50';
  const addBtn = 'rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]';
  const card = 'flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4';
</script>

{#snippet problems()}
  {#if formError}<p class="text-sm text-[var(--color-danger)]" data-testid="uml-form-error">{formError}</p>{/if}
  {#if formFindings.length > 0}
    <ul class="list-disc pl-5 text-sm text-[var(--color-danger)]">{#each formFindings as f, i (i)}<li title={`Rule ${f.rule_id}`}>{f.message}</li>{/each}</ul>
  {/if}
{/snippet}

<div class="flex flex-col gap-4" data-testid="uml-contents">
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the model's contents…</p>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2" data-testid="uml-contents-error">
      <p class="text-sm text-[var(--color-danger)]">The model's contents could not be loaded: {error}</p>
      <button type="button" class="text-sm font-medium text-[var(--color-link)] underline" onclick={load}>Try again</button>
    </div>
  {:else}
    <!-- Elements -->
    <section class={card} data-testid="uml-elements">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Elements ({elements.length})</h2>
        <button type="button" class={addBtn} onclick={() => show('element')} data-testid="uml-add-element">Add an element</button>
      </div>
      {#if open === 'element'}
        <form class="flex flex-wrap items-end gap-2" onsubmit={(e) => submit(e, 'elements', { kind: elKind, name: elName.trim() }, 'elements')} data-testid="uml-element-form">
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Kind
            <select class={field} bind:value={elKind} data-testid="uml-element-kind">{#each UML_ELEMENT_KINDS as k (k)}<option value={k}>{UML_KIND_LABEL[k]}</option>{/each}</select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name<input class={field} bind:value={elName} required maxlength="300" data-testid="uml-element-name" /></label>
          <button type="submit" class={primary} disabled={busy || !elName.trim()} data-testid="uml-element-create">{busy ? 'Adding…' : 'Add'}</button>
        </form>
        {@render problems()}
      {/if}
      {#if elements.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No elements yet.</p>
      {:else}
        <ul class="flex flex-wrap gap-x-4 gap-y-1">
          {#each elements as e (e.id)}
            <li data-testid="uml-element-row"><a class="text-sm text-[var(--color-link)] hover:underline" href={`/library/architecture/uml/elements/${encodeURIComponent(e.id)}`}>{e.name || '(no name)'}</a> <span class="text-xs text-[var(--color-text-muted)]">{UML_KIND_LABEL[e.kind] ?? e.kind}</span></li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Relationships -->
    <section class={card} data-testid="uml-relationships">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Relationships ({relationships.length})</h2>
        <button type="button" class={addBtn} onclick={() => show('relationship')} disabled={elements.length < 1} data-testid="uml-add-relationship">Add a relationship</button>
      </div>
      {#if open === 'relationship'}
        <form
          class="flex flex-wrap items-end gap-2"
          onsubmit={(e) => {
            const b = relationshipBody();
            if (b) submit(e, 'relationships', b, 'relationships');
            else e.preventDefault();
          }}
          data-testid="uml-relationship-form"
        >
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Kind
            <select class={field} bind:value={relKind} data-testid="uml-relationship-kind">{#each UML_RELATIONSHIP_KINDS as k (k)}<option value={k}>{UML_KIND_LABEL[k]}</option>{/each}</select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">{relKind === 'generalization' ? 'Specific element' : relKind === 'association' ? 'One end' : 'From'}
            <select class={field} bind:value={relSource} data-testid="uml-relationship-source"><option value="">Choose…</option>{#each elements as e (e.id)}<option value={e.id}>{e.name || e.id}</option>{/each}</select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">{relKind === 'generalization' ? 'General element' : relKind === 'association' ? 'Other end' : 'To'}
            <select class={field} bind:value={relTarget} data-testid="uml-relationship-target"><option value="">Choose…</option>{#each elements as e (e.id)}<option value={e.id}>{e.name || e.id}</option>{/each}</select>
          </label>
          {#if relKind === 'connector'}
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Connector
              <select class={field} bind:value={relConnector}><option value="assembly">Assembly</option><option value="delegation">Delegation</option></select>
            </label>
          {/if}
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name (optional)<input class={field} bind:value={relName} maxlength="300" /></label>
          <button type="submit" class={primary} disabled={busy} data-testid="uml-relationship-create">{busy ? 'Adding…' : 'Add'}</button>
        </form>
        {@render problems()}
      {/if}
      {#if relationships.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No relationships yet.</p>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each relationships as r (r.id)}
            <li data-testid="uml-relationship-row"><a class="text-sm text-[var(--color-link)] hover:underline" href={`/library/architecture/uml/relationships/${encodeURIComponent(r.id)}`}>{umlRelationshipLabel(r, nameOf)}</a></li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Interactions -->
    <section class={card} data-testid="uml-interactions">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Interactions ({interactions.length})</h2>
        <button type="button" class={addBtn} onclick={() => show('interaction')} data-testid="uml-add-interaction">Add an interaction</button>
      </div>
      <p class="text-xs text-[var(--color-text-muted)]">An interaction is a sequence of messages between participants (lifelines).</p>
      {#if open === 'interaction'}
        <form class="flex flex-wrap items-end gap-2" onsubmit={(e) => submit(e, 'interactions', { name: intName.trim(), lifelines: [], occurrences: [], messages: [], executions: [], fragments: [] }, 'interactions')}>
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name<input class={field} bind:value={intName} required maxlength="300" data-testid="uml-interaction-name" /></label>
          <button type="submit" class={primary} disabled={busy || !intName.trim()} data-testid="uml-interaction-create">{busy ? 'Adding…' : 'Add'}</button>
        </form>
        {@render problems()}
      {/if}
      {#if interactions.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No interactions yet.</p>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each interactions as i (i.id)}
            <li data-testid="uml-interaction-row"><a class="text-sm text-[var(--color-link)] hover:underline" href={`/library/architecture/uml/interactions/${encodeURIComponent(i.id)}`}>{i.name || '(no name)'}</a> <span class="text-xs text-[var(--color-text-muted)]">{plural(i.lifelines.length, 'participant')}, {plural(i.messages.length, 'message')}</span></li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Diagrams -->
    <section class={card} data-testid="uml-diagrams">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold text-[var(--color-text)]">Diagrams ({diagrams.length})</h2>
        <button type="button" class={addBtn} onclick={() => show('diagram')} data-testid="uml-add-diagram">Add a diagram</button>
      </div>
      {#if open === 'diagram'}
        <form class="flex flex-wrap items-end gap-2" onsubmit={(e) => submit(e, 'diagrams', { kind: diaKind, name: diaName.trim() }, 'diagrams')} data-testid="uml-diagram-form">
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Kind
            <select class={field} bind:value={diaKind} data-testid="uml-diagram-kind">{#each UML_DIAGRAM_KINDS as k (k)}<option value={k}>{UML_KIND_LABEL[`${k}_diagram`]}</option>{/each}</select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name<input class={field} bind:value={diaName} required maxlength="300" data-testid="uml-diagram-name" /></label>
          <button type="submit" class={primary} disabled={busy || !diaName.trim()} data-testid="uml-diagram-create">{busy ? 'Adding…' : 'Add'}</button>
        </form>
        {@render problems()}
      {/if}
      {#if diagrams.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No diagrams yet.</p>
      {:else}
        <ul class="flex flex-col gap-1">
          {#each diagrams as d (d.id)}
            <li data-testid="uml-diagram-row"><a class="text-sm text-[var(--color-link)] hover:underline" href={`/library/architecture/uml/diagrams/${encodeURIComponent(d.id)}`}>{d.name || '(no name)'}</a> <span class="text-xs text-[var(--color-text-muted)]">{UML_KIND_LABEL[`${d.kind}_diagram`] ?? d.kind}</span></li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>
