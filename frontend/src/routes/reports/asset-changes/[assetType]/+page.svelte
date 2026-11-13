<!--
  /reports/asset-changes/[assetType] — GET /api/reports/asset-changes/:assetType

  Backend: backend/src/routes/reports/index.ts:69 -> { data: AssetChangeHistory }
  (domain/reporting/index.ts:219). Only four assetTypes are accepted; anything
  else is a 400 (BadRequestError), so the page rejects an unknown segment itself
  rather than round-tripping to earn the same answer.

  The `note` field is the important one. An empty `changes` array with a note
  means "this cannot be reported", which is a DIFFERENT fact from "nothing
  changed", and the two get different UI. Showing "no changes" here would be a
  straightforward lie about the state of the system.

  ⚠️ CORRECTED. This comment used to say the note marks an upstream with "no
  versions endpoint at all — today that is `requirements`". That is not what the
  domain does. `assetChangeHistory`
  (backend/src/domain/reporting/index.ts:313-360) sets a note on ALL FOUR types,
  and only when `assetId` is MISSING: the four upstreams list versions of ONE
  asset, never of a family. So the note is a missing-required-parameter signal,
  and its text is an API contract sentence
  ("requirements requires assetId (requirement id) to list versions").
  Rendered verbatim it was the entire body of this page — the four asset types
  (now rows in the rail's "Asset changes" sub-group; the in-page type chip
  strip was removed by the nav standard, 2026-10-03), every one of which lands on it, because nothing here ever
  asked for the parameter they all need. The note is still shown, but as
  supporting detail under a state that names the missing input and points at
  the field that supplies it.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import {
    getAssetChanges,
    ASSET_TYPES,
    type AssetChangeHistory,
    type AssetType,
  } from '$lib/api/reports';
  import ReportPanel from '$lib/components/reports/ReportPanel.svelte';

  const rawType = $derived($page.params.assetType ?? '');
  const isKnownType = $derived((ASSET_TYPES as readonly string[]).includes(rawType));

  let data = $state<AssetChangeHistory | undefined>(undefined);
  let loading = $state(true);
  let error = $state<string | undefined>(undefined);
  let since = $state('');
  let assetId = $state('');
  // The assetId the CURRENT `data` was fetched with — not the live input, which
  // the user may already be retyping. The note branch keys off this.
  let requestedAssetId = $state('');

  async function load(t: string, sinceValue: string, idValue: string): Promise<void> {
    if (!(ASSET_TYPES as readonly string[]).includes(t)) {
      // Mirrors the backend's own 400 so the message names the real constraint.
      data = undefined;
      loading = false;
      error = `Unsupported asset type '${t}'. Valid types: ${ASSET_TYPES.join(', ')}.`;
      return;
    }
    loading = true;
    error = undefined;
    requestedAssetId = idValue;
    try {
      data = await getAssetChanges(t as AssetType, {
        since: sinceValue ? new Date(sinceValue).toISOString() : undefined,
        assetId: idValue || undefined,
      });
    } catch (e) {
      data = undefined;
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load(rawType, '', '');
  });

  function applyFilters(e: SubmitEvent): void {
    e.preventDefault();
    void load(rawType, since, assetId);
  }

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  }

  // A note is a reportable OUTCOME, so a noted-but-changeless response is not
  // "empty" — the panel must render the note rather than the empty message.
  const isEmpty = $derived(!data || (data.changes.length === 0 && !data.note));

  // The domain's own parenthetical, per type (backend/src/domain/reporting/index.ts).
  const ASSET_ID_NOUN: Record<AssetType, string> = {
    requirements: 'requirement id',
    decisions: 'decision id',
    principles: 'principle id',
  };
  const assetIdNoun = $derived(
    isKnownType ? ASSET_ID_NOUN[rawType as AssetType] : 'asset id',
  );

  // A note on a request that carried NO assetId is the domain's
  // missing-required-parameter branch — the one and only condition under which
  // it short-circuits before touching an adapter. Mirror that condition rather
  // than sniffing the note's wording, which is upstream prose and may change.
  const needsAssetId = $derived(
    !!data?.note && requestedAssetId === '' && data.changes.length === 0,
  );

  const inputCls =
    'mt-1 block h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]';

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle($page.url.pathname, isKnownType ? rawType : null);
  });
