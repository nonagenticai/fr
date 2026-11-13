<!--
  /admin/licenses — seats, TENANT-FIRST.

  ⛔ WHAT THIS PAGE USED TO GET WRONG, and why it mattered. The licensing
  service's own source says it outright (`licenses/main.py:2080`):

      ">1 is NORMAL: seats are minted per subject, apps are sold per tenant."

  There are THREE layers in that model:

    1. a tenant buys a BUNDLE                   (UNBUILT upstream — not here)
    2. a tenant has an OFFERING provisioned     (per product, per tenant)
    3. a SEAT is minted per PERSON              (one licence row, per subject)

  This console implemented layer 3 alone and presented it as the whole model. It
  asked for a PERSON first, then offered EVERY tenant in the registry unfiltered,
  and never showed whether the chosen tenant was entitled to the product or how
  many seats it already held. `GET /internal/tenants/{id}/seat-count` is
  BILLING's per-seat denominator — so a seat aimed at the wrong tenant does not
  fail, it charges someone else.

  So the hierarchy is inverted here. The TENANT is the subject of the operation:
  picking one is what opens the rest of the form, and picking one immediately
  shows what that tenant actually HAS (its provisioned offerings, its seat
  count) before anything is minted into it.

  ⛔ NO PERSON COLUMN. A licence is what a TENANT holds; it is not a fact about a
  named individual, and this table renders none. The old `Person` column resolved
  every `subject_id` to a name — measured in production it printed a RAW UUID for
  297 of 297 rows — which dressed per-person accounting up as licensing. Per
  person / per project attribution is USAGE, and usage is a different surface.

  ⚠️ OPEN, and NOT resolved here: `license.subject_id` is `NOT NULL` upstream with
  a FK to `subject(id)` and a unique index on `(tenant_id, app_id, subject_id)
  WHERE status='active'`, so the SCHEMA is per-subject even though licensing is
  per-tenant. That contradiction is the licensing service's to settle, not this
  page's. Consequence while it stands: minting a seat still REQUIRES a subject,
  so the grant form below keeps its person picker — the write path cannot satisfy
  a NOT NULL column without one. Removing that picker would break granting, not
  clean it up. What is gone is person IDENTITY as a property of a LICENCE ROW.

  ⭐ Aggregate SUBJECT COUNTS are kept and are not person data: `human subjects`,
  `service`, `unresolved`, `subjects (all classes)` and `licence rows` name
  nobody. They are the tenant-level readback of billing's own denominator, and
  the partition disclosure is what makes the billable figure readable at all.

  ⛔ HONESTY RULES this page exists to enforce:
    - an unreadable seat count renders UNKNOWN, never `0`. `catch { count = 0 }`
      is the defect this page deletes: it turns a failed GET into a billing
      claim.
    - unreadable offerings render UNKNOWN, never "no offerings". And in the
      payload, `offering_code: null` means PROVENANCE UNKNOWN, not absence.
    - `unresolved_subjects` is always disclosed and never folded into the human
      or service counts; the three partition `subjects` exactly.
    - a person with no tenant evidence is STILL GRANTABLE. Missing evidence is
      the majority case; gating on it would deny legitimate work.

  DESIGN (unchanged, and still true): an operator thinks in names, not UUIDs, so
  every field is a picker over known values. If the person doesn't exist yet the
  picker offers to provision them, carrying the typed email along.

  Auth: the section +layout.svelte gates super-admin; every backend route 403s
  independently.
