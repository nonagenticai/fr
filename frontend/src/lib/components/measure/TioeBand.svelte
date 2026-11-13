<!--
  TioeBand.svelte — the T/I/OE measurement lens (control-plane roadmap Phase 7).

  One self-contained band rendered at the top of /measure. It reads the
  compose-endpoint GET /api/measure?window=&stream= and presents the three
  doctrine lenses side by side:

    Throughput  — cards that reached DONE in the window (from Planka board
                  moves; fr never asks n8n — the lifecycle writes to Planka).
    Inventory   — non-DONE work-in-progress, split by AA phase + a BLOCKED
                  side-count.
    Operating-  — LLM tokens + USD cost over the window (workspace-wide, from
    Expense       analytics_rollups) + approval decisions made (human review).

  A constraint call-out names the most-loaded WIP phase (or BLOCKED). Defensive by design: any non-conforming response (or the
  endpoint being absent) degrades to an empty state rather than throwing, so
  the operator-analytics section below always renders.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { authFetch } from '$lib/api/auth-fetch';

  type Phase = 'READYING' | 'DOING' | 'INSPECTING' | 'PUBLISHING';

  interface MeasureData {
    window: string;
    stream: string | null;
    streams: { id: string; name: string }[];
    inventory: {
      by_phase: { READYING: number; DOING: number; INSPECTING: number };
      blocked: number;
      total: number;
      done_current: number;
      /** false ⇒ the numbers above are lower bounds (see `meta.inventory_complete`). */
      complete?: boolean;
    };
    // `null` means the backend could not read throughput at all — NOT that
    // nothing moved. Rendering a null as 0 is exactly the confident zero the
    // backend stopped emitting, so it must reach the eye as "unavailable".
    throughput: { to_done: number | null; window: string };
    // Same rule, per metric: `null` means NO cost/token rollup row was written
    // for this window (the analytics rollup writes nothing when Prometheus
    // returned no series), NOT that the workspace spent nothing. `tokens` and
    // `cost_usd` are independent — one can be known while the other is not.
    //
    // ⚠️ `approvals_decided` WAS DECLARED `number` HERE, on the note "it is a
    // COUNT(*) and therefore always has an answer". That is true of TODAY's
    // backend (`backend/src/routes/measure.ts:474` —
    // `Number(decisionRows[0]?.c ?? 0)`), and it was never a property THIS page
    // could rely on: `parse()` ends in `d as unknown as MeasureData`, so the
    // declared type is an ASSUMPTION about the wire, not a check of it. A
    // payload that omits the key satisfied the type and reached the template
    // completely unvalidated. Declared absent- and null-tolerant so the
    // compiler stops vouching for a guarantee nothing measures.
    oe: {
      tokens: number | null;
      cost_usd: number | null;
      approvals_decided?: number | null;
    };
    constraint: {
      phase: Phase | null;
      wip: number;
      reason: string;
    } | null;
  }

  /** The envelope's `meta` block. `degraded` says some numbers below were
   *  read only partially; without surfacing it the flag is unreachable. */
  interface MeasureMeta {
    stream_count: number;
    partial_streams: number;
    degraded: boolean;
    throughput_complete: boolean;
    /**
     * false ⇒ every `inventory.*` number is a LOWER BOUND, because at least one
     * contributing Planka list held more cards than the backend's count walk
     * read. Optional so an older backend's payload still parses; only
     * `=== false` suppresses the exact reading, so an absent flag never invents
     * a "partial" that was not reported.
     */
    inventory_complete?: boolean;
  }

  const WINDOWS = ['24h', '7d', '30d', '90d'] as const;
  type Window = (typeof WINDOWS)[number];

  let window = $state<Window>('7d');
  let streamId = $state('all');
  let loading = $state(false);
  let error = $state<string | null>(null);
  let data = $state<MeasureData | null>(null);
  let meta = $state<MeasureMeta | null>(null);

  /** Stream options survive across reloads so the selector never empties. */
  let streamOptions = $state<{ id: string; name: string }[]>([]);

  function isNum(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /** Validate the envelope's `data` block before trusting it. Returns null on
   *  any shape mismatch (the band then shows its empty state). */
  function parse(body: unknown): MeasureData | null {
    const d = (body as { data?: Record<string, unknown> } | null)?.data;
    if (!d) return null;
    const inv = d.inventory as MeasureData['inventory'] | undefined;
    const tp = d.throughput as MeasureData['throughput'] | undefined;
    const oe = d.oe as MeasureData['oe'] | undefined;
    if (!inv || !inv.by_phase || !isNum(inv.total)) return null;
    // A null `to_done` is a VALID envelope meaning "unknown", so it must not
    // null the whole parse — doing so would blank inventory and OE as well.
    if (!tp || (tp.to_done !== null && !isNum(tp.to_done))) return null;
    // ⛔ ORDERING HAZARD, and it is the whole reason this line changed FIRST.
    // `!isNum(oe.cost_usd)` rejected a `null` cost, and a rejected parse blanks
    // the ENTIRE band — throughput and inventory included. So the day the
    // backend starts answering `cost_usd: null` (its honest "no rollup row was
    // written for this window"), an unrelaxed page shows the operator nothing
    // at all. Exactly the trap `to_done` recorded one line up.
    // A missing/NaN cost is still a shape error; `null` is a VALID envelope.
    if (!oe || (oe.cost_usd !== null && !isNum(oe.cost_usd))) return null;
    // ⛔ AND `approvals_decided` IS DELIBERATELY *NOT* GATED HERE. It is
    // validated at the RENDER SITE instead (`isNum`, in the OE tile below), for
    // exactly the reason the two blocks above just recorded: a rejected parse
    // blanks the ENTIRE band, so gating it here would trade "one number cannot
    // be shown" for "the operator sees nothing at all" — the same trade
    // `to_done` and `cost_usd` were both walked back from. A missing count costs
    // its own number and nothing else.
    return d as unknown as MeasureData;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const params = new URLSearchParams({ window });
      if (streamId !== 'all') params.set('stream', streamId);
      const res = await authFetch(`/api/measure?${params.toString()}`);
      if (!res.ok) {
        error = `Measure unavailable (${res.status})`;
        data = null;
        meta = null;
        return;
      }
      const body = (await res.json()) as { meta?: MeasureMeta };
      const parsed = parse(body);
      // ⚠️ `parse()` returns null for ANY shape drift on an otherwise-200
      // response. That left `data = null` with `error` still cleared, so the
      // template fell through to "No flow data for this window yet." — a
      // confident empty-board claim standing in for a broken contract. The two
      // sibling paths (!res.ok, and the catch) both set `error`; this one did
      // not, which is the whole defect.
      if (parsed === null) {
        error = 'Measure returned data this page could not read (unexpected shape)';
        data = null;
        meta = null;
        return;
      }
      data = parsed;
      meta = body.meta ?? null;
      if (Array.isArray(parsed.streams)) streamOptions = parsed.streams;
    } catch (err) {
      // Keep the reason: 'Measure unavailable' alone is indistinguishable from
      // the !res.ok branch, and the guard's `isRecorded` rule is satisfied by
      // USING the caught binding rather than by a log line nobody reads.
      error = `Measure unavailable (${err instanceof Error ? err.message : String(err)})`;
      data = null;
      meta = null;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function setWindow(w: Window): void {
    if (w === window) return;
    window = w;
    void load();
  }

  function onStreamChange(): void {
    void load();
  }

  function fmtInt(n: number): string {
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return Math.round(n).toString();
  }

  function fmtUsd(n: number): string {
    if (!Number.isFinite(n)) return '—';
    return `$${n.toFixed(2)}`;
  }

  const hasData = $derived(data !== null);
</script>

<section data-testid="measure-tioe" class="mb-8">
  <header class="flex flex-wrap items-center gap-3 mb-3">
    <h1 class="text-2xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">
      Measure
    </h1>
    <span class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
      Throughput · Inventory · Operating-Expense
    </span>

    <!-- Window picker -->
    <div
      class="ml-auto inline-flex rounded border border-[var(--color-border-strong)] overflow-hidden text-sm dark:border-[var(--color-border-strong)]"
    >
      {#each WINDOWS as w (w)}
        <button
          type="button"
          class="px-3 py-1 {window === w
            ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]'
            : 'bg-[var(--color-bg)] text-[var(--color-text)] hover:bg-[var(--color-surface)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]'}"
          onclick={() => setWindow(w)}
          data-testid="measure-window-{w}"
        >
          {w}
        </button>
      {/each}
    </div>

    <!-- Stream selector -->
    <select
      bind:value={streamId}
      onchange={onStreamChange}
      class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-sm dark:border-[var(--color-border-strong)]"
      data-testid="measure-stream-select"
    >
      <option value="all">All streams</option>
      {#each streamOptions as s (s.id)}
        <option value={s.id}>{s.name}</option>
      {/each}
    </select>

    <button
      type="button"
      onclick={() => load()}
      disabled={loading}
      class="px-3 py-1 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
      data-testid="measure-refresh"
    >
      {loading ? '…' : 'Refresh'}
    </button>
  </header>

  {#if error}
    <div
      class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mb-3"
      data-testid="measure-error"
    >
      {error}
    </div>
  {/if}

  {#if meta?.degraded}
    <div
      class="bg-[var(--color-warning-bg,var(--color-surface-strong))] border border-[var(--color-border)] text-[var(--color-text)] px-3 py-2 rounded text-sm mb-3"
      data-testid="measure-degraded"
    >
      Some boards could not be read in full ({meta.partial_streams} of {meta.stream_count}).
      The numbers below are incomplete.
    </div>
  {/if}

  <!-- ⚠️ `&& !error`. Every failure path above sets BOTH `error` and `data =
       null`, and `hasData` only reads `data` — so a failed measure read printed
       the red banner AND, directly beneath it, "No flow data for this window
       yet… populate as cards move through the mantra". That empty-state copy is
       a claim about the BOARD, made from a read that never returned; a customer
       reading it concludes their cards are not moving. An outage and an empty
       window must not paint the same pixels, so the empty state is now reachable
       only when the read actually succeeded and returned nothing. -->
  {#if !hasData && !loading && !error}
    <p
      class="text-sm text-[var(--color-text-muted)] my-6 text-center dark:text-[var(--color-text-muted)]"
      data-testid="measure-empty"
    >
      No flow data for this window yet. Throughput and inventory populate as
      cards move through the
      <a href="/kanban" class="text-[var(--color-accent)] underline">mantra</a>
      (READYING → DOING → INSPECTING → PUBLISHING).
    </p>
  {:else if hasData && data}
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3" data-testid="measure-grid">
      <!-- Throughput -->
      <div
        class="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-4 shadow-sm flex flex-col gap-1 dark:border-[var(--color-border)] dark:bg-[var(--color-surface)]"
        data-testid="measure-card-throughput"
      >
        <div class="text-xs uppercase tracking-wide text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
          Throughput
        </div>
        {#if data.throughput.to_done === null}
          <div
            class="text-3xl font-semibold text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
            data-testid="measure-throughput-unavailable"
          >
            —
          </div>
          <div class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
            unavailable · the board history could not be read
          </div>
        {:else}
          <div class="text-3xl font-semibold tabular-nums text-[var(--color-text)] dark:text-[var(--color-text)]">
            {fmtInt(data.throughput.to_done)}
          </div>
          <div class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
            cards reached DONE · last {data.throughput.window}{meta &&
            !meta.throughput_complete
              ? ' (partial)'
              : ''}
          </div>
        {/if}
      </div>

      <!-- Inventory -->
      <div
        class="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-4 shadow-sm flex flex-col gap-1 dark:border-[var(--color-border)] dark:bg-[var(--color-surface)]"
        data-testid="measure-card-inventory"
      >
        <div class="text-xs uppercase tracking-wide text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
          Inventory (WIP)
        </div>
        <!--
          A truncated inventory is a FLOOR, not a total: Planka pages cards at
          50, so before `inventory_complete` existed a 2,842-card list reached
          this tile as "50" and was rendered as if counted. "N+" plus the note
          below is the honest form.
        -->
        <div
          class="text-3xl font-semibold tabular-nums text-[var(--color-text)] dark:text-[var(--color-text)]"
          data-testid="measure-inventory-total"
        >
          {fmtInt(data.inventory.total)}{meta && meta.inventory_complete === false ? '+' : ''}
        </div>
        {#if meta && meta.inventory_complete === false}
          <div
            class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
            data-testid="measure-inventory-partial"
          >
            at least · a board list held more cards than could be read
          </div>
        {/if}
        <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
          <span>READYING {data.inventory.by_phase.READYING}</span>
          <span>DOING {data.inventory.by_phase.DOING}</span>
          <span>INSPECTING {data.inventory.by_phase.INSPECTING}</span>
          {#if data.inventory.blocked > 0}
            <span class="text-[var(--color-danger-text)] dark:text-[var(--color-danger-text)]" data-testid="measure-blocked">
              BLOCKED {data.inventory.blocked}
            </span>
          {/if}
        </div>
      </div>

      <!-- Operating Expense -->
      <div
        class="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-4 shadow-sm flex flex-col gap-1 dark:border-[var(--color-border)] dark:bg-[var(--color-surface)]"
        data-testid="measure-card-oe"
      >
        <div class="text-xs uppercase tracking-wide text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
          Operating-Expense
        </div>
        <!--
          ⛔ ZERO AND UNKNOWN MUST NOT PAINT THE SAME PIXELS. `$0.00` used to
          come out byte-identical for "no metered LLM spend this window" and
          "the analytics rollup never wrote a cost row for this window, so we
          were never told" — the backend seeded 0 and returned it untouched.
          Same defect, same remedy as `throughput.to_done` above and as the Cost page's
          'amount unavailable, not $0' states.

          ⚠️ THE ZERO BRANCH IS DELIBERATELY FIRST. With the `=== null` branch
          first, softening this test to `if (!data.oe.cost_usd)` would be
          BEHAVIOURALLY IDENTICAL (null having already been consumed) — an
          unkillable mutation, i.e. a test that cannot fail. Ordered this way a
          falsy test swallows `null` into `$0.00` and the unknown case reds.
        -->
        {#if data.oe.cost_usd === 0}
          <div
            class="text-3xl font-semibold tabular-nums text-[var(--color-text)] dark:text-[var(--color-text)]"
            data-testid="measure-oe-zero"
          >
            {fmtUsd(0)}
          </div>
          <div class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
            no metered LLM spend in this window
          </div>
        {:else if data.oe.cost_usd === null}
          <!-- ⛔ NO CURRENCY FORMATTING IN THIS BRANCH, EVER: a `$` here is the
               whole defect returning. -->
          <div
            class="text-3xl font-semibold text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
            data-testid="measure-oe-unknown"
          >
            —
          </div>
          <div class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
            unavailable · no cost rollup has been written for this window
          </div>
        {:else}
          <div class="text-3xl font-semibold tabular-nums text-[var(--color-text)] dark:text-[var(--color-text)]">
            {fmtUsd(data.oe.cost_usd)}
          </div>
        {/if}
        <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
          <!-- Tokens fail INDEPENDENTLY of cost: the two metrics are separate
               rollup rows, so one can be written while the other is not. A
               shared flag would report a known token count as unknown (or, in
               the other direction, print `0 tokens` for an unwritten row). -->
          {#if isNum(data.oe.tokens)}
            <span>{fmtInt(data.oe.tokens)} tokens</span>
          {:else}
            <span data-testid="measure-oe-tokens-unknown">— tokens (not rolled up)</span>
          {/if}
          <!--
            ⛔ A COUNT THAT DID NOT ARRIVE IS NOT A COUNT OF ZERO — and it was
            not even a wrong number. Unvalidated, an absent `approvals_decided`
            reached the DOM through Svelte's own `?? ''` text coercion (measured
            on svelte 5.55.5: this interpolation compiles to
            `set_text(text, `${…approvals_decided ?? ''} approvals reviewed`)`)
            and rendered " approvals reviewed" — a unit label with NO number,
            which reads as a rendering glitch and states nothing at all. The
            em-dash form is the same unknown rendering as the tokens sibling
            beside it, `measure-oe-unknown` above and
            `measure-throughput-unavailable`.

            ⚠️ `isNum`, NOT a falsy test, and that is the whole guard: `0` is a
            REAL and ordinary answer (a window in which nobody reviewed
            anything) and must keep rendering as `0`. `!data.oe.approvals_decided`
            would report a measured zero as unreported — the same collapse of
            zero into unknown that the cost tile above exists to prevent, in the
            opposite direction.
          -->
          {#if isNum(data.oe.approvals_decided)}
            <span>{data.oe.approvals_decided} approvals reviewed</span>
          {:else}
            <span data-testid="measure-oe-approvals-unknown">— approvals reviewed (not reported)</span>
          {/if}
        </div>
      </div>
    </div>

    {#if data.constraint}
      <div
        class="mt-3 flex items-center gap-2 rounded border border-[var(--color-warning-bg)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] px-3 py-2 text-sm"
        data-testid="measure-constraint"
      >
        <span class="font-semibold">Constraint:</span>
        <span>{data.constraint.reason}</span>
      </div>
    {/if}

    <p class="mt-2 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
      Operating-Expense is workspace-wide (tokens/cost are not yet attributable
      per stream or per phase). Throughput &amp; inventory are scoped to the
      selected stream.
    </p>
  {/if}
</section>
