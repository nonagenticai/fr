<!--
  /admin/users — provision a new user.

  Spec 2 Task 6.

  Renders a form that calls `POST /api/admin/super-admin/provision-user`.
  On success, surfaces the temporary password and per-app license tokens —
  shown ONCE and handed to the end user out-of-band.

  ⚠️ `temporary_password` can legitimately be `null` now that the backend routes
  this through the provisioning engine: an already-existing account's password is
  deliberately NOT rotated, and an idempotent replay returns no one-time secrets
  at all. The result panel must therefore explain WHY there is no password and
  what the recovery path is — never render an empty credential box, which reads
  as "here is the password" and is a lie.

  The page also hosts the offboard action (`POST .../deprovision-user`), which
  deletes the Keycloak account + that provisioning run's licenses and deregisters
  their billing quota. It does NOT delete the tenant or any fr-local state; the
  copy below enumerates exactly that.

  The Apps fieldset is driven by the LIVE licenses catalog. It was previously a
  single hardcoded `fr-frontend` checkbox mirroring a one-value backend enum,
  which made every other app in the cluster unprovisionable. Granting a license
  to an EXISTING user lives at /admin/licenses; this page is only the
  create-a-user path.

  Page-level auth: gated by `+page.ts` (`error(404)` for non-super-admins) and
  also visually gated under `/settings` via `auth.isSuperAdmin`. The backend
  is the source of truth.