-->
<script lang="ts">
  import {
    Button,
    Input,
    Combobox,
    Pill,
    Skeleton,
    EmptyState,
    ErrorState,
    type ComboOption,
  } from '$lib/components/ui';
  import { goto } from '$app/navigation';
  import {
    searchUsers,
    listAppPlans,
    listAllLicenses,
    listTenants,
    listApps,
    listTenantOfferings,
    getTenantSeatCount,
    grantLicense,
    revoke as revokeApi,
    regenerateToken,
    type AppRecord,
    type PlanRecord,
    type LicenseRecord,
    type TenantRecord,
    type TenantOfferingRecord,
    type TenantSeatCount,
    type PersonRecord,
    type GrantResult,
  } from '$lib/api/licenses-admin';
  import {
    appLabel,
    appOptions,
    planOptions,
    tenantOptions,
    personOption,
    formatDate,
    licenseState,
    stateTone,
    filterLicenses,
    offeringsReadback,
    seatCountReadback,
    seatBasisDisclosure,
    offeringProvenance,
    tenantEvidence,
    canAddSeat,
    licensesForTenant,
  } from './page-helpers';
  import EntityRef from '$lib/components/ui/EntityRef.svelte';

  function msgOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  // ---- shared reference data (loaded once) ------------------------------
  let apps = $state<AppRecord[]>([]);
  let tenants = $state<TenantRecord[]>([]);
  let licenses = $state<LicenseRecord[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load() {
    loading = true;
    loadError = null;
    try {
      // listAllLicenses() is NOT tenant-filtered: the table is an estate-wide
      // view of what every tenant holds.
      const [a, t, l] = await Promise.all([
        listApps(),
        listTenants(false, true),
        listAllLicenses(),
      ]);
      apps = a;
      tenants = t;
      licenses = l;
    } catch (e) {
      loadError = msgOf(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  // =======================================================================
  // 1. THE TENANT — the subject of the operation.
  // =======================================================================
  let targetTenant = $state<string | null>(null);

  let offerings = $state<TenantOfferingRecord[] | null>(null);
  let offeringsBusy = $state(false);
  let offeringsError = $state<string | null>(null);

  let seatCount = $state<TenantSeatCount | null>(null);
  let seatBusy = $state(false);
  let seatError = $state<string | null>(null);

  /**
   * Read what the tenant HAS: its provisioned offerings and its seat count.
   *
   * ⛔ The two reads are settled INDEPENDENTLY, not with `Promise.all`. They are
   * different facts from different endpoints, and `all` would let one rejection
   * throw away the other's answer — replacing a known number with "unknown" for
   * no reason, which is the same class of lie as the `0` this page deletes,
   * pointing the other way.
   */
  async function loadTenantFacts(tenantId: string) {
    offeringsBusy = true;
    seatBusy = true;
    offeringsError = null;
    seatError = null;

    const readOfferings = (async () => {
      try {
        offerings = await listTenantOfferings(tenantId);
      } catch (e) {
        // NOT `offerings = []`. An empty list is a real, different answer.
        offerings = null;
        offeringsError = msgOf(e);
      } finally {
        offeringsBusy = false;
      }
    })();

    const readSeats = (async () => {
      try {
        seatCount = await getTenantSeatCount(tenantId);
      } catch (e) {
        // ⛔ NOT `seatCount = 0`. This is billing's denominator; a failed read
        // is UNKNOWN, and rendering zero would assert this tenant is unbilled.
        seatCount = null;
        seatError = msgOf(e);
      } finally {
        seatBusy = false;
      }
    })();

    await Promise.allSettled([readOfferings, readSeats]);
  }

  function onTenantSelect(value: string | null) {
    targetTenant = value;
    // A new subject invalidates everything read about the old one.
    offerings = null;
    offeringsError = null;
    offeringsBusy = false;
    seatCount = null;
    seatError = null;
    seatBusy = false;
    result = null;
    grantError = null;
    if (!value) return;
    void loadTenantFacts(value);
  }

  const seats = $derived(
    seatCountReadback({
      tenantId: targetTenant,
      busy: seatBusy,
      error: seatError,
      count: seatCount,
    }),
  );
  const basis = $derived(seats.kind === 'ok' ? seatBasisDisclosure(seats.count) : null);
  const offers = $derived(
    offeringsReadback({
      tenantId: targetTenant,
      busy: offeringsBusy,
      error: offeringsError,
      offerings,
    }),
  );

  // Only ever non-empty in the `rows` branch — kept as its own derived so the
  // template never has to narrow `offerings` (which is nullable BY DESIGN: null
  // is "we do not know", and must not be collapsed into []).
  const offeringRows = $derived(offers.kind === 'rows' && offerings ? offerings : []);

  const tenantOpts = $derived(tenantOptions(tenants));
  const tenantNameById = $derived(
    Object.fromEntries(tenants.map((t: TenantRecord) => [t.id, t.name])) as Record<string, string>,
  );
  const tenantName = $derived(
    targetTenant ? (tenantNameById[targetTenant] ?? targetTenant) : null,
  );
  // fr's OWN view of the tenant's seat rows, from the unfiltered licence list.
  // Labelled separately on purpose: it is not billing's denominator and the two
  // are allowed to disagree — which is itself worth seeing.
  const visibleSeatRows = $derived(licensesForTenant(licenses, targetTenant));

  // =======================================================================
  // 2. THE PERSON — a seat inside the chosen tenant.
  // =======================================================================
  let selectedPerson = $state<PersonRecord | null>(null);
  let personKnownOptions = $state<Record<string, PersonRecord>>({});
  let lastQuery = $state('');
  let personPickValue = $state<string | null>(null);

  async function loadPersonOptions(q: string): Promise<ComboOption[]> {
    const results = await searchUsers(q);
    // Remember each result so onSelect can recover the full record.
    const map: Record<string, PersonRecord> = {};
    for (const p of results) map[p.id] = p;
    personKnownOptions = { ...personKnownOptions, ...map };
    lastQuery = q;
    return results.map(personOption);
  }

  function onPersonSelect(value: string | null) {
    if (!value) {
      selectedPerson = null;
      return;
    }
    const p = personKnownOptions[value] ?? null;
    selectedPerson = p;
    // ⛔ The person's own tenant attribute NO LONGER sets the target. The tenant
    // was chosen first and deliberately; silently re-pointing the operation at
    // a tenant the operator did not pick is how a seat lands on the wrong bill.
    // It is surfaced as EVIDENCE below instead.
  }

  /**
   * Corroboration, not a precondition. `unknown` is the majority case (most
   * Keycloak users carry no `tenant_id` attribute), so it is rendered and then
   * ignored by `canGrant`.
   */
  const evidence = $derived(tenantEvidence(selectedPerson, targetTenant));

  // ---- seat form --------------------------------------------------------
  let selectedAppId = $state<string | null>(null);
  let selectedPlanId = $state<string | null>(null);
  let expiresAt = $state('');
  let plans = $state<PlanRecord[]>([]);
  let plansLoading = $state(false);
  let granting = $state(false);
  let grantError = $state<string | null>(null);
  let result = $state<GrantResult | null>(null);
  let copied = $state(false);

  const appOpts = $derived(appOptions(apps));
  const planOpts = $derived(planOptions(plans));

  async function onAppChange(value: string | null) {
    selectedPlanId = null;
    plans = [];
    if (!value) return;
    plansLoading = true;
    try {
      plans = await listAppPlans(value);
    } catch (e) {
      grantError = msgOf(e);
    } finally {
      plansLoading = false;
    }
  }

  // TENANT FIRST is enforced in logic, not only in rendering order: `tenantId`
  // is the first term, so a person-first flow cannot produce a submittable form.
  const canGrant = $derived(
    canAddSeat({
      tenantId: targetTenant,
      subjectId: selectedPerson?.id ?? null,
      appId: selectedAppId,
      planId: selectedPlanId,
      busy: granting,
    }),
  );

  async function submitGrant(e: Event) {
    e.preventDefault();
    if (!canGrant || !selectedPerson || !targetTenant) return;
    const tenantId = targetTenant;
    granting = true;
    grantError = null;
    result = null;
    copied = false;
    try {
      result = await grantLicense(
        selectedPerson.id,
        {
          app_id: selectedAppId!,
          plan_id: selectedPlanId!,
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        },
        tenantId,
      );
      await load();
      // The denominator just moved. Re-read it rather than leaving the panel
      // showing the count from before the seat existed.
      await loadTenantFacts(tenantId);
    } catch (err) {
      grantError = msgOf(err);
    } finally {
      granting = false;
    }
  }

  async function copyToken(token: string) {
    await navigator.clipboard.writeText(token);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  /** "Add another seat" — repeatable INSIDE the tenant, so the tenant stays. */
  function resetSeatForm() {
    result = null;
    grantError = null;
    selectedPerson = null;
    personPickValue = null;
    selectedAppId = null;
    selectedPlanId = null;
    expiresAt = '';
    plans = [];
  }

  // No match for the typed query → jump to provision, carrying the email so the
  // operator doesn't retype it. (An email-looking query is prefilled; a name is
  // not, since provision needs a real email.)
  function provisionNew() {
    const q = lastQuery.trim();
    const email = /@/.test(q) ? `?email=${encodeURIComponent(q)}` : '';
    void goto(`/admin/users${email}`);
  }

  // ---- table ------------------------------------------------------------
  let filterQ = $state('');
  let busyId = $state<string | null>(null);
  let rowError = $state<string | null>(null);
  let reissued = $state<{ id: string; token: string } | null>(null);

  const shown = $derived(filterLicenses(licenses, filterQ));

  async function doRevoke(lic: LicenseRecord) {
    // ⛔ Names the TENANT, not a person: the licence belongs to the tenant, and
    // the tenant is who stops being able to use the app.
    const who = tenantNameById[lic.tenant_id] ?? lic.tenant_id;
    if (
      !confirm(
        `Revoke the ${lic.app?.key ?? lic.app_id} license held by ${who}?\n\n` +
          `Every token issued against it stops working immediately. This cannot be undone.`,
      )
    )
      return;
    busyId = lic.id;
    rowError = null;
    try {
      // The LICENSE's tenant — upstream masks a tenant mismatch as a 200 no-op.
      await revokeApi({ license_id: lic.id }, lic.tenant_id);
      await load();
      if (targetTenant) await loadTenantFacts(targetTenant);
    } catch (e) {
      rowError = msgOf(e);
    } finally {
      busyId = null;
    }
  }

  async function doRegenerate(lic: LicenseRecord) {
    if (
      !confirm(
        `Re-issue the token for the ${lic.app?.key ?? lic.app_id} license?\n\n` +
          `The current token stops working immediately. The new one is shown ONCE.`,
      )
    )
      return;
    busyId = lic.id;
    rowError = null;
    reissued = null;
    try {
      const { token } = await regenerateToken(lic.id, lic.tenant_id);
      reissued = { id: lic.id, token };
    } catch (e) {
      rowError = msgOf(e);
    } finally {
      busyId = null;
    }
  }
</script>

<div class="space-y-8" data-testid="licenses-grants-page">
  <!-- Page header (fr#1414): the one h1, named as the rail label and pageTitle.ts. -->
  <header>
    <h1 class="text-xl font-semibold text-[var(--color-text)]">Tenant licenses</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      Seats and offerings per tenant: what each tenant holds and is billed for.
    </p>
  </header>

  <!-- 1. The tenant ------------------------------------------------------ -->
  <section class="space-y-4">
    <header>
      <h2 class="text-lg font-semibold">Seats, by tenant</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        Apps are sold per tenant; seats are minted per person. So pick the tenant
        first — it is what gets billed — then see what it already has, then add
        seats inside it.
      </p>
    </header>

    <div class="max-w-md space-y-1">
      <span class="text-sm font-medium">Tenant</span>
      <Combobox
        bind:value={targetTenant}
        options={tenantOpts}
        onSelect={onTenantSelect}
        placeholder="Search tenants…"
        emptyLabel="Select a tenant…"
        data-testid="tenant-picker"
      />
    </div>

    {#if !targetTenant}
      <div
        class="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]"
        data-testid="tenant-not-selected"
      >
        Select a tenant to see its provisioned offerings and seat count, and to add a seat.
      </div>
    {:else}
      <div class="grid gap-4 lg:grid-cols-2" data-testid="tenant-facts">
        <!-- Seat count — billing's denominator ------------------------- -->
        <div
          class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-2"
        >
          <h3 class="text-sm font-semibold">Seat count</h3>

          {#if seats.kind === 'loading'}
            <div data-testid="tenant-seat-count-loading"><Skeleton class="h-16 w-full" /></div>
          {:else if seats.kind === 'unknown'}
            <!--
              ⛔ THE DEFECT THIS REPLACES: `catch { count = 0 }`. No number is
              rendered in this branch at all — there is nothing true to put here.
            -->
            <div class="space-y-1" data-testid="tenant-seat-count-unknown">
              <Pill tone="warning">unknown</Pill>
              <p class="text-xs text-[var(--color-text-muted)]">
                The seat count could not be read, so it is unknown — not zero. This
                is billing's per-seat denominator; do not treat this tenant as
                unbilled.
              </p>
            </div>
            <p class="text-xs font-mono text-[var(--color-danger-text)]" data-testid="tenant-seat-count-error">
              {seats.message}
            </p>
          {:else if seats.kind === 'ok' && basis}
            <div class="space-y-2" data-testid="tenant-seat-count">
              <div class="flex items-baseline gap-2">
                <span class="text-2xl font-semibold" data-testid="seat-basis-human">
                  {basis.billable}
                </span>
                <span class="text-xs text-[var(--color-text-muted)]">
                  billable basis — human subjects
                </span>
              </div>

              <!--
                ⛔ THE SCOPE, STATED. This panel sits in a two-column grid whose
                neighbour lists PRODUCT NAMES, so an unlabelled figure reads as a
                per-product seat count. It is not one: without `?app=` upstream
                aggregates every app the tenant holds. The label is driven by the
                payload's echoed `app_key`, never by what this page remembers
                asking — see `seatCountScope`.
              -->
              <p
                class="text-xs font-medium text-[var(--color-warning-text)]"
                data-testid="seat-scope"
              >
                {#if basis.scope.kind === 'all_apps'}
                  Counts <strong>all apps</strong> this tenant holds — this is NOT a
                  per-product seat count.
                {:else}
                  Scoped to <code class="font-mono">{basis.scope.appKey}</code> only.
                {/if}
              </p>

              {#if basis.archived}
                <!--
                  A zero here is attributable. An archived tenant's 0 and a live
                  tenant's 0 are different facts with different remedies, and
                  without this they render identically.
                -->
                <p class="text-xs text-[var(--color-warning-text)]" data-testid="seat-tenant-archived">
                  This tenant is <strong>ARCHIVED</strong>, which is why the count reads
                  as it does — it is not evidence that nobody is seated.
                </p>
              {/if}

              <!--
                The disclosure of what was EXCLUDED from that basis. Always
                rendered, zeros included: `human_subjects` is only readable as a
                billable number if the reader can see what is not in it.
              -->
              <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                {#each basis.excluded as x (x.key)}
                  <dt class="text-[var(--color-text-muted)]">{x.label}</dt>
                  <dd class="text-right font-mono" data-testid={`seat-excluded-${x.key}`}>{x.value}</dd>
                {/each}
                <dt class="text-[var(--color-text-muted)]">subjects (all classes)</dt>
                <dd class="text-right font-mono" data-testid="seat-subjects">{basis.subjects}</dd>
                <dt class="text-[var(--color-text-muted)]">licence rows</dt>
                <dd class="text-right font-mono" data-testid="seat-rows">{basis.seats}</dd>
              </dl>

              {#if basis.partitionMismatch}
                <p class="text-xs text-[var(--color-danger-text)]" data-testid="seat-partition-mismatch">
                  {basis.partitionMismatch} — reported as-is, not reconciled here.
                </p>
              {/if}

              <!--
                ⚠️ `period_start`/`period_end` are NOT rendered: fr requests no
                period and the backend deliberately exposes none, so they are
                always null. The old line printed "period — → —" on every tenant,
                which dresses an unrequested window up as an empty one. `as_of`
                is the timestamp that actually exists.
              -->
              <p class="text-xs text-[var(--color-text-muted)]">
                basis <code class="font-mono">{seats.count.basis ?? 'unstated'}</code>
                {#if seats.count.as_of}· evaluated {formatDate(seats.count.as_of)}{/if}
              </p>
              <p class="text-xs text-[var(--color-text-muted)]" data-testid="seat-rows-visible">
                This console can see {visibleSeatRows.length} licence row{visibleSeatRows.length === 1
                  ? ''
                  : 's'} for this tenant. That is fr's own view, not billing's count —
                they are allowed to differ.
              </p>
            </div>
          {/if}
        </div>

        <!-- Provisioned offerings ------------------------------------- -->
        <div
          class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-2"
        >
          <h3 class="text-sm font-semibold">Provisioned offerings</h3>

          {#if offers.kind === 'loading'}
            <div data-testid="tenant-offerings-loading"><Skeleton class="h-16 w-full" /></div>
          {:else if offers.kind === 'error'}
            <!--
              ⛔ NOT "no offerings". An unreadable list says nothing about what
              this tenant is entitled to.
            -->
            <div class="space-y-1" data-testid="tenant-offerings-unknown">
              <Pill tone="warning">unknown</Pill>
              <p class="text-xs text-[var(--color-text-muted)]">
                What this tenant has been provisioned could not be read, so it is
                unknown — this is not evidence that it has nothing.
              </p>
              <p class="text-xs font-mono text-[var(--color-danger-text)]">{offers.message}</p>
            </div>
          {:else if offers.kind === 'empty'}
            <!-- A REAL, different answer: read successfully, nothing there. -->
            <div class="space-y-1" data-testid="tenant-offerings-none">
              <Pill tone="neutral">none provisioned</Pill>
              <p class="text-xs text-[var(--color-text-muted)]">
                Read successfully: this tenant has no per-product offerings. Every
                product resolves to its tenant-wide BYO posture instead.
              </p>
            </div>
          {:else if offers.kind === 'rows'}
            <ul class="space-y-1 text-sm" data-testid="tenant-offerings-rows">
              {#each offeringRows as o (o.app_key)}
                {@const prov = offeringProvenance(o)}
                <li class="flex flex-wrap items-center gap-2" data-testid="tenant-offering-row">
                  <span class="font-medium">{o.app_name || o.app_key}</span>
                  <Pill tone="neutral">{o.byo_mode}</Pill>
                  {#if prov.known}
                    <code class="font-mono text-xs" data-testid="offering-provenance-code">{prov.code}</code>
                  {:else}
                    <!--
                      ⛔ `offering_code: null` is PROVENANCE UNKNOWN, not absence:
                      the posture was set directly, or predates licences
                      migration 025, which could not backfill it. A blank cell
                      here would read as "nothing provisioned" about a row that
                      demonstrably IS.
                    -->
                    <span
                      class="text-xs text-[var(--color-text-muted)] italic"
                      title="This posture is provisioned; which offering produced it was never recorded."
                      data-testid="offering-provenance-unknown">provenance unknown</span
                    >
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}

          <p class="text-xs text-[var(--color-text-muted)]" data-testid="provision-note">
            Provisioning is done on the offerings screen, not here — and two things
            about it are worth knowing before you go: it <strong>403s until the
            caller holds <code class="font-mono">pricing-writer</code></strong>, and
            its rollback is <strong>PARTIAL</strong> — if the access-charge write
            fails, the billing markup rule it already created stays behind, because
            billing exposes no DELETE for it.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onclick={() => void goto('/admin/licenses/offerings')}
          >
            Manage offerings →
          </Button>
        </div>
      </div>

      <!-- 2. Add a seat, inside this tenant --------------------------- -->
      <div class="space-y-4 border-t border-[var(--color-border)] pt-4" data-testid="seat-section">
        <header class="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 class="text-base font-semibold">
              Add a seat to <span class="font-mono">{tenantName}</span>
            </h3>
            <p class="text-sm text-[var(--color-text-muted)]">
              A seat is a person. Pick who, and the app and plan it is for — the
              tenant above is what gets billed for it.
            </p>
          </div>
          <Button variant="secondary" size="sm" onclick={provisionNew}>
            Provision new user →
          </Button>
        </header>

        {#if result}
          <div
            class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3"
            data-testid="grant-result"
          >
            <div class="flex items-center gap-2">
              {#if result.token_error}
                <Pill tone="warning">Partially complete</Pill>
              {:else}
                <Pill tone="success">Seat added</Pill>
              {/if}
              <span class="text-sm text-[var(--color-text-muted)]">
                license <code class="font-mono">{result.license.id}</code>
              </span>
            </div>

            {#if result.token_error}
              <p class="text-sm text-[var(--color-danger-text)]" data-testid="grant-token-error">
                The license was created, but issuing its token failed:
                <span class="font-mono">{result.token_error}</span><br />
                The license is unusable until a token exists — use “Re-issue token” on
                its row below.
              </p>
            {:else if result.token}
              <div class="space-y-1">
                <p class="text-xs text-[var(--color-text-muted)]">
                  Shown once — stored only as a hash, never retrievable again.
                </p>
                <div class="flex items-center gap-2">
                  <code
                    class="flex-1 break-all rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] p-2 font-mono text-xs"
                    data-testid="grant-token">{result.token}</code
                  >
                  <Button size="sm" onclick={() => copyToken(result!.token!)}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
            {/if}

            <Button variant="secondary" size="sm" onclick={resetSeatForm}>
              Add another seat to {tenantName}
            </Button>
          </div>
        {:else}
          <form class="grid gap-4 sm:grid-cols-2 max-w-3xl" onsubmit={submitGrant} data-testid="seat-form">
            <div class="space-y-1 sm:col-span-2">
              <span class="text-sm font-medium">Person</span>
              <Combobox
                bind:value={personPickValue}
                loadOptions={loadPersonOptions}
                onSelect={onPersonSelect}
                placeholder="Search by email or name…"
                emptyLabel="Search for a person…"
                data-testid="person-picker"
              />
              {#if selectedPerson}
                <span class="block text-xs text-[var(--color-text-muted)]" data-testid="person-selected">
                  {selectedPerson.name}{selectedPerson.email ? ` · ${selectedPerson.email}` : ''}
                </span>

                <!--
                  Tenant evidence: DISCLOSURE, never a gate. Most Keycloak users
                  carry no `tenant_id` attribute, so blocking on its absence
                  would deny the majority of legitimate grants.
                -->
                {#if evidence.kind === 'unknown'}
                  <span class="block text-xs text-[var(--color-text-muted)]" data-testid="seat-tenant-evidence-unknown">
                    This person's own tenant is not recorded in Keycloak, so there is
                    nothing to corroborate the target with. That is normal and does
                    not block the grant — the tenant you picked is what is used.
                  </span>
                {:else if evidence.kind === 'mismatch'}
                  <span class="block text-xs text-[var(--color-warning-text)]" data-testid="seat-tenant-evidence-mismatch">
                    Heads up: this person's own tenant is
                    <code class="font-mono"
                      >{tenantNameById[evidence.personTenantId] ?? evidence.personTenantId}</code
                    >, not the one selected. The seat is billed to the SELECTED tenant.
                  </span>
                {:else if evidence.kind === 'match'}
                  <span class="block text-xs text-[var(--color-text-muted)]" data-testid="seat-tenant-evidence-match">
                    This person's own tenant matches the target.
                  </span>
                {/if}
              {:else if lastQuery.length >= 2}
                <button
                  type="button"
                  class="text-xs text-[var(--color-accent-text)] underline"
                  onclick={provisionNew}
                  data-testid="no-match-provision"
                >
                  No account for “{lastQuery}” — provision a new user
                </button>
              {/if}
            </div>

            <div class="space-y-1">
              <span class="text-sm font-medium">App</span>
              <Combobox
                bind:value={selectedAppId}
                options={appOpts}
                onSelect={onAppChange}
                placeholder="Search apps…"
                emptyLabel="Select an app…"
                data-testid="app-picker"
              />
            </div>

            <div class="space-y-1">
              <span class="text-sm font-medium">Plan</span>
              <Combobox
                bind:value={selectedPlanId}
                options={planOpts}
                placeholder="Search plans…"
                emptyLabel={plansLoading
                  ? 'Loading plans…'
                  : selectedAppId
                    ? planOpts.length
                      ? 'Select a plan…'
                      : 'No live plans for this app'
                    : 'Pick an app first'}
                disabled={!selectedAppId || plansLoading}
                data-testid="plan-picker"
              />
            </div>

            <div class="space-y-1 sm:col-span-2">
              <span class="text-sm font-medium">Expires</span>
              <Input
                type="text"
                bind:value={expiresAt}
                placeholder="YYYY-MM-DDTHH:MM (blank = perpetual)"
              />
            </div>

            <div class="sm:col-span-2 flex items-center gap-3">
              <!--
                ⚠️ The testid sits on this WRAPPER, not on <Button>. `Button.svelte`
                destructures a CLOSED prop set (variant/size/type/disabled/onclick/
                children/class) with no rest-spread, so a `data-testid` handed to it
                is silently DROPPED and never reaches the DOM — unlike `Combobox`,
                which declares the prop explicitly. Nothing warns about this: the
                button renders perfectly and only the hook vanishes.

                The submit is rendered as soon as a TENANT is chosen and merely
                DISABLED until a person/app/plan are, so that "this tenant can take
                seats" and "a person has been chosen" stay two separately visible
                facts. Tests must therefore read the inner <button>'s `disabled`,
                never the wrapper's.
              -->
              <span data-testid="add-seat-submit">
                <Button type="submit" variant="primary" disabled={!canGrant}>
                  {granting ? 'Adding seat…' : 'Add seat'}
                </Button>
              </span>
              {#if grantError}
                <span class="text-sm text-[var(--color-danger-text)]" data-testid="grant-error">
                  {grantError}
                </span>
              {/if}
            </div>
          </form>
        {/if}
      </div>
    {/if}
  </section>

  <!-- Existing licenses -------------------------------------------------- -->
  <section class="space-y-4">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">Licenses</h2>
        <p class="text-sm text-[var(--color-text-muted)]">
          Every license on the platform. Status is resolved against the clock, so an
          expired license reads “expired” even if its stored status still says active.
        </p>
      </div>
      <Input bind:value={filterQ} type="search" placeholder="Filter app, plan, person, tenant…" />
    </header>

    {#if reissued}
      <div
        class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-1"
        data-testid="reissued-token"
      >
        <p class="text-xs text-[var(--color-text-muted)]">
          New token for <code class="font-mono">{reissued.id}</code> — shown once.
        </p>
        <div class="flex items-center gap-2">
          <code class="flex-1 break-all rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] p-2 font-mono text-xs">
            {reissued.token}
          </code>
          <Button size="sm" onclick={() => copyToken(reissued!.token)}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button size="sm" variant="ghost" onclick={() => (reissued = null)}>Dismiss</Button>
        </div>
      </div>
    {/if}

    {#if rowError}
      <p class="text-sm text-[var(--color-danger-text)]">{rowError}</p>
    {/if}

    {#if loading}
      <div class="space-y-2">
        {#each Array(4) as _, i (i)}<Skeleton class="h-10 w-full" />{/each}
      </div>
    {:else if loadError}
      <ErrorState error={loadError} onRetry={load} />
    {:else if shown.length === 0}
      <EmptyState
        title={filterQ ? 'No licenses match that filter' : 'No licenses yet'}
        body={filterQ
          ? 'Clear the filter to see the full list.'
          : 'Pick a tenant above and add a seat to get started.'}
      />
    {:else}
      <div class="overflow-x-auto">
        <!--
          ⛔ `min-w-max` IS THE HALF THAT MAKES THE WRAPPER ABOVE REAL, and its
          absence left an inert scroll container. A table is
          reachable IFF (1) it sits in a horizontally scrolling box AND (2) it is
          allowed to grow wider than that box — and "(1) without (2) is a wrapper
          that can never fire". `w-full` alone is (1) without (2): the table
          compresses to the container instead of overflowing it, so the scroll
          container is decoration.
          ⇒ What that inertness actually cost: when the tenant-first layout
          widened the leading cells, the squeeze landed on the actions column and
          "Re-issue token" wrapped to three lines and bled across the row
          separators on ALL 297 rows. The guard had recorded the cause; the
          baseline suppressed it; the visible defect shipped anyway and was found
          by driving production in a real browser.
        -->
        <table class="w-full min-w-max text-sm">
          <thead class="text-left text-[var(--color-text-muted)]">
            <tr class="border-b border-[var(--color-border)]">
              <th class="py-2 pr-3 font-medium">Tenant</th>
              <th class="py-2 pr-3 font-medium">App</th>
              <th class="py-2 pr-3 font-medium">Plan</th>
              <th class="py-2 pr-3 font-medium">State</th>
              <th class="py-2 pr-3 font-medium">Expires</th>
              <th class="py-2 font-medium"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each shown as lic (lic.id)}
              {@const state = licenseState(lic)}
              <tr class="border-b border-[var(--color-border)]" data-testid="license-row">
                <!-- The tenant leads the row and is the only party named in it:
                     a licence is what a TENANT holds. -->
                <td class="py-2 pr-3">
                  <EntityRef id={lic.tenant_id} name={tenantNameById[lic.tenant_id] ?? null} kind="tenant" />
                </td>
                <!--
                  The app cell used to print `app.key ?? app_id` — a bare key,
                  or a raw uuid whenever the join came back empty. `AppInfo.name`
                  is in the payload; appLabel() is the same label the app picker
                  above shows, so the table and the picker now agree.
                -->
                <td class="py-2 pr-3">
                  <EntityRef id={lic.app_id} name={lic.app ? appLabel(lic.app) : null} kind="app" />
                </td>
                <td class="py-2 pr-3">{lic.plan?.code ?? '—'}</td>
                <td class="py-2 pr-3"><Pill tone={stateTone(state)}>{state}</Pill></td>
                <td class="py-2 pr-3">{formatDate(lic.expires_at)}</td>
                <!--
                  ⚠️ `whitespace-nowrap` is LOAD-BEARING, not cosmetic polish.
                  Tenant-first widened the leading cells (EntityRef now renders a
                  name AND an id stub where the old cells held one short string),
                  which squeezed this column until "Re-issue token" wrapped to
                  three lines and bled across the row separators — on all 297
                  rows, found by driving production in a real browser, invisible
                  to every mount() test we have.
                  The enclosing wrapper is `overflow-x-auto`, so claiming the
                  width we need costs a horizontal scroll, never a broken row.
                -->
                <td class="whitespace-nowrap py-2">
                  <div class="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === lic.id}
                      onclick={() => doRegenerate(lic)}
                    >
                      Re-issue token
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busyId === lic.id || state === 'revoked'}
                      onclick={() => doRevoke(lic)}
                    >
                      {busyId === lic.id ? '…' : 'Revoke'}
                    </Button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>
