<!--
  /admin/pricing — super-admin pricing management.

  Lists and upserts billing-service provider_pricing rows and markup_rules via
  the fr backend proxy (/api/admin/pricing/*). Replaces the old "POST from
  inside a billing pod" seeding. A POST is an upsert: billing closes the prior
  open row for the match-tuple and opens a new effective-dated one.

  Auth: in-component $effect gate on /api/me/super-admin (after auth hydrates),
  mirroring the provision-user page. The fr backend is the source of truth.
-->
<script lang="ts">
  import { toast } from '$lib/stores/toast.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    getSuperAdminStatus,
  } from '$lib/api/super-admin';
  import {
    listProviderPricing,
    upsertProviderPricing,
    listMarkupRules,
    upsertMarkupRule,
    listAccessCharges,
    upsertAccessCharge,
    getTenantConfig,
    putTenantConfig,
    getMarkupConfig,
    hasEconomicField,
    type ProviderPricingRow,
    type ProviderPricingInput,
    type MarkupRuleRow,
    type MarkupRuleInput,
    type AccessChargeRow,
    type AccessChargeInput,
    type AccessCadence,
    type TenantConfigInput,
    type BillingMode,
  } from '$lib/api/pricing-admin';
  // Tenants are not part of the pricing API — billing only ever knows the uuid.
  // The names come from the licences edge, the same source the licences and
  // tenant-budget consoles use, so one tenant reads identically everywhere.
  import { listTenants, type TenantRecord } from '$lib/api/licenses-admin';
  // The house rule for a degraded read: keep the REASON. Nothing in it is
  // asset-workspace specific — after a 403 "retry" is advice that cannot work,
  // after a 502 it is advice that will, and only the reason tells them apart.
  import { readFailureReason } from '$lib/asset-workspace/scopeRefs';
  import { tenantOptions } from '../licenses/page-helpers';
  // Every money/rate column below is a Postgres NUMERIC handed over the wire as
  // a STRING (see ProviderPricingRow: "billing schema, passed through
  // verbatim"). Python's `str(Decimal)` emits `0E-8` for a NUMERIC(_,8) zero,
  // and ~40 live rows rendered that raw into "Output $/1M". Route every such
  // cell through the formatter — it expands the exponent, drops trailing zeros,
  // never rounds, and passes anything unparseable through so bad data stays
  // visible rather than being laundered into a placeholder.
  import { formatDecimal } from '$lib/utils/decimal';
  import { Combobox } from '$lib/components/ui';
  import FxRateCard from '$lib/components/pricing/FxRateCard.svelte';
  import EntityRef from '$lib/components/ui/EntityRef.svelte';
  import { shortId } from '$lib/utils/shortId';

  // --- Gate ----------------------------------------------------------------
  type GateState = 'pending' | 'allowed' | 'denied';
  let gate = $state<GateState>('pending');
  let gateProbeStarted = false;
  $effect(() => {
    if (gateProbeStarted) return;
    if (auth.isLoading) return;
    gateProbeStarted = true;
    void (async () => {
      try {
        const { is_super_admin } = await getSuperAdminStatus();
        gate = is_super_admin ? 'allowed' : 'denied';
        if (gate === 'allowed') void loadAll();
      } catch {
        gate = 'denied';
      }
    })();
  });

  // An error toast on this page carries a validation message the operator has
  // to READ and act on; the store's 5000 ms default dismissed it before that
  // was possible (observed live 2026-08-11 — the message had to be re-triggered
  // and captured within 1.5 s). Successes keep the default.
  const ERROR_TOAST_MS = 20000;

  // --- Data ----------------------------------------------------------------
  let pricing = $state<ProviderPricingRow[]>([]);
  let markups = $state<MarkupRuleRow[]>([]);
  let accessCharges = $state<AccessChargeRow[]>([]);
  // The markup billing applies when NO rule matches.
  let defaultMarkupPct = $state<number | null>(null);
  // ...and WHY it is null, when it is null because the read failed.
  //
  // `defaultMarkupPct = null` is two facts wearing one value: "billing has no
  // platform default" and "we could not find out". The template gated the whole
  // sentence on `!== null`, so a failed read simply DELETED it — on a page about
  // money, beside an empty rules table whose remaining copy ("No markup rules.")
  // then reads as "nothing is being marked up". Production runs with zero open
  // rules and a live default, so that reading is not merely vague, it is wrong.
  //
  // ⚠️ Three states, not two: null here means NO FAILURE WAS RECORDED. It never
  // asserts that the read succeeded, so nothing may branch on its falsiness as
  // proof of a good read — the value branch below tests `defaultMarkupPct`
  // positively instead.
  let defaultMarkupUnreadable = $state<string | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  // Tenants, for names + pickers. Never a hard dependency of this page: see
  // loadAll(). Empty simply means every tenant renders as a short id stub.
  let tenants = $state<TenantRecord[]>([]);
  // ...but empty is NOT the same as unreadable, and the difference lands on
  // money. `tenants` feeds three Comboboxes; with zero options the markup-rule
  // picker's only reachable state is its emptyLabel, "All tenants (global
  // rule)". A failed directory read would therefore steer an operator into
  // writing a FLEET-WIDE markup while the screen looked as if no tenants
  // existed. The two access-charge/config pickers degrade to "Select a
  // tenant…", which reads as "this platform has no tenants". Recording the
  // failure lets every picker say the list is incomplete.
  let tenantsError = $state<string | null>(null);
  const tenantOpts = $derived(tenantOptions(tenants));
  const tenantNameById = $derived(
    Object.fromEntries(tenants.map((t: TenantRecord) => [t.id, t.name])) as Record<string, string>,
  );

  /**
   * Tenant display for plain-string contexts (toasts). Never a bare uuid.
   *
   * `<EntityRef>` cannot go here — a toast takes a string, not a component — so
   * the stub comes from the same `shortId` EntityRef uses, which keeps the toast
   * and the table cell rendering the SAME characters (fr#1205). TAIL 8, leading
   * ellipsis: the leading-8 was ambiguous across a provisioning batch (fr#1203).
   */
  function tenantName(id: string): string {
    return tenantNameById[id] ?? shortId(id);
  }

  /** Combobox writes null on clear; every tenant_id field here is a string. */
  function setMarkupTenant(value: string | null): void {
    if (mForm) mForm.tenant_id = value ?? '';
  }
  function setAccessTenant(value: string | null): void {
    if (acForm) acForm.tenant_id = value ?? '';
  }

  async function loadAll(): Promise<void> {
    loading = true;
    loadError = null;
    tenantsError = null;
    // Cleared per load, not per success: a Refresh that fails must not inherit
    // the previous run's verdict in either direction.
    defaultMarkupUnreadable = null;
    // Fetched alongside, not inside, the Promise.all — same reasoning as the
    // markup default below: an unreachable tenant list must not blank the three
    // tables that did load. Without names the page degrades to short id stubs,
    // which is a worse view, not a broken one.
    void (async () => {
      try {
        // Name map for billing-config rows that are not tenant-filtered;
        // filtered, service tenants degrade to a truncated UUID.
        tenants = await listTenants(false, true);
        tenantsError = null;
      } catch (e) {
        tenants = [];
        tenantsError = e instanceof Error ? e.message : String(e);
      }
    })();
    // Fetched alongside, not inside, the Promise.all: an unavailable default
    // must not blank the three tables that did load.
    void getMarkupConfig()
      .then((cfg) => {
        defaultMarkupPct = typeof cfg.default_markup_pct === 'number' ? cfg.default_markup_pct : null;
        // A resolved read that carried no number IS a genuine "unset" — record
        // no failure, so the page may say so.
        defaultMarkupUnreadable = null;
      })
      .catch((e) => {
        defaultMarkupPct = null;
        // The fallback names the READ, not the error — a throw with no message
        // must still leave the admin something they can report.
        defaultMarkupUnreadable = readFailureReason(
          e,
          'The markup-config read failed without a message.',
        );
      });
    try {
      [pricing, markups, accessCharges] = await Promise.all([
        listProviderPricing(),
        listMarkupRules(),
        listAccessCharges(),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadError = msg;
      toast.error(`Failed to load pricing: ${msg}`, ERROR_TOAST_MS);
    } finally {
      loading = false;
    }
  }

  const COST_MODELS = ['per_token', 'per_request', 'self_hosted_amortized'] as const;

  function blankPricing(): ProviderPricingInput {
    return {
      provider: '',
      model: '',
      service_key: '',
      rate_class: 'cost',
      cost_model: 'per_token',
      input_per_1m_usd: '',
      output_per_1m_usd: '',
      per_request_usd: '',
      notes: '',
    };
  }

  // --- Provider-pricing form ----------------------------------------------
  let pForm = $state<ProviderPricingInput | null>(null);
  let pSaving = $state(false);

  function newPricing(): void {
    pForm = blankPricing();
  }
  function editPricing(row: ProviderPricingRow): void {
    pForm = {
      provider: row.provider,
      model: row.model ?? '',
      service_key: row.service_key ?? '',
      rate_class: row.rate_class === 'list' ? 'list' : 'cost',
      cost_model: row.cost_model,
      input_per_1m_usd: row.input_per_1m_usd ?? '',
      output_per_1m_usd: row.output_per_1m_usd ?? '',
      per_request_usd: row.per_request_usd ?? '',
      notes: row.notes ?? '',
    };
  }
  function cancelPricing(): void {
    pForm = null;
  }

  // Empty strings → omit (so the field is NULL/unchanged upstream). The
  // (provider, model, service_key) match-tuple decides which open row is
  // superseded; an empty model/service_key means the provider-default row.
  function clean(input: ProviderPricingInput): ProviderPricingInput {
    const out: ProviderPricingInput = {
      provider: input.provider.trim(),
      rate_class: input.rate_class === 'list' ? 'list' : 'cost',
      cost_model: input.cost_model,
    };
    const opt = (v: string | null | undefined) => (v && String(v).trim() !== '' ? String(v).trim() : undefined);
    out.model = opt(input.model) ?? null;
    out.service_key = opt(input.service_key) ?? null;
    out.input_per_1m_usd = opt(input.input_per_1m_usd) ?? null;
    out.output_per_1m_usd = opt(input.output_per_1m_usd) ?? null;
    out.per_request_usd = opt(input.per_request_usd) ?? null;
    out.notes = opt(input.notes) ?? null;
    return out;
  }

  async function savePricing(): Promise<void> {
    if (!pForm) return;
    if (!pForm.provider.trim()) {
      toast.error('Provider is required', ERROR_TOAST_MS);
      return;
    }
    pSaving = true;
    try {
      const row = await upsertProviderPricing(clean(pForm));
      toast.success(`Saved pricing for ${row.provider}/${row.model ?? '<default>'} (id ${row.id})`);
      pForm = null;
      await loadAll();
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`, ERROR_TOAST_MS);
    } finally {
      pSaving = false;
    }
  }

  // --- Markup-rule form ----------------------------------------------------
  let mForm = $state<MarkupRuleInput | null>(null);
  let mSaving = $state(false);

  function newMarkup(): void {
    mForm = { provider: '', model: '', service_key: '', tenant_id: '', markup_pct: '', notes: '' };
  }
  function editMarkup(row: MarkupRuleRow): void {
    mForm = {
      tenant_id: row.tenant_id ?? '',
      provider: row.provider ?? '',
      model: row.model ?? '',
      service_key: row.service_key ?? '',
      markup_pct: row.markup_pct ?? '',
      surcharge_input_per_1m_usd: row.surcharge_input_per_1m_usd ?? '',
      surcharge_output_per_1m_usd: row.surcharge_output_per_1m_usd ?? '',
      notes: row.notes ?? '',
    };
  }
  function cancelMarkup(): void {
    mForm = null;
  }
  function cleanMarkup(input: MarkupRuleInput): MarkupRuleInput {
    const opt = (v: string | null | undefined) => (v && String(v).trim() !== '' ? String(v).trim() : null);
    return {
      tenant_id: opt(input.tenant_id),
      provider: opt(input.provider),
      model: opt(input.model),
      service_key: opt(input.service_key),
      markup_pct: opt(input.markup_pct),
      surcharge_input_per_1m_usd: opt(input.surcharge_input_per_1m_usd),
      surcharge_output_per_1m_usd: opt(input.surcharge_output_per_1m_usd),
      notes: opt(input.notes),
    };
  }
  // --- Scope of the rule being written -------------------------------------
  //
  // A markup rule with no tenant is GLOBAL: it prices EVERY tenant. That is a
  // legitimate configuration, so it must stay reachable — but it is the single
  // most consequential thing this form can write, and fr cannot undo it: the
  // product publishes GET + POST on markup-rules and no delete, so the only
  // correction available here is another rule that supersedes it.
  //
  // ⚠️ Two different unknowns used to be warned about and then permitted:
  //   tenantsError            — the operator cannot SEE the alternatives.
  //   defaultMarkupUnreadable — the operator cannot see the BASELINE this rule
  //                             is being added on top of.
  // They get different treatment below, because they are different failures:
  // the first makes the choice unknowable (refuse), the second makes the
  // consequence unknown (confirm). Neither is a banner any more.
  const markupIsGlobal = $derived(mForm !== null && String(mForm.tenant_id ?? '').trim() === '');
  /** A global rule while the directory is unreadable: not offered at all. */
  const markupGlobalUnknowable = $derived(markupIsGlobal && tenantsError !== null);

  /**
   * The house confirmation mechanism for an irreversible admin action.
   *
   * fr has NO shared confirm component — `$lib/components/ui` exports a generic
   * `Dialog`, and nothing wraps it as a yes/no gate; every irreversible admin
   * action in this route group uses the browser's own `confirm()`, including the
   * sibling (platform)/licenses page's revoke and re-issue. This follows that.
   *
   * ⛔ It fails CLOSED where `routes/settings/licenses/page-helpers.ts` defaults
   * to `true` when `confirm` is missing. That default is defensible for a token
   * regeneration a user asks for about themselves; it is not defensible for a
   * write that prices every tenant and cannot be withdrawn. No dialog ⇒ no save.
   */
  function confirmIrreversible(message: string): boolean {
    const fn = (globalThis as { confirm?: (m: string) => boolean }).confirm;
    if (typeof fn !== 'function') return false;
    return fn(message);
  }

  async function saveMarkup(): Promise<void> {
    if (!mForm) return;
    // newMarkup() seeds every field to '' and cleanMarkup() maps '' → null, so
    // an untouched form POSTs an all-null rule straight into billing's 422.
    // Markup % is the only economic field this form exposes for a new rule.
    if (!hasEconomicField(mForm)) {
      toast.error('Markup % is required — a rule with no markup or surcharge would price nothing', ERROR_TOAST_MS);
      return;
    }

    // ⛔ REFUSE — and deliberately do NOT offer the confirmation. A confirmation
    // asks the operator to accept a consequence; this one would ask them to
    // choose between alternatives the screen cannot show them, because the
    // picker's only reachable state with an empty directory is literally "All
    // tenants (global rule)". "Every tenant" is not a choice they made here.
    if (markupGlobalUnknowable) {
      toast.error(
        'Not saved. This rule names no tenant, so it would price EVERY tenant — and the ' +
          'tenant directory could not be read, so the picker cannot show you which tenants ' +
          'that is. Refresh until the directory loads, then either pick a tenant or save a ' +
          'global rule deliberately.',
        ERROR_TOAST_MS,
      );
      return;
    }

    // Everything the operator is being asked to accept, in one dialog.
    const acknowledgements: string[] = [];
    if (markupIsGlobal) {
      acknowledgements.push(
        'Save a GLOBAL markup rule?\n\n' +
          'It names no tenant, so it applies to EVERY tenant on the platform — only the ' +
          'provider / model / service-key fields narrow it.\n\n' +
          'fr cannot delete a markup rule: this page can only supersede it with another ' +
          'rule for the same provider / model / service key.',
      );
    }
    if (defaultMarkupUnreadable !== null) {
      // The sibling advisory's own wrong action ("do not add a rule to 'restore'
      // a default you have not seen") applies at any scope, so this is asked for
      // a tenant-scoped rule too — but it only ever CONFIRMS. Blocking a narrow
      // write because a platform-wide number could not be read would be the
      // over-broad mirror of the defect above.
      acknowledgements.push(
        'The platform default markup could not be read, so what this usage is charged ' +
          'today is unknown — this rule is not known to be restoring or replacing anything. ' +
          'Save it anyway?',
      );
    }
    if (acknowledgements.length > 0 && !confirmIrreversible(acknowledgements.join('\n\n———\n\n'))) {
      return;
    }

    mSaving = true;
    try {
      const row = await upsertMarkupRule({
        ...cleanMarkup(mForm),
        // fr's own field, not billing's: the route refuses a tenant-less rule
        // that does not carry it, and strips it before the billing hop. Sent
        // only when global — the route rejects the pair as a contradiction.
        ...(markupIsGlobal ? { global_scope_acknowledged: true as const } : {}),
      });
      toast.success(`Saved markup rule (id ${row.id})`);
      mForm = null;
      await loadAll();
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`, ERROR_TOAST_MS);
    } finally {
      mSaving = false;
    }
  }

  // --- Access-charge form (the ACCESS-billing axis) ------------------------
  const ACCESS_CADENCES: AccessCadence[] = ['monthly', 'one_time'];
  let acForm = $state<AccessChargeInput | null>(null);
  let acSaving = $state(false);

  function newAccessCharge(): void {
    acForm = {
      tenant_id: '',
      service_key: '',
      amount_usd: '',
      cadence: 'monthly',
      included_cost_usd: '',
      notes: '',
    };
  }
  function editAccessCharge(row: AccessChargeRow): void {
    acForm = {
      tenant_id: row.tenant_id,
      service_key: row.service_key ?? '',
      amount_usd: row.amount_usd,
      cadence: row.cadence === 'one_time' ? 'one_time' : 'monthly',
      included_cost_usd: row.included_cost_usd ?? '',
      notes: row.notes ?? '',
    };
  }
  function cancelAccessCharge(): void {
    acForm = null;
  }
  function cleanAccessCharge(input: AccessChargeInput): AccessChargeInput {
    const opt = (v: string | null | undefined) =>
      v && String(v).trim() !== '' ? String(v).trim() : undefined;
    return {
      tenant_id: input.tenant_id.trim(),
      // Empty service_key = a tenant-wide charge (NULL upstream).
      service_key: opt(input.service_key) ?? null,
      amount_usd: input.amount_usd.trim(),
      cadence: input.cadence === 'one_time' ? 'one_time' : 'monthly',
      // Empty allowance = no credit (NULL upstream).
      included_cost_usd: opt(input.included_cost_usd) ?? null,
      notes: opt(input.notes) ?? null,
    };
  }
  async function saveAccessCharge(): Promise<void> {
    if (!acForm) return;
    if (!acForm.tenant_id.trim()) {
      toast.error('Select a tenant first', ERROR_TOAST_MS);
      return;
    }
    if (!acForm.amount_usd.trim()) {
      toast.error('Amount (USD) is required', ERROR_TOAST_MS);
      return;
    }
    acSaving = true;
    try {
      const row = await upsertAccessCharge(cleanAccessCharge(acForm));
      toast.success(`Saved access charge (id ${row.id})`);
      acForm = null;
      await loadAll();
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`, ERROR_TOAST_MS);
    } finally {
      acSaving = false;
    }
  }

  // --- Tenant billing mode -------------------------------------------------
  const BILLING_MODES: BillingMode[] = ['standard_markup', 'byo_platform_fee', 'pass_through'];
  let tTenantId = $state('');
  let tForm = $state<TenantConfigInput | null>(null);
  /**
   * ⭐ THE TENANT THIS FORM'S VALUES ACTUALLY CAME FROM. `''` = nothing loaded.
   *
   * ⛔ THIS EXISTS BECAUSE THE FORM AND THE TARGET WERE TWO INDEPENDENT PIECES OF
   * STATE ON A PAGE THAT WRITES BILLING. `tForm` was assigned ONLY inside
   * `loadTenantConfig()` and never cleared, the form block renders on `{#if
   * tForm}`, and `saveTenantConfig()` PUT to `tTenantId.trim()` — so: load tenant
   * A, change the Combobox to tenant B, press Save, and A's `billing_mode`,
   * `markup_pct` and `notes` were written onto B. Nothing on screen changed
   * between the two states, so the operator had no way to see it: the same three
   * values they had just read sat there looking like B's.
   *
   * ⚠️ A SECOND VARIABLE, NOT A GUARD INSIDE `saveTenantConfig`. A save-time
   * refusal alone still leaves A's numbers rendered under B's name — the operator
   * READS them as B's configuration long before they press anything, and that
   * misreading is the durable half of the defect. This value is what lets the
   * form be cleared on selection change AND the save be refused, which are two
   * different failures and both are closed below.
   *
   * ⚠️ NOT derived from `tTenantId`. It records where the BYTES came from; a
   * derivation would follow the picker and could never disagree with it, which
   * is precisely the disagreement that has to be detectable.
   */
  let tLoadedFor = $state('');
  let tSaving = $state(false);
  let tLoading = $state(false);

  /**
   * Combobox writes null on clear. Changing the selection DISCARDS the loaded
   * form — it belongs to the previous tenant and nothing about it is valid for
   * the new one.
   *
   * The page's own convention for a stale read is to drop it and make the
   * operator re-read (`loadAll()` clears `defaultMarkupUnreadable` per load, "not
   * per success: a Refresh that fails must not inherit the previous run's
   * verdict"). Same reasoning: a form nobody re-loaded must not inherit the
   * previous tenant's numbers.
   *
   * ⚠️ Guarded on a real CHANGE. Re-picking the same tenant from the Combobox
   * must not throw away the config the operator is part-way through editing.
   */
  function setTenantConfigTenant(value: string | null): void {
    const next = value ?? '';
    if (next === tTenantId) return;
    tTenantId = next;
    tForm = null;
    tLoadedFor = '';
  }

  async function loadTenantConfig(): Promise<void> {
    const id = tTenantId.trim();
    if (!id) {
      toast.error('Select a tenant first', ERROR_TOAST_MS);
      return;
    }
    tLoading = true;
    // Dropped BEFORE the await, not in the catch. An in-flight load has already
    // invalidated whatever is on screen, and a failure that left the previous
    // tenant's form standing would put us straight back in the defect — with the
    // operator now believing they had just loaded it.
    tForm = null;
    tLoadedFor = '';
    try {
      const cfg = await getTenantConfig(id);
      // ⛔ THE STALE RESPONSE. `id` was captured BEFORE the await, so a read that
      // resolves after the operator moved the picker would otherwise re-render a
      // form for the OLD tenant under the NEW one's name — re-creating the exact
      // state `setTenantConfigTenant` just cleared, and doing it a beat later,
      // when it looks like the result of the Load they pressed. Dropping it is
      // this page's own Combobox idiom ("Ignore a stale response if the query
      // moved on while awaiting"), applied to the one read that feeds a form.
      //
      // ⚠️ Compared against `tTenantId` READ NOW, not a captured copy: the point
      // is what the picker says at the moment the bytes arrive.
      if (id !== tTenantId.trim()) return;
      tForm = {
        markup_pct: cfg.markup_pct,
        billing_mode: (cfg.billing_mode as BillingMode) ?? 'standard_markup',
        notes: cfg.notes ?? '',
      };
      // ⚠️ `id`, the tenant actually READ. Identical to `tTenantId` on this line
      // by the guard above — written from `id` anyway so the two can never be
      // coupled by accident if that guard is ever relaxed.
      tLoadedFor = id;
    } catch (err) {
      toast.error(`Load failed: ${err instanceof Error ? err.message : String(err)}`, ERROR_TOAST_MS);
    } finally {
      tLoading = false;
    }
  }

  async function saveTenantConfig(): Promise<void> {
    if (!tForm) return;
    const id = tTenantId.trim();
    if (!id) {
      toast.error('Select a tenant first', ERROR_TOAST_MS);
      return;
    }
    // ⛔ THE LAST BARRIER — AND, AS THE CODE STANDS, AN UNREACHABLE ONE. Say that
    // plainly rather than presenting it as tested coverage.
    //
    // The invariant is enforced UPSTREAM, at both of the only two writers of
    // `tForm`: `setTenantConfigTenant` drops it when the selection moves, and
    // `loadTenantConfig` drops a response that arrives for a tenant the picker
    // has since left. Together those make `tForm !== null ⇒ tLoadedFor ===
    // tTenantId`, so this branch cannot be reached through the UI and there is no
    // DOM test that can exercise it.
    //
    // It stays because `tTenantId` is a plain `$state` any future control can
    // assign, and the cost of being wrong here is a silent cross-tenant BILLING
    // upsert. It is an assertion on the invariant, not a gate anyone has proved
    // fires.
    if (tLoadedFor !== id) {
      toast.error(
        `These values were loaded for ${tLoadedFor ? tenantName(tLoadedFor) : 'a different tenant'}` +
          `, not ${tenantName(id)}. Press Load to read ${tenantName(id)}'s billing config first ` +
          '— nothing was saved.',
        ERROR_TOAST_MS,
      );
      return;
    }
    tSaving = true;
    try {
      const row = await putTenantConfig(id, {
        markup_pct: Number(tForm.markup_pct),
        billing_mode: tForm.billing_mode,
        notes: tForm.notes && String(tForm.notes).trim() !== '' ? String(tForm.notes).trim() : null,
      });
      // The operator picked a tenant by NAME; echoing its uuid back makes them
      // re-check they saved the right one.
      toast.success(`Saved billing config for ${tenantName(row.tenant_id)} (${row.billing_mode})`);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`, ERROR_TOAST_MS);
    } finally {
      tSaving = false;
    }
  }

  const inputCls =
    'w-full px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-sm';
  const btnPrimary =
    'px-3 py-1.5 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors text-sm disabled:opacity-50';
  const btnGhost =
    'px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm hover:bg-[var(--color-surface-hover)]';
</script>

{#if gate === 'pending'}
  <section class="p-6" data-testid="pricing-gate-pending">
    <p class="text-sm text-[var(--color-text-muted)]">Checking access…</p>
  </section>
{:else if gate === 'denied'}
  <section class="p-6" data-testid="pricing-gate-denied">
    <h1 class="text-2xl font-semibold">Not found</h1>
    <p class="text-sm text-[var(--color-text-muted)]">This page requires platform super-admin.</p>
  </section>
{:else}
  <section class="p-6 space-y-8" data-testid="pricing-page">
    <!--
      Rendered under every tenant picker when the tenant directory read failed.
      An empty picker is not "there are no tenants" — and for the markup form
      the empty state is literally "All tenants (global rule)", so silence here
      invites a fleet-wide markup.
    -->
    {#snippet tenantPickerNote()}
      {#if tenantsError}
        <p
          class="pt-1 text-xs text-[var(--color-warning-text)]"
          data-testid="pricing-tenant-picker-unreadable"
        >
          Tenant list unreadable — this picker is incomplete, not empty. Do not read a
          blank selection as “no tenant applies”.
        </p>
      {/if}
    {/snippet}

    {#if tenantsError}
      <div
        class="rounded border border-[var(--color-warning-border,var(--color-border))] bg-[var(--color-surface)] text-sm text-[var(--color-warning-text)] p-3"
        data-testid="pricing-tenants-unreadable"
        role="alert"
      >
        The tenant directory could not be read, so every tenant picker below is
        <strong>incomplete</strong> and tenant names fall back to id stubs. An empty
        picker here does not mean the platform has no tenants. While this persists,
        saving a markup rule that names <strong>no</strong> tenant — a
        <strong>global</strong> rule, which prices every tenant — is
        <strong>refused</strong>, not merely discouraged: with an unreadable directory
        “All tenants (global rule)” is not a choice you can have made here. Pick a
        tenant, or Refresh until the directory loads.
        <span class="block pt-1 text-xs font-mono text-[var(--color-text-muted)]"
          >{tenantsError}</span
        >
      </div>
    {/if}

    <!-- Provider pricing -->
    <div class="space-y-4">
      <header class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold">Provider pricing</h1>
          <p class="text-sm text-[var(--color-text-muted)]">
            Per-token / per-request rates billing uses to compute authoritative cost. Saving supersedes the
            current open row for the same (provider, model, service&nbsp;key).
          </p>
        </div>
        <div class="flex gap-2">
          <button class={btnGhost} onclick={() => void loadAll()} disabled={loading}>Refresh</button>
          <button class={btnPrimary} onclick={newPricing} data-testid="pricing-new">+ New rate</button>
        </div>
      </header>

      {#if loadError}
        <div
          class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3"
          data-testid="pricing-error"
        >
          {loadError}
        </div>
      {/if}

      {#if pForm}
        <div class="rounded-lg border border-[var(--color-border)] p-4 space-y-3" data-testid="pricing-form">
          <div class="grid grid-cols-2 gap-3">
            <label class="text-sm">Provider*<input class={inputCls} bind:value={pForm.provider} placeholder="e.g. video-analyzer" /></label>
            <label class="text-sm">Cost model
              <select class={inputCls} bind:value={pForm.cost_model}>
                {#each COST_MODELS as cm}<option value={cm}>{cm}</option>{/each}
              </select>
            </label>
            <label class="text-sm">Rate class
              <select class={inputCls} bind:value={pForm.rate_class} data-testid="pricing-rate-class">
                <option value="cost">cost (internal)</option>
                <option value="list">list (public / BYO estimate)</option>
              </select>
            </label>
            <label class="text-sm">Served model<input class={inputCls} bind:value={pForm.model} placeholder="(blank = provider default)" /></label>
            <label class="text-sm">Service key<input class={inputCls} bind:value={pForm.service_key} placeholder="(blank = any)" /></label>
            <label class="text-sm">Input $/1M<input class={inputCls} bind:value={pForm.input_per_1m_usd} placeholder="e.g. 283.33333333" /></label>
            <label class="text-sm">Output $/1M<input class={inputCls} bind:value={pForm.output_per_1m_usd} placeholder="e.g. 0" /></label>
            <label class="text-sm">Per-request $<input class={inputCls} bind:value={pForm.per_request_usd} placeholder="(per_request only)" /></label>
            <label class="text-sm">Notes<input class={inputCls} bind:value={pForm.notes} /></label>
          </div>
          <div class="flex gap-2 justify-end">
            <button class={btnGhost} onclick={cancelPricing} disabled={pSaving}>Cancel</button>
            <button class={btnPrimary} onclick={() => void savePricing()} disabled={pSaving} data-testid="pricing-save">
              {pSaving ? 'Saving…' : 'Save rate'}
            </button>
          </div>
        </div>
      {/if}

      <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table class="w-full text-sm">
          <thead class="bg-[var(--color-surface-muted)] text-left">
            <tr>
              <th class="px-3 py-2">Provider</th>
              <th class="px-3 py-2">Served model</th>
              <th class="px-3 py-2">Service key</th>
              <th class="px-3 py-2">Class</th>
              <th class="px-3 py-2">Cost model</th>
              <th class="px-3 py-2 text-right">Input $/1M</th>
              <th class="px-3 py-2 text-right">Output $/1M</th>
              <th class="px-3 py-2 text-right">Per-req $</th>
              <th class="px-3 py-2">Effective from</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {#if loading}
              <tr><td class="px-3 py-3 text-[var(--color-text-muted)]" colspan="10">Loading…</td></tr>
            {:else if pricing.length === 0}
              <tr><td class="px-3 py-3 text-[var(--color-text-muted)]" colspan="10">No pricing rows.</td></tr>
            {:else}
              {#each pricing as row (row.id)}
                <tr class="border-t border-[var(--color-border)]">
                  <td class="px-3 py-2 font-medium">{row.provider}</td>
                  <td class="px-3 py-2">{row.model ?? '—'}</td>
                  <td class="px-3 py-2">{row.service_key ?? '—'}</td>
                  <td class="px-3 py-2">{row.rate_class ?? 'cost'}</td>
                  <td class="px-3 py-2">{row.cost_model}</td>
                  <td class="px-3 py-2 text-right tabular-nums">{formatDecimal(row.input_per_1m_usd)}</td>
                  <td class="px-3 py-2 text-right tabular-nums">{formatDecimal(row.output_per_1m_usd)}</td>
                  <td class="px-3 py-2 text-right tabular-nums">{formatDecimal(row.per_request_usd)}</td>
                  <td class="px-3 py-2 text-[var(--color-text-muted)]">{row.effective_from?.slice(0, 10)}</td>
                  <td class="px-3 py-2 text-right">
                    <button class={btnGhost} onclick={() => editPricing(row)}>Edit</button>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Markup rules -->
    <div class="space-y-4">
      <header class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold">Markup rules</h1>
          <p class="text-sm text-[var(--color-text-muted)]">
            Per-app/license/provider/model markup applied on top of cost. Most-specific rule wins; the
            all-wildcard global default is the fallback.
          </p>
        </div>
        <button class={btnPrimary} onclick={newMarkup} data-testid="markup-new">+ New rule</button>
      </header>

      <!--
        Rendered whenever the platform-default read FAILED — not only when the
        rules table is empty. The default is the fallback for every line no rule
        matches, so an unknown default makes this whole section's arithmetic
        unknown, however many rules are listed.
      -->
      {#if defaultMarkupUnreadable !== null}
        <div
          class="rounded border border-[var(--color-warning-border,var(--color-border))] bg-[var(--color-surface)] text-sm text-[var(--color-warning-text)] p-3"
          data-testid="pricing-default-unreadable"
          role="alert"
        >
          The platform default markup could not be <strong>read</strong>, so it is
          <strong>unknown</strong> — it is <strong>not</strong> known to be unset.
          Usage that matches no rule below is still being charged at whatever default
          billing holds; do not read this page as “no markup is applied”, and do not
          add a rule to “restore” a default you have not seen. Saving a markup rule
          while this persists asks you to confirm that unknown first.
          <span class="block pt-1 text-xs font-mono text-[var(--color-text-muted)]"
            >{defaultMarkupUnreadable}</span
          >
        </div>
      {/if}

      {#if mForm}
        <div class="rounded-lg border border-[var(--color-border)] p-4 space-y-3" data-testid="markup-form">
          <div class="grid grid-cols-2 gap-3">
            <!--
              Tenant is a picker, not a uuid box: an operator knows "Acme", not
              `9f3c…`, and a mistyped uuid here silently prices the wrong tenant
              (or nothing at all). Leaving it unset is still the global rule.
            -->
            <div class="text-sm">
              <span class="block pb-1">Tenant</span>
              <Combobox
                value={mForm.tenant_id || null}
                options={tenantOpts}
                onSelect={setMarkupTenant}
                placeholder="Search tenants…"
                emptyLabel="All tenants (global rule)"
                data-testid="markup-tenant-picker"
              />
              {@render tenantPickerNote()}
              <!--
                The scope of the rule, stated where it is chosen rather than only
                in the confirmation. "All tenants (global rule)" is the picker's
                emptyLabel, i.e. the DEFAULT state of an untouched form, so the
                blast radius has to be legible before the operator clicks Save.
              -->
              {#if markupGlobalUnknowable}
                <p
                  class="pt-1 text-xs text-[var(--color-danger-text)]"
                  data-testid="markup-global-blocked"
                >
                  This rule names no tenant, so it would price <strong>every</strong> tenant —
                  and the directory above is unreadable, so this picker cannot show you which
                  tenants that is. Saving is <strong>refused</strong> until you pick a tenant
                  or the directory loads.
                </p>
              {:else if markupIsGlobal}
                <p
                  class="pt-1 text-xs text-[var(--color-warning-text)]"
                  data-testid="markup-global-scope"
                >
                  No tenant selected ⇒ <strong>global rule</strong>: it applies to every
                  tenant (only Provider / Model / Service key narrow it). Saving asks you to
                  confirm — fr cannot delete a markup rule, only supersede it.
                </p>
              {/if}
            </div>
            <label class="text-sm">Provider<input class={inputCls} bind:value={mForm.provider} placeholder="(blank = any)" /></label>
            <label class="text-sm">Model<input class={inputCls} bind:value={mForm.model} placeholder="(blank = any)" /></label>
            <label class="text-sm">Service key<input class={inputCls} bind:value={mForm.service_key} placeholder="(blank = any)" /></label>
            <label class="text-sm">Markup %<input class={inputCls} bind:value={mForm.markup_pct} placeholder="e.g. 30" data-testid="markup-pct" /></label>
            <label class="text-sm">Notes<input class={inputCls} bind:value={mForm.notes} /></label>
          </div>
          <div class="flex gap-2 justify-end">
            <button class={btnGhost} onclick={cancelMarkup} disabled={mSaving}>Cancel</button>
            <!--
              ⚠️ Deliberately NOT `disabled={mSaving || markupGlobalUnknowable}`.
              The refusal lives in saveMarkup(); a disabled button would swallow
              the click in jsdom, so the test that pins the refusal would pass
              with the guard deleted — a gate that cannot fail. The inline note
              above the button is the affordance; the handler is the constraint.
            -->
            <button class={btnPrimary} onclick={() => void saveMarkup()} disabled={mSaving} data-testid="markup-save">
              {mSaving ? 'Saving…' : 'Save rule'}
            </button>
          </div>
        </div>
      {/if}

      <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table class="w-full text-sm">
          <thead class="bg-[var(--color-surface-muted)] text-left">
            <tr>
              <th class="px-3 py-2">Tenant</th>
              <th class="px-3 py-2">Provider</th>
              <th class="px-3 py-2">Model</th>
              <th class="px-3 py-2">Service key</th>
              <th class="px-3 py-2 text-right">Markup %</th>
              <th class="px-3 py-2">Effective from</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {#if loading}
              <tr><td class="px-3 py-3 text-[var(--color-text-muted)]" colspan="7">Loading…</td></tr>
            {:else if markups.length === 0}
              <!--
                An empty rules table does NOT mean nothing is being charged:
                billing falls back to the platform default (production has zero
                open rules today while that default is applied). Say the real
                number — or, if it could not be fetched, say THAT.
                ⚠️ "Say nothing about it" was the previous rule here and it was
                the defect: silence about a number that is still being charged
                is read as the absence of the charge.
              -->
              <tr><td class="px-3 py-3 text-[var(--color-text-muted)]" colspan="7" data-testid="markup-empty">
                {#if defaultMarkupUnreadable !== null}
                  <!-- Unreadable outranks the value: the read failed, so this
                       cell may not claim a number AND may not claim there is
                       none. The reason is in the notice above the table. -->
                  No explicit markup rules — and the platform default could not be read,
                  so what this usage is charged is unknown. See the notice above.
                {:else if defaultMarkupPct !== null}
                  No explicit markup rules — the platform default of {defaultMarkupPct}% applies to all usage.
                {:else}
                  No markup rules.
                {/if}
              </td></tr>
            {:else}
              {#each markups as row (row.id)}
                <tr class="border-t border-[var(--color-border)]">
                  <td class="px-3 py-2">
                    {#if row.tenant_id}
                      <EntityRef
                        id={row.tenant_id}
                        name={tenantNameById[row.tenant_id] ?? null}
                        kind="tenant"
                      />
                    {:else}
                      global
                    {/if}
                  </td>
                  <td class="px-3 py-2">{row.provider ?? '*'}</td>
                  <td class="px-3 py-2">{row.model ?? '*'}</td>
                  <td class="px-3 py-2">{row.service_key ?? '*'}</td>
                  <td class="px-3 py-2 text-right tabular-nums">{formatDecimal(row.markup_pct)}</td>
                  <td class="px-3 py-2 text-[var(--color-text-muted)]">{row.effective_from?.slice(0, 10)}</td>
                  <td class="px-3 py-2 text-right">
                    <button class={btnGhost} onclick={() => editMarkup(row)}>Edit</button>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Access charges -->
    <div class="space-y-4" data-testid="access-charges">
      <header class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold">Access charges</h1>
          <p class="text-sm text-[var(--color-text-muted)]">
            Fixed per-(tenant, product) access fee — the paid-license axis, separate from usage markup.
            Blank service key = a tenant-wide charge. Monthly bills every month; one-time bills once.
          </p>
        </div>
        <button class={btnPrimary} onclick={newAccessCharge} data-testid="access-charge-new">
          + New charge
        </button>
      </header>

      {#if acForm}
        <div class="rounded-lg border border-[var(--color-border)] p-4 space-y-3" data-testid="access-charge-form">
          <div class="grid grid-cols-2 gap-3">
            <!-- Required, and it decides who gets billed — never a typed uuid. -->
            <div class="text-sm">
              <span class="block pb-1">Tenant*</span>
              <Combobox
                value={acForm.tenant_id || null}
                options={tenantOpts}
                onSelect={setAccessTenant}
                placeholder="Search tenants…"
                emptyLabel="Select a tenant…"
                data-testid="access-charge-tenant-picker"
              />
              {@render tenantPickerNote()}
            </div>
            <label class="text-sm">Service key<input class={inputCls} bind:value={acForm.service_key} placeholder="(blank = tenant-wide)" /></label>
            <label class="text-sm">Amount USD<input class={inputCls} bind:value={acForm.amount_usd} placeholder="e.g. 49.00" /></label>
            <label class="text-sm">Cadence
              <select class={inputCls} bind:value={acForm.cadence}>
                {#each ACCESS_CADENCES as c}<option value={c}>{c}</option>{/each}
              </select>
            </label>
            <label class="text-sm">Included usage $/mo<input class={inputCls} bind:value={acForm.included_cost_usd} placeholder="(blank = none)" data-testid="access-charge-included" /></label>
            <label class="text-sm">Notes<input class={inputCls} bind:value={acForm.notes} /></label>
          </div>
          <div class="flex gap-2 justify-end">
            <button class={btnGhost} onclick={cancelAccessCharge} disabled={acSaving}>Cancel</button>
            <button class={btnPrimary} onclick={() => void saveAccessCharge()} disabled={acSaving} data-testid="access-charge-save">
              {acSaving ? 'Saving…' : 'Save charge'}
            </button>
          </div>
        </div>
      {/if}

      <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table class="w-full text-sm">
          <thead class="bg-[var(--color-surface-muted)] text-left">
            <tr>
              <th class="px-3 py-2">Tenant</th>
              <th class="px-3 py-2">Service key</th>
              <th class="px-3 py-2 text-right">Amount USD</th>
              <th class="px-3 py-2">Cadence</th>
              <th class="px-3 py-2 text-right">Included/mo</th>
              <th class="px-3 py-2">Effective from</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {#if loading}
              <tr><td class="px-3 py-3 text-[var(--color-text-muted)]" colspan="7">Loading…</td></tr>
            {:else if accessCharges.length === 0}
              <tr><td class="px-3 py-3 text-[var(--color-text-muted)]" colspan="7">No access charges.</td></tr>
            {:else}
              {#each accessCharges as row (row.id)}
                <tr class="border-t border-[var(--color-border)]">
                  <td class="px-3 py-2">
                    <EntityRef
                      id={row.tenant_id}
                      name={tenantNameById[row.tenant_id] ?? null}
                      kind="tenant"
                    />
                  </td>
                  <td class="px-3 py-2">{row.service_key ?? 'tenant-wide'}</td>
                  <td class="px-3 py-2 text-right tabular-nums">{formatDecimal(row.amount_usd)}</td>
                  <td class="px-3 py-2">{row.cadence}</td>
                  <td class="px-3 py-2 text-right tabular-nums">{formatDecimal(row.included_cost_usd)}</td>
                  <td class="px-3 py-2 text-[var(--color-text-muted)]">{row.effective_from?.slice(0, 10)}</td>
                  <td class="px-3 py-2 text-right">
                    <button class={btnGhost} onclick={() => editAccessCharge(row)}>Edit</button>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tenant billing mode -->
    <div class="space-y-4" data-testid="tenant-billing-mode">
      <header>
        <h1 class="text-2xl font-semibold">Tenant billing mode</h1>
        <p class="text-sm text-[var(--color-text-muted)]">
          Set a tenant's markup and billing mode. <code>byo_platform_fee</code> charges BYO lines the
          platform surcharge only (provider cost is a pass-through estimate); <code>pass_through</code>
          applies zero markup everywhere. Pick a tenant and load its config first.
        </p>
      </header>

      <div class="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
        <div class="flex items-end gap-2">
          <div class="text-sm flex-1">
            <span class="block pb-1">Tenant</span>
            <Combobox
              value={tTenantId || null}
              options={tenantOpts}
              onSelect={setTenantConfigTenant}
              placeholder="Search tenants…"
              emptyLabel="Select a tenant…"
              data-testid="tenant-config-id"
            />
            {@render tenantPickerNote()}
          </div>
          <button class={btnGhost} onclick={() => void loadTenantConfig()} disabled={tLoading} data-testid="tenant-config-load">
            {tLoading ? 'Loading…' : 'Load'}
          </button>
        </div>

        {#if tForm}
          <!-- ⭐ WHOSE NUMBERS ARE THESE. The form renders three values that look
               identical whichever tenant they came from, so the only thing that
               can stop an operator reading tenant A's markup as tenant B's is
               saying, on the same screen, which tenant was actually read.
               `tLoadedFor` and not `tTenantId`: the picker is where the wrong
               answer comes from. -->
          <p
            class="text-xs text-[var(--color-text-muted)]"
            data-testid="tenant-config-loaded-for"
            data-loaded-for={tLoadedFor}
          >
            Loaded for
            <EntityRef id={tLoadedFor} name={tenantNameById[tLoadedFor] ?? null} kind="tenant" />
          </p>
          <div class="grid grid-cols-2 gap-3" data-testid="tenant-config-form">
            <label class="text-sm">Billing mode
              <select class={inputCls} bind:value={tForm.billing_mode} data-testid="tenant-config-mode">
                {#each BILLING_MODES as bm}<option value={bm}>{bm}</option>{/each}
              </select>
            </label>
            <label class="text-sm">Markup %
              <input class={inputCls} type="number" min="0" step="0.01" bind:value={tForm.markup_pct} />
            </label>
            <label class="text-sm col-span-2">Notes<input class={inputCls} bind:value={tForm.notes} /></label>
          </div>
          <div class="flex gap-2 justify-end">
            <button class={btnPrimary} onclick={() => void saveTenantConfig()} disabled={tSaving} data-testid="tenant-config-save">
              {tSaving ? 'Saving…' : 'Save billing config'}
            </button>
          </div>
        {/if}
      </div>
    </div>

    <!-- USD→EUR FX (tenant inference provisioning, EUR budgets). -->
    <FxRateCard />
  </section>
{/if}
