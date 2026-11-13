<script module lang="ts">
  // The kinds this component can render a reference to. ⚠️ DERIVED FROM A
  // RUNTIME ARRAY on purpose: a bare union cannot be enumerated by a test, so
  // `EntityRef.kind-nouns.test.ts` iterates THIS array to prove every member
  // has usable "gone" copy. Adding a member here therefore also adds it to that
  // table-driven test, and omitting its `KIND_NOUN` entry is a tsc error
  // (`Record<EntityKind, string>`) as well as a red test.
  export const ENTITY_KINDS = [
    'tenant',
    'user',
    'app',
    'licence',
    'project',
    'workspace',
    'run',
    'tuple',
    'secret',
    'stream',
    'repository',
    'card',
    // Added 2026-09-25 by the fr#1205 sweep: three call sites had to omit `kind`
    // entirely for want of a member, which silently downgrades them to the generic
    // 'record' noun. Naming them is strictly better than a generic fallback.
    'principle',
    'eval-set',
    'session',
  ] as const;

  export type EntityKind = (typeof ENTITY_KINDS)[number];
</script>

<script lang="ts">
  // EntityRef.svelte — the one way to render a reference to another entity.
  //
  // Why this exists: the admin console kept printing raw UUIDs at the operator
  // ("it shows tenant/user/license ids where I would like to see names"). A
  // uuid is not an identity — it is a lookup key that happens to be visible.
  // So: the NAME is what you read, the id stays REACHABLE (a title tooltip
  // carrying the full value, plus a short monospace stub you can eyeball
  // against a log line), and a full 36-char uuid never lands in a table cell.
  //
  // Presentational only — no fetching, no store access. The caller resolves the
  // name (an id→name map, a `*Label` helper) and passes it in. That keeps the
  // component usable from a table row, a form and a toast-adjacent label alike,
  // and keeps the N+1 question where it belongs: on the page that loads data.
  //
  // Three states, one shape:
  //   name given          → name, id demoted to a stub + tooltip
  //   name absent         → stub only (the row is fine, we just have no name)
  //   resolved === false  → the referent is GONE; a muted label + the stub
  //
  // `resolved` is deliberately separate from `name == null`: "we did not
  // resolve this name" and "this account no longer exists" are different facts
  // and must not render identically.

  import { shortId } from '$lib/utils/shortId';

  /** Default "gone" copy per kind. Pages that own their own wording pass `unresolvedLabel`. */
  const KIND_NOUN: Record<EntityKind, string> = {
    tenant: 'tenant',
    user: 'account',
    app: 'app',
    licence: 'licence',
    project: 'project',
    workspace: 'workspace',
    run: 'run',
    tuple: 'tuple',
    secret: 'secret',
    stream: 'stream',
    repository: 'repository',
    card: 'card',
    principle: 'principle',
    'eval-set': 'eval set',
    session: 'session',
  };

  /** Used when the caller passed no kind, or a kind with no `KIND_NOUN` entry. */
  const FALLBACK_NOUN = 'record';

  // ⛔ NEVER index `KIND_NOUN[kind]` directly. It used to be, and `Record<K, V>`
  // types that access as `string` even when the key is absent at runtime — so a
  // kind added to `EntityKind` without a `KIND_NOUN` entry, or a `kind` arriving
  // from untyped/serialised data, rendered the literal text
  // `Deleted undefined` at the operator. A Map's `get` is typed
  // `string | undefined`, which forces the fallback to be written.
  const NOUN_LOOKUP = new Map<string, string>(Object.entries(KIND_NOUN));

  function kindNoun(k: EntityKind | undefined): string {
    const noun = k === undefined ? undefined : NOUN_LOOKUP.get(k);
    return noun !== undefined && noun.trim() !== '' ? noun : FALLBACK_NOUN;
  }

  let {
    id,
    name = null,
    kind,
    resolved = true,
    unresolvedLabel,
    class: className = '',
  }: {
    id: string;
    name?: string | null;
    kind?: EntityKind;
    /** false = the referent no longer exists (deleted user, purged tenant). */
    resolved?: boolean;
    /** Overrides the default "Deleted …" copy; the owning page decides its wording. */
    unresolvedLabel?: string;
    class?: string;
  } = $props();

  const fullId = $derived(id ?? '');
  // Never the whole uuid inline. Ellipsis marks it as truncated so a short id
  // is not mistaken for a complete short code — and it LEADS, because the stub
  // is taken from the TAIL.
  //
  // ⚠️ The derivation itself now lives in `$lib/utils/shortId` (fr#1205), which
  // was extracted from THIS component byte for byte — including the `> 8`
  // boundary, so a 9-character id still truncates exactly as it did here. 25
  // other sites hand-rolled `id.slice(0, 8)`; they are being swept onto the
  // shared helper, and this component must not keep a private copy or the two
  // will drift. Read that file for WHY the tail and not the head (fr#1203: 52
  // apps collapsed to 27 distinct leading-8, versus 52 distinct trailing-8).
  const stub = $derived(shortId(fullId));
  const goneLabel = $derived(unresolvedLabel ?? `Deleted ${kindNoun(kind)}`);
  // The tooltip is where the full id lives — visible on demand, never in flow.
  const title = $derived(
    [resolved ? name : goneLabel, fullId].filter((p) => p && String(p).trim() !== '').join(' · '),
  );
</script>

<span
  class={`inline-flex items-baseline gap-1.5 ${className}`}
  data-testid="entity-ref"
  data-kind={kind ?? 'unknown'}
  data-resolved={resolved}
  {title}
>
  {#if !resolved}
    <span class="italic text-[var(--color-text-muted)]" data-testid="entity-ref-unresolved">
      {goneLabel}
    </span>
  {:else if name}
    <span class="truncate" data-testid="entity-ref-name">{name}</span>
  {/if}
  {#if stub}
    <span class="font-mono text-xs text-[var(--color-text-muted)]" data-testid="entity-ref-id">
      {stub}
    </span>
  {/if}
</span>