</script>

<div class="mx-auto max-w-6xl py-2">
  <header class="mb-4">
    <nav aria-label="Breadcrumb" class="text-xs text-[var(--color-text-muted)]">
      <span>Govern</span>
      <span class="mx-1">/</span>
      <span>Asset changes</span>
    </nav>
    <div class="mt-1 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-[var(--color-text)] capitalize">
          {rawType || 'Asset'} changes
        </h1>
        <p class="mt-1 text-sm text-[var(--color-text-muted)]">
          Version history for the {rawType || 'selected'} asset family.
        </p>
      </div>
      {#if isKnownType}
        <form class="flex flex-wrap items-end gap-2" onsubmit={applyFilters}>
          <label class="text-xs text-[var(--color-text-muted)]">
            Since
            <input type="date" bind:value={since} aria-label="Since date" class={inputCls} />
          </label>
          <label class="text-xs text-[var(--color-text-muted)]">
            Asset id
            <!--
              NOT `optional`. Every one of the four types short-circuits without
              it (domain/reporting/index.ts:313-360), so the placeholder used to
              tell the user the opposite of the contract.
            -->
            <input
              id="asset-changes-asset-id"
              bind:value={assetId}
              aria-label="Asset id"
              placeholder={assetIdNoun}
              class={inputCls}
            />
          </label>
          <button
            type="submit"
            class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
          >
            Apply
          </button>
        </form>
      {/if}
    </div>
  </header>

  <ReportPanel
    label="asset change history"
    {loading}
    {error}
    empty={isEmpty}
    emptyMessage="No versions recorded for this asset family in the selected window. Clear the filters to see the full history."
    onRetry={() => void load(rawType, since, assetId)}
  >
    {#if data}
      {#if needsAssetId}
        <!--
          The domain refused for a NAMED, user-supplyable reason: no assetId.
          Say that in the user's terms, name the field that fixes it, and keep
          the upstream sentence visible underneath as detail — swallowing it
          into "something went wrong" would destroy the one piece of
          information that makes the state actionable.
        -->
        <div
          data-testid="asset-changes-needs-asset-id"
          class="mb-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4"
        >
          <p class="text-sm font-medium text-[var(--color-text)]">
            An asset id is required to show {rawType} version history.
          </p>
          <p class="mt-1 text-sm text-[var(--color-text-muted)]">
            Versions are recorded per asset, not for the {rawType} family as a whole.
            Enter a {assetIdNoun} in the “Asset id” field above and press Apply.
          </p>
          <p class="mt-2 text-xs text-[var(--color-text-muted)]">
            Reported by the API as: {data.note}
          </p>
        </div>
      {:else if data.note}
        <!-- Any other note: an upstream remark on a result we DID get. -->
        <p
          data-testid="asset-changes-note"
          class="mb-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-3 text-sm text-[var(--color-text-muted)]"
        >
          {data.note}
        </p>
      {/if}
      {#if data.changes.length > 0}
        <table class="w-full table-auto border-collapse text-sm">
          <thead>
            <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
              <th class="py-2 pr-4">Asset id</th>
              <th class="py-2 pr-4">Version</th>
              <th class="py-2 pr-4">Updated</th>
            </tr>
          </thead>
          <tbody>
            {#each data.changes as c, i (`${c.id ?? 'row'}-${c.version ?? i}`)}
              <tr class="border-b border-[var(--color-border)] align-top">
                <td class="py-2 pr-4 font-mono text-xs text-[var(--color-text)]">{c.id ?? '—'}</td>
                <td class="py-2 pr-4 text-[var(--color-text-muted)]">{c.version ?? '—'}</td>
                <td class="py-2 pr-4 whitespace-nowrap text-[var(--color-text-muted)]">
                  {fmtDate(c.updated_at)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}
  </ReportPanel>
</div>