-->
<script lang="ts">
  import AccessList from './AccessList.svelte';
  import { Button, Combobox, Input, Pill } from '$lib/components/ui';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    getSuperAdminStatus,
    provisionUser,
    provisionMemberIntoTenant,
    deprovisionUser,
    type NewTenantProvisionInput,
    type ProvisionMemberResult,
    type ProvisionUserResult,
    type DeprovisionUserResult,
  } from '$lib/api/super-admin';
  import {
    createPlan,
    getTenant,
    listAppPlans,
    listApps,
    listTenants,
    type AppRecord,
    type TenantRecord,
  } from '$lib/api/licenses-admin';
  import { provisionableApps, appLabel } from '../licenses/page-helpers';
  import {
    applyTenantInference,
    getInferenceConfig,
    type InferenceConfig,
    type InferenceInput,
  } from '$lib/api/inference-admin';
  import InferenceSetup from '$lib/components/inference/InferenceSetup.svelte';
  import InferenceResult from '$lib/components/inference/InferenceResult.svelte';
  import {
    emptyInferenceDraft,
    inferencePayload,
  } from '$lib/components/inference/inference-form';
  import {
    RATE_LIMIT_ENFORCED,
    RATE_LIMIT_INPUT_PLACEHOLDER,
    RATE_LIMIT_NOT_ENFORCED_NOTE,
    RATE_LIMIT_NOTICE_TESTID,
  } from '$lib/admin/rate-limit-enforcement';
  import {
    additionalSeatsPayload,
    appByKey,
    appPlansPayload,
    canUntickApp,
    defaultPersonApps,
    FR_PERSON_APPS,
    frPersonApps,
    credentialState,
    customPlanRequest,
    describeSeatOutcome,
    emptyCustomPlanDraft,
    emptySeatDraft,
    existingTenantOptions,
    isTenantId,
    mergeTenants,
    noTokensMessage,
    planChoicesForUnselectedApps,
    planPickerEmptyLabel,
    planPickerOptions,
    prunePlanChoices,
    seatCredentialState,
    seatCountProblem,
    seatProblemMessage,
    seatStatusHeadline,
    seatStatusTone,
    seatTokensMessage,
    seatsBlockSubmit,
    validateSeatRows,
    type AppPlansLoad,
    type PlanChoices,
    type SeatDraft,
  } from './page-helpers';

  // Gate state. Probe `/api/me/super-admin` AFTER `auth.isLoading=false`
  // (keycloak-js hasn't populated the access token before that, so the
  // authFetch call would send no Bearer header and 401 for genuine super
  // admins). Render a 404-styled "Not found" panel locally if the probe
  // says false, instead of throwing `kitError(404)` from a runtime
  // `$effect` — that bubbles into SvelteKit's runtime as an unhandled
  // exception and ends up redirecting away from this route.
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
      } catch {
        gate = 'denied';
      }
    })();
  });

  // Form state ---------------------------------------------------------------
  // Prefill email from `?email=` — the licensing console's "provision new user"
  // link carries it here when a person-search found no account, so the operator
  // doesn't retype what they just typed.
  const prefillEmail =
    typeof window !== 'undefined'
      ? (new URLSearchParams(window.location.search).get('email') ?? '')
      : '';
  let email = $state(prefillEmail);
  let name = $state('');
  let phone = $state('');
  let tenantSlug = $state('');
  let workspaceRole = $state<'admin' | 'member'>('admin');
  let monthlyBudget = $state(1_000_000);
  let sendPasswordResetEmail = $state(true);

  // Tenant mode ----------------------------------------------------------------
  // `new`: the slug path (provisioning resolves/mints an fr tenant, licences,
  // quota, budget). `existing`: add a human MEMBER to a tenant that already
  // exists, by id — mints NO licence, budget or seat (the tenant holds them), so
  // every licensing section below is hidden and nothing of it is sent.
  let tenantMode = $state<'new' | 'existing'>('new');
  const existingMode = $derived(tenantMode === 'existing');
  let existingTenantId = $state<string | null>(null);
  let listedTenants = $state<TenantRecord[]>([]);
  let resolvedTenants = $state<TenantRecord[]>([]);
  let tenantsLoading = $state(false);
  let tenantsError = $state<string | null>(null);
  let tenantIdInput = $state('');
  let tenantLookupBusy = $state(false);
  let tenantLookupError = $state<string | null>(null);
  let memberResult = $state<ProvisionMemberResult | null>(null);
  const tenantOptions = $derived(existingTenantOptions(mergeTenants(resolvedTenants, listedTenants)));
  const memberCred = $derived(memberResult ? credentialState(memberResult) : null);

  let tenantsLoadStarted = false;
  $effect(() => {
    if (gate !== 'allowed' || !existingMode || tenantsLoadStarted) return;
    tenantsLoadStarted = true;
    tenantsLoading = true;
    void (async () => {
      try {
        // Service actors included: a service tenant (e.g. the conveyor's) is a
        // legitimate target here. Archived ones are not (the backend 409s them).
        listedTenants = await listTenants(false, true);
      } catch (e) {
        tenantsError = e instanceof Error ? e.message : String(e);
      } finally {
        tenantsLoading = false;
      }
    })();
  });

  // The registry LISTING only carries tenants fr owns; a tenant fr holds a grant
  // on resolves by id only. So a pasted id is looked up and, if licences answers,
  // added to the picker and selected.
  async function lookUpTenantId(): Promise<void> {
    const id = tenantIdInput.trim();
    tenantLookupError = null;
    if (!isTenantId(id)) {
      tenantLookupError = 'Enter a tenant id (uuid).';
      return;
    }
    tenantLookupBusy = true;
    try {
      const t = await getTenant(id);
      if (t.archived_at) {
        tenantLookupError = `Tenant “${t.name}” is archived; nobody can be added to it.`;
        return;
      }
      resolvedTenants = mergeTenants([t], resolvedTenants);
      existingTenantId = t.id;
      tenantIdInput = '';
    } catch (e) {
      tenantLookupError = e instanceof Error ? e.message : String(e);
    } finally {
      tenantLookupBusy = false;
    }
  }

  function setTenantMode(mode: 'new' | 'existing'): void {
    tenantMode = mode;
    error = null;
    // The server's per-mode default, mirrored: a new tenant's first person is its
    // admin; a person added to an existing tenant is a member unless chosen.
    workspaceRole = mode === 'existing' ? 'member' : 'admin';
  }

  let submitting = $state(false);
  let error = $state<string | null>(null);
  let result = $state<ProvisionUserResult | null>(null);
  let copiedKey = $state<string | null>(null);

  // Inference (PLAN tenant-inference-provisioning §2.6). The section exists
  // only when the backend says FR_INFERENCE_PROVISIONING is on; with it off
  // the form, the request and the result panel are exactly today's.
  let inferenceConfig = $state<InferenceConfig | null>(null);
  let inferenceConfigError = $state<string | null>(null);
  // EXPLICIT OPT-IN (2026-10-14): unticked by default, so a provision keeps the
  // manual token budget below unless the owner ticks "Configure this tenant’s
  // inference". Defaulting it on silently opted every new tenant in.
  let inferenceOn = $state(false);
  let inferenceDraft = $state(emptyInferenceDraft());
  /** What the last submit sent, so "Re-run checks" re-applies exactly that. */
  let lastInferenceInput = $state<InferenceInput | null>(null);
  let inferenceRerunning = $state(false);
  let inferenceRerunError = $state<string | null>(null);
  const inferenceEnabled = $derived(inferenceConfig?.enabled === true);
  const sendInference = $derived(inferenceEnabled && inferenceOn);

  let inferenceProbeStarted = false;
  $effect(() => {
    if (gate !== 'allowed' || inferenceProbeStarted) return;
    inferenceProbeStarted = true;
    void (async () => {
      try {
        inferenceConfig = await getInferenceConfig();
      } catch (err) {
        inferenceConfigError = err instanceof Error ? err.message : String(err);
      }
    })();
  });

  async function rerunInferenceChecks(): Promise<void> {
    if (!result || !lastInferenceInput) return;
    inferenceRerunning = true;
    inferenceRerunError = null;
    try {
      const outcome = await applyTenantInference(result.tenant_id, lastInferenceInput);
      result = { ...result, inference: outcome };
    } catch (err) {
      inferenceRerunError = err instanceof Error ? err.message : String(err);
    } finally {
      inferenceRerunning = false;
    }
  }

  // Honesty derivations for the result panel, kept in `./page-helpers` so the
  // rules (an empty string is NOT a password; a license without a token must not
  // be rendered as a credential) are unit-tested rather than template branches.
  const cred = $derived(result ? credentialState(result) : null);
  const tokensMessage = $derived(result ? noTokensMessage(result) : null);

  // App catalog, loaded live. This used to be a single hardcoded `fr-frontend`
  // checkbox mirroring a one-value enum on the backend, so a new user could not
  // be provisioned onto any other app in the cluster. The catalog is the source
  // of truth for what exists; the backend 404s an unknown key.
  //
  // fr provisions only its own platform context per person: `fr` (the gate key)
  // + `fr-frontend`. The default selects both — `fr-frontend` alone founded a
  // workspace fr's own gate then refused — and `fr` cannot be unticked.
  let catalog = $state<AppRecord[]>([]);
  let catalogError = $state<string | null>(null);
  let catalogLoading = $state(true);
  let selectedApps = $state<string[]>(defaultPersonApps());

  // A discriminated result, not an array: an empty picker means two very
  // different things. "the catalogue has no human apps" is an answer; "the
  // catalogue predates migration 022 and carries no audience at all" is a
  // version mismatch, and rendering it as an empty checkbox list would blame
  // the operator for a deploy-order problem.
  const grantable = $derived(provisionableApps(catalog));
  const grantableApps = $derived(grantable.status === 'ok' ? frPersonApps(grantable.apps) : []);
  const apps = $derived(selectedApps);

  // Load once the gate has allowed us in — authFetch needs the Keycloak token,
  // and a denied user should not be issuing catalog reads at all.
  let catalogLoadStarted = false;
  $effect(() => {
    if (gate !== 'allowed' || catalogLoadStarted) return;
    catalogLoadStarted = true;
    void (async () => {
      try {
        catalog = await listApps();
      } catch (e) {
        // Non-fatal: fall back to the default key so provisioning still works
        // exactly as it did before the catalog existed here. Say so, though —
        // silently offering one app would look like the old cage.
        catalogError = e instanceof Error ? e.message : String(e);
      } finally {
        catalogLoading = false;
      }
    })();
  });

  // Per-app plan selection ---------------------------------------------------
  // Keyed by app KEY, because that is what `selectedApps` and the request body's
  // `apps`/`app_plans` are keyed by. The plan ENDPOINTS are keyed by app id, so
  // `appByKey` is the only place the two identifiers meet — see page-helpers.
  //
  // Leaving a plan unset is legal and is the default: `app_plans` is omitted
  // entirely and the backend keeps today's behaviour (first live plan).
  let plansByApp = $state<Record<string, AppPlansLoad>>({});
  let planChoices = $state<PlanChoices>({});

  const planLoadFor = (key: string): AppPlansLoad =>
    plansByApp[key] ?? { kind: 'idle' };

  // The detector for the invalid state, not the fix. `toggleApp` prunes, so this
  // should always be empty; a non-empty read means the prune regressed, and the
  // alternative (letting `appPlansPayload` drop the entry) would provision a
  // different plan from the one last shown selected, silently.
  const orphanPlanChoices = $derived(planChoicesForUnselectedApps(selectedApps, planChoices));

  async function loadPlansFor(key: string): Promise<void> {
    const app = appByKey(catalog, key);
    if (!app) {
      // No catalogue row ⇒ no app id ⇒ no plan list can be read. Say that
      // rather than rendering an empty picker, which would read as "this app
      // has no plans".
      plansByApp = {
        ...plansByApp,
        [key]: { kind: 'error', message: `“${key}” is not in the loaded catalogue` },
      };
      return;
    }
    plansByApp = { ...plansByApp, [key]: { kind: 'loading' } };
    try {
      const plans = await listAppPlans(app.id);
      plansByApp = { ...plansByApp, [key]: { kind: 'ready', plans } };
    } catch (e) {
      plansByApp = {
        ...plansByApp,
        [key]: { kind: 'error', message: e instanceof Error ? e.message : String(e) },
      };
    }
  }

  function toggleApp(key: string): void {
    const adding = !selectedApps.includes(key);
    if (!adding && !canUntickApp(key)) return;
    selectedApps = adding
      ? [...selectedApps, key]
      : selectedApps.filter((k) => k !== key);
    // Drop the plan choice for an app that was just unticked, so the form state
    // cannot carry a plan for an app the backend is not being asked to licence.
    planChoices = prunePlanChoices(selectedApps, planChoices);
    if (adding && planLoadFor(key).kind === 'idle') void loadPlansFor(key);
    if (!adding && customPlanOpenFor === key) closeCustomPlan();
  }

  function choosePlan(key: string, planId: string | null): void {
    planChoices = planId
      ? { ...planChoices, [key]: planId }
      : Object.fromEntries(Object.entries(planChoices).filter(([k]) => k !== key));
  }

  // Load plans for whatever is already ticked once the catalogue read has
  // SETTLED — the default `fr` + `fr-frontend` selection predates any operator
  // interaction, so its picker must populate without requiring a toggle.
  //
  // Gated on `catalogLoading`, not on `catalog.length`: a FAILED catalogue read
  // leaves the list empty forever, and waiting for a non-empty one would pin
  // every picker at "Plans not loaded yet" — an idle state that claims nothing
  // was attempted. Priming against the empty catalogue instead yields
  // `loadPlansFor`'s honest "not in the loaded catalogue" error.
  let plansPrimed = false;
  $effect(() => {
    if (plansPrimed || catalogLoading) return;
    plansPrimed = true;
    for (const key of selectedApps) void loadPlansFor(key);
  });

  // "Create custom plan" ------------------------------------------------------
  // Posts to the EXISTING `POST /api/admin/licenses/plans`; no new route. On 201
  // the returned record is merged into that app's list and selected, then a
  // refresh replaces the list — so the new plan is selectable immediately, with
  // no page reload.
  let customPlanOpenFor = $state<string | null>(null);
  let planDraft = $state(emptyCustomPlanDraft());
  let creatingPlan = $state(false);
  let planCreateError = $state<string | null>(null);
  let planRefreshNote = $state<string | null>(null);

  function openCustomPlan(key: string): void {
    customPlanOpenFor = key;
    planDraft = emptyCustomPlanDraft();
    planCreateError = null;
    planRefreshNote = null;
  }

  function closeCustomPlan(): void {
    customPlanOpenFor = null;
    planDraft = emptyCustomPlanDraft();
    planCreateError = null;
  }

  // Driven by an ordinary button, NOT a submit: this panel lives inside the
  // provisioning <form>, so a nested form (or a `type="submit"` here) would fire
  // `handleSubmit` and provision a user instead of creating a plan.
  async function submitCustomPlan(event: MouseEvent): Promise<void> {
    event.preventDefault();
    const key = customPlanOpenFor;
    if (!key) return;
    planCreateError = null;
    planRefreshNote = null;

    const appId = appByKey(catalog, key)?.id ?? null;
    const req = customPlanRequest(appId, planDraft);
    if (!req.ok || !appId) {
      planCreateError = req.ok ? `“${key}” is not in the loaded catalogue.` : req.problem;
      return;
    }

    creatingPlan = true;
    try {
      const created = await createPlan(req.body);
      // The 201 body IS the authoritative record, so merge it first and select
      // it. A refresh that fails afterwards must not make a plan that genuinely
      // exists disappear from the picker.
      const current = planLoadFor(key);
      const merged =
        current.kind === 'ready'
          ? [...current.plans.filter((p) => p.id !== created.id), created]
          : [created];
      plansByApp = { ...plansByApp, [key]: { kind: 'ready', plans: merged } };
      choosePlan(key, created.id);
      closeCustomPlan();
      try {
        const plans = await listAppPlans(appId);
        plansByApp = { ...plansByApp, [key]: { kind: 'ready', plans } };
      } catch (e) {
        planRefreshNote = `Plan “${created.code}” was created and is selected, but the plan list could not be re-read (${e instanceof Error ? e.message : String(e)}), so the list below may be incomplete.`;
      }
    } catch (err) {
      planCreateError = err instanceof Error ? err.message : String(err);
    } finally {
      creatingPlan = false;
    }
  }

  // Additional seats ---------------------------------------------------------
  // ⛔ NO seat-count number input, ever. A seat IS a licence row held by a named
  // person, and billing's live seat count is derived by counting those rows. A
  // "how many seats?" field would be a SECOND source of truth for that count,
  // stored nowhere and reconciled by nothing: an operator who typed 5 and got 3
  // rows (two failures) would still read "5" here while billing charges for 3.
  // Collecting the people makes the count a consequence of the data, and it is
  // also the only shape that can carry per-seat outcomes back.
  let seats = $state<SeatDraft[]>([]);
  const seatProblems = $derived(validateSeatRows(seats, email));
  const seatCountError = $derived(seatCountProblem(seats));
  const seatsInvalid = $derived(seatsBlockSubmit(seatProblems) || seatCountError !== null);

  function addSeat(): void {
    seats = [...seats, emptySeatDraft()];
  }

  function removeSeat(index: number): void {
    seats = seats.filter((_, i) => i !== index);
  }

  const seatResults = $derived(result?.seats ?? []);

  function reset(): void {
    email = '';
    name = '';
    phone = '';
    tenantSlug = '';
    tenantMode = 'new';
    existingTenantId = null;
    tenantIdInput = '';
    tenantLookupError = null;
    memberResult = null;
    workspaceRole = 'admin';
    selectedApps = defaultPersonApps();
    monthlyBudget = 1_000_000;
    sendPasswordResetEmail = true;
    planChoices = {};
    seats = [];
    closeCustomPlan();
    planRefreshNote = null;
    error = null;
    result = null;
    copiedKey = null;
    inferenceOn = false;
    inferenceDraft = emptyInferenceDraft();
    lastInferenceInput = null;
    inferenceRerunError = null;
  }

  async function handleSubmitExisting(): Promise<void> {
    if (!existingTenantId) {
      error = 'Pick the tenant to add this person to.';
      return;
    }
    submitting = true;
    try {
      memberResult = await provisionMemberIntoTenant({
        email: email.trim(),
        name: name.trim(),
        tenant_id: existingTenantId,
        workspace_role: workspaceRole,
        send_password_reset_email: sendPasswordResetEmail,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      submitting = false;
    }
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    error = null;
    if (existingMode) {
      await handleSubmitExisting();
      return;
    }
    if (apps.length === 0) {
      error = 'Select at least one app.';
      return;
    }
    if (orphanPlanChoices.length > 0) {
      // Refused rather than silently dropped: the operator last saw a plan
      // selected for these apps, and sending the request without them would
      // provision something different from what the form showed.
      error = `A plan is still chosen for ${orphanPlanChoices.join(', ')}, which ${orphanPlanChoices.length === 1 ? 'is' : 'are'} not selected. Re-tick the app or clear the plan.`;
      return;
    }
    if (seatsInvalid) {
      error = 'Fix or remove the highlighted seat rows first.';
      return;
    }
    const input: NewTenantProvisionInput = {
      email: email.trim(),
      name: name.trim(),
      tenant_slug: tenantSlug.trim(),
      workspace_role: workspaceRole,
      apps,
      monthly_budget_tokens: monthlyBudget,
      send_password_reset_email: sendPasswordResetEmail,
    };
    const phoneTrim = phone.trim();
    if (phoneTrim) input.phone_e164 = phoneTrim;
    // Both fields are OMITTED when nothing was chosen — not sent empty. An
    // absent field is the pre-existing single-seat, default-plan call; `{}` or
    // `[]` would be an explicit empty choice, which is a different request.
    const chosenPlans = appPlansPayload(apps, planChoices);
    if (chosenPlans) input.app_plans = chosenPlans;
    const extraSeats = additionalSeatsPayload(seats);
    if (extraSeats) input.additional_seats = extraSeats;
    // OMITTED (not sent empty) unless the section is enabled AND switched on.
    if (sendInference) {
      const inf = inferencePayload(inferenceDraft, inferenceConfig);
      if (!inf.ok) {
        error = inf.error;
        return;
      }
      input.inference = inf.input;
      lastInferenceInput = inf.input;
    } else {
      lastInferenceInput = null;
    }

    submitting = true;
    try {
      result = await provisionUser(input);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      submitting = false;
    }
  }

  // Offboard state ----------------------------------------------------------
  // Kept separate from the provision form: it addresses an EXISTING run by
  // (email, tenant_slug) — the same pair the provision used, because that is what
  // the backend hashes into the provisioning idempotency key.
  let offboardOpen = $state(false);
  let offEmail = $state('');
  let offTenantSlug = $state('');
  let offReason = $state('');
  let offConfirm = $state('');
  let offSubmitting = $state(false);
  let offError = $state<string | null>(null);
  let offResult = $state<DeprovisionUserResult | null>(null);

  // Typing the email back is the guard: this deletes a Keycloak account.
  const offConfirmed = $derived(
    offEmail.trim().length > 0 &&
      offConfirm.trim().toLowerCase() === offEmail.trim().toLowerCase(),
  );

  async function handleOffboard(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    offError = null;
    offResult = null;
    if (!offConfirmed) {
      offError = 'Type the email address to confirm.';
      return;
    }
    offSubmitting = true;
    try {
      const reason = offReason.trim();
      offResult = await deprovisionUser({
        email: offEmail.trim(),
        tenant_slug: offTenantSlug.trim(),
        ...(reason ? { reason } : {}),
      });
      offConfirm = '';
    } catch (err) {
      offError = err instanceof Error ? err.message : String(err);
    } finally {
      offSubmitting = false;
    }
  }

  async function copy(key: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copiedKey = key;
      setTimeout(() => {
        if (copiedKey === key) copiedKey = null;
      }, 1500);
    } catch {
      // Clipboard blocked; user can still select+copy manually.
    }
  }
</script>

{#if gate === 'pending'}
  <section class="p-6">
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  </section>
{:else if gate === 'denied'}
  <section class="p-6" data-testid="super-admin-not-found">
    <h1 class="text-3xl font-semibold">404</h1>
    <p class="text-sm text-[var(--color-text-muted)]">Not found</p>
  </section>
{:else}
<section class="p-6 max-w-3xl space-y-8" data-testid="super-admin-page">
  <!-- Who already has access comes FIRST. Provisioning someone who is already
       here was previously easy to do by accident: the page opened straight onto
       an empty create-form with no way to see the existing population. -->
  <AccessList />

  <header>
    <h1 class="text-2xl font-semibold">
      Provision user <Pill tone="warning">Dev/test</Pill>
    </h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      Creates a Keycloak user, workspace tenant, license tokens, and a metering
      budget in one shot. The temporary password and tokens shown after
      submission are surfaced ONCE — copy them now.
    </p>
  </header>

  {#if memberResult}
    <!-- Existing-tenant result: a member was added; nothing was minted. -->
    <div class="space-y-4" data-testid="super-admin-member-result">
      <div
        class="rounded border border-[var(--color-success)] bg-[var(--color-success)] p-4 text-sm dark:bg-[var(--color-success-bg)]"
      >
        <p class="font-semibold">
          {memberResult.already_existed
            ? `Already in “${memberResult.tenant_name}” — role and workspace confirmed`
            : `Added to “${memberResult.tenant_name}”`}
        </p>
        <p class="text-xs text-[var(--color-text-muted)] mt-1">
          No licence, budget or seat was minted: the tenant already holds them. The
          temporary password, if any, is shown ONCE.
        </p>
      </div>

      {#if memberResult.warnings.length > 0}
        <div class="rounded border border-[var(--color-border-strong)] p-3 text-sm" data-testid="super-admin-member-warnings">
          <p class="font-semibold">Warnings</p>
          <ul class="list-disc pl-5 mt-1 text-xs text-[var(--color-text-muted)]">
            {#each memberResult.warnings as warning (warning)}
              <li>{warning}</li>
            {/each}
          </ul>
        </div>
      {/if}

      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt class="font-medium">Email</dt>
        <dd>{email}</dd>
        <dt class="font-medium">User ID</dt>
        <dd class="font-mono text-xs">{memberResult.user_id}</dd>
        <dt class="font-medium">Tenant</dt>
        <dd class="text-xs">
          {memberResult.tenant_name} <span class="font-mono">({memberResult.tenant_id})</span>
        </dd>
        <dt class="font-medium">Workspace role</dt>
        <dd data-testid="super-admin-member-role">workspace-{memberResult.workspace_role}</dd>
      </dl>

      <div class="rounded border p-3 space-y-2">
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Temporary password</p>
        {#if memberCred?.kind === 'password'}
          <div class="flex items-center gap-2">
            <code class="font-mono text-sm flex-1 break-all" data-testid="super-admin-member-temp-password"
              >{memberCred.password}</code
            >
            <button
              type="button"
              class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
              onclick={() => copy('member-password', memberCred.password)}
            >
              {copiedKey === 'member-password' ? 'Copied' : 'Copy'}
            </button>
          </div>
        {:else if memberCred}
          <p class="text-sm" data-testid="super-admin-member-no-temp-password">
            {memberCred.reason} {memberCred.recovery}
          </p>
        {/if}
      </div>

      <div class="flex justify-end">
        <button
          type="button"
          class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded text-sm hover:bg-[var(--color-accent-strong)]"
          onclick={reset}
          data-testid="super-admin-member-another"
        >
          Provision another
        </button>
      </div>
    </div>
  {:else if !result}
    <form class="space-y-4" onsubmit={handleSubmit} data-testid="super-admin-form">
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Email</span>
        <input
          type="email"
          bind:value={email}
          required
          autocomplete="off"
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
          placeholder="alice@example.com"
          data-testid="super-admin-email"
        />
      </label>

      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Name</span>
        <input
          type="text"
          bind:value={name}
          required
          maxlength="200"
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
          placeholder="Alice Example"
          data-testid="super-admin-name"
        />
      </label>

      {#if !existingMode}
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">
          Phone (E.164) <span class="text-[var(--color-text-muted)]">— optional</span>
        </span>
        <input
          type="tel"
          bind:value={phone}
          pattern="^\+\d{'{10,15}'}$"
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
          placeholder="+14155551234"
          data-testid="super-admin-phone"
        />
      </label>
      {/if}

      <fieldset class="flex flex-col gap-1 text-sm" data-testid="super-admin-tenant-mode">
        <legend class="font-medium">Tenant</legend>
        <div class="flex gap-4">
          <label class="inline-flex items-center gap-2">
            <input
              type="radio"
              name="tenant-mode"
              checked={!existingMode}
              onchange={() => setTenantMode('new')}
              data-testid="super-admin-tenant-mode-new"
            />
            New tenant
          </label>
          <label class="inline-flex items-center gap-2">
            <input
              type="radio"
              name="tenant-mode"
              checked={existingMode}
              onchange={() => setTenantMode('existing')}
              data-testid="super-admin-tenant-mode-existing"
            />
            Existing tenant
          </label>
        </div>
      </fieldset>

      {#if existingMode}
        <div class="flex flex-col gap-2 text-sm" data-testid="super-admin-existing-tenant">
          <span class="font-medium">Existing tenant</span>
          <p class="text-xs text-[var(--color-text-muted)]">
            Adds this person as a member of a tenant that already exists. No licence,
            budget or seat is minted — the tenant already holds them. An account that
            already belongs to another tenant is refused, never moved.
          </p>
          {#if tenantsLoading}
            <p class="text-sm text-[var(--color-text-muted)]">Loading tenants…</p>
          {:else if tenantsError}
            <p class="text-sm text-[var(--color-danger-text)]" data-testid="super-admin-tenants-error">
              Could not load the tenant list ({tenantsError}). You can still look a tenant up by id below.
            </p>
          {/if}
          <Combobox
            value={existingTenantId}
            options={tenantOptions}
            onSelect={(value) => (existingTenantId = value)}
            placeholder="Search tenants…"
            emptyLabel={tenantsLoading ? 'Loading…' : 'No tenants listed — look one up by id'}
            data-testid="super-admin-existing-tenant-picker"
          />
          <div class="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              bind:value={tenantIdInput}
              class="flex-1 font-mono border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
              placeholder="or paste a tenant id"
              data-testid="super-admin-existing-tenant-id"
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={tenantLookupBusy || tenantIdInput.trim().length === 0}
              onclick={lookUpTenantId}
            >
              {tenantLookupBusy ? 'Looking up…' : 'Look up'}
            </Button>
          </div>
          <span class="text-xs text-[var(--color-text-muted)]">
            The list holds the tenants fr owns. A tenant fr reaches through a grant
            (for example a platform service tenant) resolves by id only.
          </span>
          {#if tenantLookupError}
            <p class="text-xs text-[var(--color-danger-text)]" data-testid="super-admin-tenant-lookup-error">
              {tenantLookupError}
            </p>
          {/if}
        </div>
      {:else}
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Tenant slug</span>
        <input
          type="text"
          bind:value={tenantSlug}
          required
          pattern="^[a-z0-9\-]{'{2,40}'}$"
          maxlength="40"
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
          placeholder="acme-engineering"
          data-testid="super-admin-tenant-slug"
        />
        <span class="text-xs text-[var(--color-text-muted)]">
          Lowercase letters, digits, hyphens. 2–40 chars.
        </span>
      </label>
      {/if}

      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Workspace role</span>
        <select
          bind:value={workspaceRole}
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
          data-testid="super-admin-role"
        >
          <option value="admin">workspace-admin</option>
          <option value="member">workspace-member</option>
        </select>
      </label>

      {#if !existingMode}
      <fieldset class="flex flex-col gap-1 text-sm">
        <legend class="font-medium">Apps</legend>
        <p class="text-xs text-[var(--color-text-muted)]">
          fr bundle: fr + fr-frontend per person. Kanban and n8n are shared fr
          platform accounts — nothing to provision per person.
        </p>
        <p class="text-xs text-[var(--color-text-muted)]">
          One license + token is minted per app, on that app's first live plan.
          To grant a license to an EXISTING user, use
          <a class="underline" href="/admin/licenses">Licensing</a>.
        </p>

        {#if catalogLoading}
          <p class="text-sm text-[var(--color-text-muted)]">Loading apps…</p>
        {:else if catalogError}
          <p class="text-sm text-[var(--color-danger-text)]" data-testid="super-admin-catalog-error">
            Could not load the app catalog ({catalogError}) — falling back to
            <code class="font-mono">{FR_PERSON_APPS.join(' + ')}</code>.
          </p>
        {:else if grantable.status === 'catalogue_missing_audience'}
          <p
            class="text-sm text-[var(--color-danger-text)]"
            data-testid="super-admin-catalog-missing-audience"
          >
            The licences catalogue returned {grantable.total} apps but none carry an
            <code class="font-mono">audience</code>. That service predates the migration that
            classifies apps, so fr cannot tell which are safe to grant to a person. Deploy
            licences first — this is not a problem with your selection.
          </p>
        {:else if grantableApps.length === 0}
          <p class="text-sm text-[var(--color-danger-text)]">
            No apps in the catalog — provisioning will fail until one exists.
          </p>
        {:else}
          <div class="grid gap-1 sm:grid-cols-2">
            {#each grantableApps as app (app.id)}
              <label class="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedApps.includes(app.key)}
                  disabled={!canUntickApp(app.key)}
                  onchange={() => toggleApp(app.key)}
                  data-testid={`super-admin-app-${app.key}`}
                />
                {appLabel(app)}
              </label>
            {/each}
          </div>
          {#if selectedApps.length === 0}
            <p class="text-xs text-[var(--color-danger-text)]">Pick at least one app.</p>
          {/if}
        {/if}
      </fieldset>

      <!--
        Per-app plan. Cascades off the ticked apps exactly as /admin/licenses
        does, and reuses its `planOptions` (so revoked plans are never offerable
        and a `null` limit never renders as "0").

        Every label comes from `planPickerEmptyLabel`, including the one that
        matters: UNSET is legal and means "the backend picks this app's first
        live plan", so the closed box must not say "Select a plan…" and imply a
        required field — and it must NOT say that either when the app has no live
        plan at all, because then there is nothing to fall back to and the run
        will fail on that app.
      -->
      {#if selectedApps.length > 0}
        <fieldset class="flex flex-col gap-3 text-sm" data-testid="super-admin-plans">
          <legend class="font-medium">Plans</legend>
          <p class="text-xs text-[var(--color-text-muted)]">
            Optional, per app. Leave one unset to keep today's behaviour — the
            licence is minted on that app's first live plan.
          </p>

          {#each selectedApps as appKey (appKey)}
            {@const load = planLoadFor(appKey)}
            {@const opts = planPickerOptions(load)}
            <div class="space-y-1" data-testid="super-admin-plan-row-{appKey}">
              <div class="flex items-center justify-between gap-2">
                <span class="font-mono text-xs">{appKey}</span>
                <button
                  type="button"
                  class="text-xs underline"
                  onclick={() =>
                    customPlanOpenFor === appKey ? closeCustomPlan() : openCustomPlan(appKey)}
                  data-testid="super-admin-custom-plan-toggle-{appKey}"
                >
                  {customPlanOpenFor === appKey ? 'Cancel custom plan' : 'Create custom plan'}
                </button>
              </div>

              <Combobox
                value={planChoices[appKey] ?? null}
                options={opts}
                onSelect={(value) => choosePlan(appKey, value)}
                placeholder="Search plans…"
                emptyLabel={planPickerEmptyLabel(load)}
                disabled={opts.length === 0}
                data-testid="super-admin-plan-picker-{appKey}"
              />

              {#if load.kind === 'error'}
                <p
                  class="text-xs text-[var(--color-danger-text)]"
                  data-testid="super-admin-plan-error-{appKey}"
                >
                  {planPickerEmptyLabel(load)}
                </p>
              {/if}

              {#if customPlanOpenFor === appKey}
                <!--
                  Posts to the EXISTING POST /api/admin/licenses/plans. Fields
                  mirror `CreatePlanBody` in backend/src/routes/admin/
                  licenses-admin.ts, which is `.strict()` — an extra key is a
                  422, so the body is built explicitly in `customPlanRequest`.
                  Blank ⇒ null (unlimited / perpetual), NEVER 0: a plan with
                  quota_monthly 0 denies every request.
                -->
                <!--
                  ⛔ A <div>, NOT a <form>. This sits INSIDE the provisioning
                  <form>, and nested forms are invalid HTML: the parser drops the
                  inner one, after which a `type="submit"` here would submit the
                  OUTER form and PROVISION A USER when the operator meant to
                  create a plan. So the action is an ordinary button.
                -->
                <div
                  class="rounded border border-[var(--color-border-strong)] p-3 space-y-2"
                  data-testid="super-admin-custom-plan-form-{appKey}"
                >
                  <p class="text-xs text-[var(--color-text-muted)]">
                    Creates a plan on <code class="font-mono">{appKey}</code> and
                    selects it here. Blank numeric fields mean unlimited
                    (perpetual for duration), not zero.
                  </p>
                  <div class="grid gap-2 sm:grid-cols-2">
                    <label class="flex flex-col gap-1 text-xs">
                      <span class="font-medium">Code</span>
                      <Input bind:value={planDraft.code} placeholder="acme-custom" />
                    </label>
                    <label class="flex flex-col gap-1 text-xs">
                      <span class="font-medium">Name</span>
                      <Input bind:value={planDraft.name} placeholder="Acme custom" />
                    </label>
                    <label class="flex flex-col gap-1 text-xs">
                      <span class="font-medium">Monthly request quota</span>
                      <Input type="number" bind:value={planDraft.quota_monthly} placeholder="blank = unlimited" />
                    </label>
                    <label class="flex flex-col gap-1 text-xs">
                      <span class="font-medium">Monthly token budget</span>
                      <Input type="number" bind:value={planDraft.token_budget_monthly} placeholder="blank = unlimited" />
                    </label>
                    <!--
                      ⛔ 2026-09-26 (fr#1046): both inputs write fields that no
                      fr request path reads. The placeholders used to say
                      "blank = unlimited", which asserts enforcement semantics
                      for an inert value. Evidence and the reason this is
                      labelled rather than enforced:
                      $lib/admin/rate-limit-enforcement.
                    -->
                    <label class="flex flex-col gap-1 text-xs">
                      <span class="font-medium">Rate limit (rpm)</span>
                      <Input type="number" bind:value={planDraft.rate_limit_rpm} placeholder={RATE_LIMIT_INPUT_PLACEHOLDER} />
                    </label>
                    <label class="flex flex-col gap-1 text-xs">
                      <span class="font-medium">Rate limit burst</span>
                      <Input type="number" bind:value={planDraft.rate_limit_burst} placeholder={RATE_LIMIT_INPUT_PLACEHOLDER} />
                    </label>
                    {#if !RATE_LIMIT_ENFORCED}
                      <p
                        class="sm:col-span-2 text-xs text-[var(--color-text-muted)]"
                        data-testid={RATE_LIMIT_NOTICE_TESTID}
                      >
                        {RATE_LIMIT_NOT_ENFORCED_NOTE}
                      </p>
                    {/if}
                    <label class="flex flex-col gap-1 text-xs">
                      <span class="font-medium">Duration (days)</span>
                      <Input type="number" bind:value={planDraft.duration_days} placeholder="blank = perpetual" />
                    </label>
                  </div>
                  {#if planCreateError}
                    <p
                      class="text-xs text-[var(--color-danger-text)]"
                      data-testid="super-admin-custom-plan-error"
                    >
                      {planCreateError}
                    </p>
                  {/if}
                  <div class="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onclick={closeCustomPlan}>Cancel</Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={creatingPlan}
                      onclick={submitCustomPlan}
                    >
                      {creatingPlan ? 'Creating…' : 'Create plan'}
                    </Button>
                  </div>
                </div>
              {/if}
            </div>
          {/each}

          {#if planRefreshNote}
            <p class="text-xs text-[var(--color-warning-text)]" data-testid="super-admin-plan-refresh-note">
              {planRefreshNote}
            </p>
          {/if}

          {#if orphanPlanChoices.length > 0}
            <p class="text-xs text-[var(--color-danger-text)]" data-testid="super-admin-orphan-plans">
              A plan is still chosen for {orphanPlanChoices.join(', ')}, which
              {orphanPlanChoices.length === 1 ? 'is' : 'are'} not selected above.
              Re-tick the app or clear the plan — this is not dropped silently.
            </p>
          {/if}
        </fieldset>
      {/if}

      <!--
        Seats. ⛔ There is NO seat-count number input and there must never be
        one: a seat IS a licence row held by a named person, and billing's live
        seat count is derived by counting those rows. A count field here would be
        a second source of truth free to disagree with what was actually minted.
      -->
      <fieldset class="flex flex-col gap-2 text-sm" data-testid="super-admin-seats">
        <legend class="font-medium">Additional people</legend>
        <p class="text-xs text-[var(--color-text-muted)]">
          Each row is one more account in the same tenant, on the same apps and
          plans. There is no "number of seats" box on purpose — a seat is a
          person holding a licence, and the count is whatever these rows mint.
        </p>

        <!-- Unkeyed on purpose: the rows carry no stable id (SeatDraft is the
             wire shape), and `seats` is a deep `$state` proxy, so `bind:` writes
             reach the array entry directly. -->
        {#each seats as seat, i}
          {@const problem = seatProblems[i]}
          <div class="space-y-1" data-testid="super-admin-seat-row">
            <div class="flex flex-col gap-2 sm:flex-row">
              <Input type="email" bind:value={seat.email} placeholder="bob@example.com" />
              <Input bind:value={seat.name} placeholder="Bob Example" />
              <Button variant="ghost" size="sm" onclick={() => removeSeat(i)}>Remove</Button>
            </div>
            {#if problem}
              <p class="text-xs text-[var(--color-danger-text)]" data-testid="super-admin-seat-problem">
                {seatProblemMessage(problem)}
              </p>
            {/if}
          </div>
        {/each}

        {#if seatCountError}
          <p class="text-xs text-[var(--color-danger-text)]" data-testid="super-admin-seat-count-error">
            {seatCountError}
          </p>
        {/if}

        <div>
          <Button variant="secondary" size="sm" onclick={addSeat}>Add another person</Button>
        </div>
      </fieldset>

      {#if inferenceConfigError}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="super-admin-inference-config-error">
          Could not read the inference configuration ({inferenceConfigError}), so the
          Inference section is not shown and this provision uses the token budget below.
        </p>
      {/if}
      {#if inferenceEnabled}
        <div class="space-y-2" data-testid="super-admin-inference">
          <label class="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={inferenceOn} data-testid="super-admin-inference-toggle" />
            Configure this tenant’s inference (budget in the selected currency)
          </label>
          {#if inferenceOn}
            <InferenceSetup bind:draft={inferenceDraft} config={inferenceConfig} mode="provision" />
          {:else}
            <p class="text-xs text-[var(--color-text-muted)]">
              Off: the tenant keeps its current inference set-up and gets the token budget below.
            </p>
          {/if}
        </div>
      {/if}

      {#if !sendInference}
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Monthly budget (tokens)</span>
        <input
          type="number"
          bind:value={monthlyBudget}
          min="1"
          step="1"
          required
          class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
          data-testid="super-admin-budget"
        />
      </label>
      {/if}

      {/if}

      <label class="inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          bind:checked={sendPasswordResetEmail}
          data-testid="super-admin-send-email"
        />
        Send Keycloak UPDATE_PASSWORD email
      </label>

      {#if error}
        <p
          class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3"
          data-testid="super-admin-error"
        >
          {error}
        </p>
      {/if}

      <div class="flex gap-2 justify-end">
        <a
          href="/admin/home"
          class="px-4 py-2 border border-[var(--color-border-strong)] rounded text-sm hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
        >
          Cancel
        </a>
        <button
          type="submit"
          disabled={submitting ||
            (existingMode
              ? !existingTenantId
              : selectedApps.length === 0 || seatsInvalid || orphanPlanChoices.length > 0)}
          class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded text-sm hover:bg-[var(--color-accent-strong)] transition-colors disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
          data-testid="super-admin-submit"
        >
          {submitting ? 'Provisioning…' : existingMode ? 'Add to tenant' : 'Provision user'}
        </button>
      </div>
    </form>
  {:else}
    <div class="space-y-4" data-testid="super-admin-result">
      <div
        class="rounded border border-[var(--color-success)] bg-[var(--color-success)] p-4 text-sm dark:bg-[var(--color-success-bg)]"
        data-testid="super-admin-result-banner"
      >
        <p class="font-semibold">
          {result.replayed
            ? 'Already provisioned — replayed, nothing new was created'
            : result.already_existed
              ? 'User already existed (idempotent)'
              : 'User created'}
        </p>
        <p class="text-xs text-[var(--color-text-muted)] mt-1">
          {result.replayed
            ? 'This email + tenant slug was already provisioned. The identity below is the existing one; one-time secrets were issued on the original call and cannot be re-fetched.'
            : 'Tokens and the temporary password are shown ONCE. Capture them now.'}
        </p>
      </div>

      {#if (result.partial_failures ?? []).length > 0}
        <div
          class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-danger-text)]"
          data-testid="super-admin-partial-failures"
        >
          <p class="font-semibold">Provisioned, but degraded — action needed</p>
          <ul class="list-disc pl-5 mt-1 text-xs">
            {#each result.partial_failures ?? [] as failure (failure)}
              <li>{failure}</li>
            {/each}
          </ul>
          <p class="text-xs mt-1">
            A <code class="font-mono">billing_quota_registration_failed</code>
            means this license has no request quota registered, so nothing is
            enforced at 402. Re-run this provision once billing is reachable.
          </p>
        </div>
      {/if}

      {#if result.catalogue?.status === 'failed'}
        <div
          class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-danger-text)]"
          data-testid="super-admin-catalogue-failed"
        >
          <p class="font-semibold">The tenant's project catalogue was not imported</p>
          <p class="text-xs mt-1">{result.catalogue.error}</p>
          <p class="text-xs mt-1">
            Until it is, this tenant cannot create projects. Re-run this provision, or use
            “Import defaults for this tenant” where fr reports the catalogue as not initialised.
          </p>
        </div>
      {/if}

      {#if (result.warnings ?? []).length > 0}
        <div
          class="rounded border border-[var(--color-border-strong)] p-3 text-sm"
          data-testid="super-admin-warnings"
        >
          <p class="font-semibold">Warnings</p>
          <ul class="list-disc pl-5 mt-1 text-xs text-[var(--color-text-muted)]">
            {#each result.warnings ?? [] as warning (warning)}
              <li>{warning}</li>
            {/each}
          </ul>
        </div>
      {/if}

      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt class="font-medium">Email</dt>
        <dd>{email}</dd>
        <dt class="font-medium">User ID</dt>
        <dd class="font-mono text-xs">{result.user_id}</dd>
        <dt class="font-medium">Tenant ID</dt>
        <dd class="font-mono text-xs">{result.tenant_id}</dd>
        <dt class="font-medium">Budget ID</dt>
        <dd class="font-mono text-xs" data-testid="super-admin-budget-id">
          {result.budget_id ?? 'none — EUR money budget (see Inference)'}
        </dd>
      </dl>

      <div class="rounded border p-3 space-y-2">
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Temporary password</p>
        <!--
          `cred` is the single decision point (see ./page-helpers): it renders a
          credential ONLY when a real one exists. An empty <code> box would look
          like a password and be a lie, so the else-branch states what actually
          happened and names the recovery path.
        -->
        {#if cred?.kind === 'password'}
          <div class="flex items-center gap-2">
            <code
              class="font-mono text-sm flex-1 break-all"
              data-testid="super-admin-temp-password"
            >{cred.password}</code>
            <button
              type="button"
              class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
              onclick={() => copy('password', cred.password)}
              data-testid="super-admin-copy-password"
            >
              {copiedKey === 'password' ? 'Copied' : 'Copy'}
            </button>
          </div>
        {:else if cred}
          <p class="text-sm" data-testid="super-admin-no-temp-password">
            {cred.reason} {cred.recovery}
          </p>
        {/if}
      </div>

      <div class="rounded border p-3 space-y-3">
        <p class="text-xs uppercase text-[var(--color-text-muted)]">License tokens</p>
        {#if tokensMessage}
          <p class="text-sm" data-testid="super-admin-no-tokens">
            {tokensMessage}
          </p>
        {/if}
        {#if Object.keys(result.license_ids ?? {}).length > 0 && Object.keys(result.tokens ?? {}).length === 0}
          <dl
            class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs"
            data-testid="super-admin-license-ids"
          >
            {#each Object.entries(result.license_ids ?? {}) as [appKey, licenseId] (appKey)}
              <dt class="font-medium">{appKey}</dt>
              <dd class="font-mono break-all">{licenseId}</dd>
            {/each}
          </dl>
        {/if}
        {#each Object.entries(result.tokens ?? {}) as [appKey, token] (appKey)}
          <div class="space-y-1" data-testid="super-admin-token-row">
            <p class="text-xs font-medium">{appKey}</p>
            <div class="flex items-center gap-2">
              <code class="font-mono text-xs flex-1 break-all">{token}</code>
              <button
                type="button"
                class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
                onclick={() => copy(`token-${appKey}`, token)}
                data-testid="super-admin-copy-token-{appKey}"
              >
                {copiedKey === `token-${appKey}` ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        {/each}
      </div>

      <!--
        Per-seat results. Each row renders its OWN status — the array length is
        the count ASKED FOR, never evidence that any seat succeeded.

        The credential slot goes through `seatCredentialState` / `seatTokensMessage`,
        which delegate to the same `credentialState` / `noTokensMessage` rules the
        primary panel uses. That is what keeps a `replayed` seat from rendering an
        empty credential box (it has no one-time secret — it created nothing), and
        what keeps a `failed` seat from rendering the "send them a password reset"
        copy, which would assert an account exists.
      -->
      {#if seatResults.length > 0}
        <div class="rounded border p-3 space-y-3" data-testid="super-admin-seats-result">
          <p class="text-xs uppercase text-[var(--color-text-muted)]">Additional people</p>
          <p class="text-sm" data-testid="super-admin-seats-summary">
            {describeSeatOutcome(seatResults)}
          </p>

          {#each seatResults as seat (seat.email)}
            {@const seatCred = seatCredentialState(seat)}
            {@const seatTokens = seatTokensMessage(seat)}
            <div class="border-t border-[var(--color-border-strong)] pt-2 space-y-1" data-testid="super-admin-seat-result">
              <div class="flex items-center gap-2">
                <Pill tone={seatStatusTone(seat.status)}>{seat.status}</Pill>
                <span class="text-sm" data-testid="super-admin-seat-headline">
                  {seatStatusHeadline(seat)}
                </span>
              </div>

              {#if seatCred?.kind === 'password'}
                <div class="flex items-center gap-2">
                  <code
                    class="font-mono text-xs flex-1 break-all"
                    data-testid="super-admin-seat-password"
                  >{seatCred.password}</code>
                  <button
                    type="button"
                    class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
                    onclick={() => copy(`seat-${seat.email}`, seatCred.password)}
                  >
                    {copiedKey === `seat-${seat.email}` ? 'Copied' : 'Copy'}
                  </button>
                </div>
              {:else if seatCred}
                <p class="text-xs" data-testid="super-admin-seat-no-password">
                  {seatCred.reason} {seatCred.recovery}
                </p>
              {/if}

              {#if seatTokens}
                <p class="text-xs" data-testid="super-admin-seat-no-tokens">{seatTokens}</p>
              {/if}
              {#each Object.entries(seat.tokens ?? {}) as [appKey, token] (appKey)}
                <div class="flex items-center gap-2" data-testid="super-admin-seat-token-row">
                  <span class="text-xs font-medium">{appKey}</span>
                  <code class="font-mono text-xs flex-1 break-all">{token}</code>
                  <button
                    type="button"
                    class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
                    onclick={() => copy(`seat-${seat.email}-${appKey}`, token)}
                  >
                    {copiedKey === `seat-${seat.email}-${appKey}` ? 'Copied' : 'Copy'}
                  </button>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      {/if}

      {#if result.inference}
        <InferenceResult
          outcome={result.inference}
          onRerun={lastInferenceInput ? rerunInferenceChecks : undefined}
          rerunning={inferenceRerunning}
          rerunError={inferenceRerunError}
        />
      {/if}

      <div class="flex justify-end">
        <button
          type="button"
          class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded text-sm hover:bg-[var(--color-accent-strong)]"
          onclick={reset}
          data-testid="super-admin-provision-another"
        >
          Provision another
        </button>
      </div>
    </div>
  {/if}

  <!--
    Offboard. Deliberately enumerated rather than described as "delete user":
    provisioning's reversal deletes the Keycloak ACCOUNT and that run's licenses
    and deregisters their billing quota, and retains everything else. Claiming
    more than that would be the same class of lie as an empty password box.
  -->
  <section class="border-t border-[var(--color-border-strong)] pt-6 space-y-3">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-lg font-semibold">Offboard a user</h2>
      <button
        type="button"
        class="px-3 py-1 border border-[var(--color-border-strong)] rounded text-xs hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
        onclick={() => (offboardOpen = !offboardOpen)}
        data-testid="super-admin-offboard-toggle"
      >
        {offboardOpen ? 'Hide' : 'Show'}
      </button>
    </div>

    {#if offboardOpen}
      <div class="space-y-3" data-testid="super-admin-offboard-panel">
        <div
          class="rounded border border-[var(--color-border-strong)] p-3 text-xs space-y-2"
        >
          <p class="font-medium">This reverses the provisioning run. It will:</p>
          <ul class="list-disc pl-5">
            <li><strong>delete the Keycloak account</strong> — the person can no longer sign in anywhere</li>
            <li>delete the license(s) that run minted</li>
            <li>deregister those licenses' billing request quotas</li>
          </ul>
          <p class="font-medium">It will NOT:</p>
          <ul class="list-disc pl-5">
            <li>delete the tenant — it is a shared registry entity with no delete API, and other people may hold licenses in it</li>
            <li>delete the fr workspace, fr role grants, the metering token budget, or the audit trail</li>
            <li>touch licenses granted separately from <a class="underline" href="/admin/licenses">Licensing</a> — revoke those there</li>
          </ul>
          <p class="text-[var(--color-text-muted)]">
            The run is addressed by email + tenant slug, so both must match what
            the account was provisioned with. Accounts created before fr was
            repointed onto the provisioning engine have no run to reverse and
            will return "no provisioning run to reverse" — nothing is deleted in
            that case.
          </p>
        </div>

        <form class="space-y-3" onsubmit={handleOffboard} data-testid="super-admin-offboard-form">
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Email</span>
            <input
              type="email"
              bind:value={offEmail}
              required
              autocomplete="off"
              class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
              placeholder="alice@example.com"
              data-testid="super-admin-offboard-email"
            />
          </label>

          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Tenant slug</span>
            <input
              type="text"
              bind:value={offTenantSlug}
              required
              pattern="^[a-z0-9\-]{'{2,40}'}$"
              maxlength="40"
              class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
              placeholder="acme-engineering"
              data-testid="super-admin-offboard-tenant-slug"
            />
          </label>

          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">
              Reason <span class="text-[var(--color-text-muted)]">— optional, recorded on the audit row</span>
            </span>
            <input
              type="text"
              bind:value={offReason}
              maxlength="500"
              class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
              placeholder="left the company"
              data-testid="super-admin-offboard-reason"
            />
          </label>

          <label class="flex flex-col gap-1 text-sm">
            <span class="font-medium">Type the email again to confirm</span>
            <input
              type="text"
              bind:value={offConfirm}
              autocomplete="off"
              class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
              data-testid="super-admin-offboard-confirm"
            />
          </label>

          {#if offError}
            <p
              class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3"
              data-testid="super-admin-offboard-error"
            >
              {offError}
            </p>
          {/if}

          {#if offResult}
            <div
              class="rounded border border-[var(--color-border-strong)] p-3 text-sm space-y-1"
              data-testid="super-admin-offboard-result"
            >
              <p class="font-semibold">
                {offResult.already_deprovisioned
                  ? 'Already offboarded — nothing changed on this call'
                  : 'Offboarded'}
              </p>
              <ul class="list-disc pl-5 text-xs">
                <li>
                  Keycloak account: {offResult.keycloak_user_deleted
                    ? 'deleted'
                    : 'was already gone'}
                </li>
                <li>Licenses deleted: {offResult.licenses_deleted}</li>
                <li>
                  Billing quota: {offResult.billing_quota_retained
                    ? 'STILL REGISTERED — deregistration failed, remove it manually'
                    : 'deregistered'}
                </li>
                <li>Tenant {offResult.tenant_id ?? '(unknown)'}: retained</li>
                <li>Retained in fr: {offResult.fr_local_retained.join(', ')}</li>
              </ul>
            </div>
          {/if}

          <div class="flex justify-end">
            <button
              type="submit"
              disabled={offSubmitting || !offConfirmed}
              class="px-4 py-2 border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] rounded text-sm disabled:opacity-50"
              data-testid="super-admin-offboard-submit"
            >
              {offSubmitting ? 'Offboarding…' : 'Offboard user'}
            </button>
          </div>
        </form>
      </div>
    {/if}
  </section>
</section>
{/if}
