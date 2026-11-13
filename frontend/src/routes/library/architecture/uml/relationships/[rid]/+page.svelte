<!--
  /library/architecture/uml/relationships/[rid] — one UML relationship. An
  association is edited as its two ends (element, role, how many, part-of
  kind, navigable); every other kind as "from" and "to" (for a generalization,
  the specific and the general element); a connector also has its kind
  (assembly / delegation). Trace links and deletion below.
-->
<script lang="ts">
  import { page } from '$app/state';
  import TraceLinksPanel from '$lib/components/modeling/TraceLinksPanel.svelte';
  import UmlDeletePanel from '$lib/components/modeling/UmlDeletePanel.svelte';
  import {
    ModelingError,
    UML_RELATIONSHIP_KINDS,
    getModel,
    getUml,
    listUml,
    updateUml,
    type ArchitectureModel,
    type UmlElement,
    type UmlEnd,
    type UmlRelationship,
    type ValidationFinding,
  } from '$lib/api/modeling';
  import { UML_KIND_LABEL, umlRelationshipLabel } from '$lib/modeling/uml';

  const rid = $derived(decodeURIComponent(page.params.rid ?? ''));

  let rel = $state<UmlRelationship | null>(null);
  let model = $state<ArchitectureModel | null>(null);
  let elements = $state<UmlElement[]>([]);
  let loadError = $state<string | null>(null);
  let notFound = $state(false);

  let kind = $state('association');
  let name = $state('');
  let source = $state('');
  let target = $state('');
  let connectorKind = $state<'assembly' | 'delegation'>('assembly');
  let ends = $state<UmlEnd[]>([]);

  function blankEnd(ref = ''): UmlEnd {
    return { element_ref: ref, role: null, multiplicity: null, aggregation: 'none', navigable: true };
  }
  function fill(r: UmlRelationship): void {
    kind = r.kind;
    name = r.name ?? '';
    source = r.source ?? '';
    target = r.target ?? '';
    connectorKind = r.connector_kind === 'delegation' ? 'delegation' : 'assembly';
    ends = r.ends?.length === 2 ? structuredClone(r.ends) : [blankEnd(r.source ?? ''), blankEnd(r.target ?? '')];
  }

  async function load(): Promise<void> {
    loadError = null;
    notFound = false;
    try {
      const r = await getUml<UmlRelationship>('relationships', rid);
      rel = r;
      fill(r);
      [model, elements] = await Promise.all([getModel(r.model_id), listUml<UmlElement>('elements', { model_id: r.model_id })]);
    } catch (err) {
      if (err instanceof ModelingError && err.status === 404) notFound = true;
      else loadError = err instanceof Error ? err.message : String(err);
    }
  }
  $effect(() => {
    void rid;
    load();
  });

  const nameOf = $derived(new Map(elements.map((e) => [e.id, e.name])));
  const modelHref = $derived(rel ? `/library/architecture/models/${encodeURIComponent(rel.model_id)}` : '/library/architecture/models');
  const label = $derived(rel ? umlRelationshipLabel(rel, nameOf) : '');

  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let findings = $state<ValidationFinding[]>([]);
  let stale = $state(false);
  let saved = $state(false);

  async function save(e: Event): Promise<void> {
    e.preventDefault();
    if (!rel) return;
    saving = true;
    saveError = null;
    findings = [];
    stale = false;
    saved = false;
    const body: Record<string, unknown> = { kind, name: name.trim() };
    if (kind === 'association') {
      body.ends = ends;
      body.source = null;
      body.target = null;
    } else {
      body.source = source || null;
      body.target = target || null;
      body.ends = null;
    }
    body.connector_kind = kind === 'connector' ? connectorKind : null;
    try {
      rel = await updateUml<UmlRelationship>('relationships', rel.id, body, model?.head);
      fill(rel);
      model = await getModel(rel.model_id);
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

  const field = 'rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]';
  const card = 'flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4';
</script>

<div class="flex flex-col gap-4 px-6 py-4" data-testid="uml-relationship-page">
  <a href={modelHref} class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">← {model?.title ?? 'Model'}</a>
  {#if notFound}
    <p class="text-sm text-[var(--color-text)]" data-testid="uml-not-found">This relationship does not exist, or you do not have access to it.</p>
  {:else if loadError}
    <div class="flex flex-wrap items-center gap-2"><p class="text-sm text-[var(--color-danger)]">The relationship could not be loaded: {loadError}</p><button type="button" class="text-sm text-[var(--color-link)] underline" onclick={load}>Try again</button></div>
  {:else if !rel}
    <p class="text-sm text-[var(--color-text-muted)]">Loading the relationship…</p>
  {:else}
    <header>
      <h1 class="text-2xl font-semibold text-[var(--color-text)]">{label}</h1>
      <p class="text-sm text-[var(--color-text-muted)]">{UML_KIND_LABEL[rel.kind] ?? rel.kind} in {model?.title ?? 'a UML model'}</p>
    </header>
    <form class={card} onsubmit={save} data-testid="uml-relationship-edit">
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Kind
          <select class={field} bind:value={kind}>{#each UML_RELATIONSHIP_KINDS as k (k)}<option value={k}>{UML_KIND_LABEL[k]}</option>{/each}</select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Name<input class={field} bind:value={name} maxlength="300" /></label>
        {#if kind === 'connector'}
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Connector
            <select class={field} bind:value={connectorKind}><option value="assembly">Assembly</option><option value="delegation">Delegation</option></select>
          </label>
        {/if}
      </div>
      {#if kind === 'association'}
        {#each ends as end, i (i)}
          <fieldset class="flex flex-wrap items-end gap-2" data-testid="uml-end">
            <legend class="text-sm font-semibold text-[var(--color-text)]">{i === 0 ? 'One end' : 'Other end'}</legend>
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Element
              <select class={field} bind:value={end.element_ref}><option value="">Choose…</option>{#each elements as el (el.id)}<option value={el.id}>{el.name}</option>{/each}</select>
            </label>
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Role<input class={field} value={end.role ?? ''} oninput={(e) => (end.role = (e.currentTarget as HTMLInputElement).value || null)} /></label>
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">How many<input class="{field} w-20" value={end.multiplicity ?? ''} oninput={(e) => (end.multiplicity = (e.currentTarget as HTMLInputElement).value || null)} placeholder="1, 0..1, *" /></label>
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Part of the other
              <select class={field} bind:value={end.aggregation}><option value="none">No</option><option value="shared">Shared</option><option value="composite">Composed (owned)</option></select>
            </label>
            <label class="flex items-center gap-1 text-xs text-[var(--color-text)]"><input type="checkbox" bind:checked={end.navigable} /> Navigable</label>
          </fieldset>
        {/each}
      {:else}
        <div class="flex flex-wrap items-end gap-3">
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">{kind === 'generalization' ? 'Specific element' : 'From'}
            <select class={field} bind:value={source}><option value="">Choose…</option>{#each elements as el (el.id)}<option value={el.id}>{el.name}</option>{/each}</select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">{kind === 'generalization' ? 'General element' : 'To'}
            <select class={field} bind:value={target}><option value="">Choose…</option>{#each elements as el (el.id)}<option value={el.id}>{el.name}</option>{/each}</select>
          </label>
        </div>
      {/if}
      {#if saveError}
        <div class="flex flex-col gap-1" data-testid="uml-relationship-save-error">
          <p class="text-sm text-[var(--color-danger)]">{saveError}</p>
          {#each findings as f, i (i)}<p class="text-sm text-[var(--color-danger)]" title={`Rule ${f.rule_id}`}>• {f.message}</p>{/each}
          {#if stale}<button type="button" class="self-start text-xs text-[var(--color-link)] underline" onclick={load}>Reload the latest version</button>{/if}
        </div>
      {/if}
      {#if saved}<p class="text-sm text-[var(--color-success-text)]">Saved.</p>{/if}
      <button type="submit" class="self-start rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </form>
    {#key rel.id}<TraceLinksPanel kind="uml_relationship" itemId={rel.id} />{/key}
    <UmlDeletePanel resource="relationships" itemId={rel.id} name={rel.name || label} noun="relationship" backHref={modelHref} head={model?.head} />
  {/if}
</div>
