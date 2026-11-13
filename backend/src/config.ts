// src/config.ts
import { parseCallbackOrigins } from './lib/callback-origins';
import { signupDeciderIssuers, signupIntakeIssuers } from './services/signup/config';

// Declared before `config` below, which reads them at module init (no TDZ).
/** Default per-attempt timeout of the conveyor start POST (services/conveyor-start-webhook.ts). */
export const CONVEYOR_START_WEBHOOK_TIMEOUT_DEFAULT_MS = 30_000;
const CONVEYOR_START_WEBHOOK_TIMEOUT_MIN_MS = 1_000;
const CONVEYOR_START_WEBHOOK_TIMEOUT_MAX_MS = 120_000;

function parseAudiences(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/**
 * Allowed browser origins for CORS. The dev default (`http://localhost:3000`)
 * applies ONLY outside production: production fr was answering every request
 * with `Access-Control-Allow-Origin: http://localhost:3000` (fr#1471 live
 * check). In production the default is no cross-origin access at all (browsers
 * reach fr-backend same-origin through the SvelteKit proxy), and a loopback
 * origin supplied via CORS_ORIGINS is dropped with a warning rather than
 * honoured — a dev origin must never be trusted with credentials in prod.
 */
export function parseCorsOrigins(raw: string | undefined, env: string): string[] {
  const listed = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (env !== 'production') return listed.length ? listed : ['http://localhost:3000'];
  const dropped = listed.filter((o) => LOOPBACK_ORIGIN.test(o));
  if (dropped.length) {
    console.warn(`[config] CORS_ORIGINS: dropping loopback origin(s) in production: ${dropped.join(', ')}`);
  }
  return listed.filter((o) => !LOOPBACK_ORIGIN.test(o));
}

/** Thrown on first access to `config.database.url` (and at boot) when DATABASE_URL is unset/blank. */
export const DATABASE_URL_UNSET_MESSAGE = '[fr] DATABASE_URL is unset: refusing to start';

/**
 * The configured DSN, or throw DATABASE_URL_UNSET_MESSAGE. Read from the environment at call time
 * (not frozen at import) so a process that sets DATABASE_URL before its first DB use is honoured.
 * A whitespace-only value is unset.
 */
export function requireDatabaseUrl(): string {
  const url = configuredDatabaseUrl();
  if (url === undefined) throw new Error(DATABASE_URL_UNSET_MESSAGE);
  return url;
}

/** DATABASE_URL, or undefined when unset/blank. Never throws; never substitutes a default. */
export function configuredDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  return url === undefined || url.trim() === '' ? undefined : url;
}

// ── Realm-per-app F1 (~/.claude/plans/program/realm-per-app-studio-kag-fr-runbook.md, "fr") ──
// Mirrors commonpractice #480. Every default reproduces today's single-issuer behaviour, so NOTHING
// changes until gitops sets the env below.
const keycloakDefaultIssuer = (
  process.env.KEYCLOAK_ISSUER ||
  (process.env.KEYCLOAK_URL
    ? `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM || 'portal'}`
    : '')
).replace(/\/+$/, '');

function csvList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stripSlash(s: string): string {
  return s.trim().replace(/\/+$/, '');
}

/**
 * The realm named by a Keycloak issuer URL (`https://host/realms/<realm>` → `<realm>`), or undefined
 * when the URL carries no `/realms/<name>` suffix.
 */
export function realmOfIssuer(issuer: string): string | undefined {
  const m = /\/realms\/([^/]+)\/?$/.exec(issuer);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

/**
 * KEYCLOAK_TRUSTED_ISSUERS — CSV of FULL issuer URLs whose tokens fr verifies, each against its own
 * realm's JWKS with `iss` pinned to that exact value. Default `[KEYCLOAK_ISSUER]` (today). Read live.
 * Trailing slashes are stripped (Keycloak's `iss` never carries one). Empty only when no issuer is
 * configured at all (dev/test without KEYCLOAK_URL) — the verifier then keeps its legacy path.
 */
export function keycloakTrustedIssuers(): string[] {
  const explicit = csvList(process.env.KEYCLOAK_TRUSTED_ISSUERS).map(stripSlash).filter(Boolean);
  if (explicit.length > 0) return explicit;
  return keycloakDefaultIssuer ? [keycloakDefaultIssuer] : [];
}

/**
 * KEYCLOAK_SERVICE_ONLY_REALMS — realms whose tokens are accepted ONLY on the service doors (bridge,
 * conveyor, signup intake/decider — each pinned to its own issuer). Default `secure-apps`. ⛔
 * secure-apps holds HUMAN accounts too, so a token from it must never become an fr user session.
 */
export function keycloakServiceOnlyRealms(): string[] {
  const list = csvList(process.env.KEYCLOAK_SERVICE_ONLY_REALMS);
  return list.length > 0 ? list : ['secure-apps'];
}

/** True when `issuer` names a KEYCLOAK_SERVICE_ONLY_REALMS realm. */
export function isServiceOnlyIssuer(issuer: string): boolean {
  const realm = realmOfIssuer(issuer);
  return realm !== undefined && keycloakServiceOnlyRealms().includes(realm);
}

/**
 * A service door's accepted issuers: a CSV of FULL issuer URLs (trailing slashes stripped), default
 * `[KEYCLOAK_ISSUER]`. A LIST so a door's client can move realm (portal → secure-apps, realm-per-app
 * P7) with no outage: the door accepts both while the caller flips, then the old issuer is dropped.
 * Each entry must be in KEYCLOAK_TRUSTED_ISSUERS (production boot refuses otherwise).
 */
export function doorIssuerList(raw: string | undefined): string[] {
  const list = csvList(raw).map(stripSlash).filter(Boolean);
  if (list.length > 0) return list;
  return keycloakDefaultIssuer ? [keycloakDefaultIssuer] : [];
}

/** FR_BRIDGE_ISSUER — the issuer(s) the commonpractice-bridge SA is accepted from (CSV, default KEYCLOAK_ISSUER). */
export function frBridgeIssuers(): string[] {
  return doorIssuerList(process.env.FR_BRIDGE_ISSUER);
}

/**
 * FR_FLOW_RUN_ISSUER — the issuer(s) the n8n execution-hook service account is accepted from on
 * POST /api/internal/conveyor/flow-runs (CSV, default KEYCLOAK_ISSUER). Cockpit A5 / R-CK5.
 */
export function frFlowRunIssuers(): string[] {
  return doorIssuerList(process.env.FR_FLOW_RUN_ISSUER);
}

/**
 * FR_FLOW_RUN_WRITER_AZP — the Keycloak client(s) (`azp`, CSV) whose CLIENT-CREDENTIALS token may
 * write flow runs. NO default: empty admits nobody (the route answers 503, fail closed).
 */
export function frFlowRunWriterAzps(): string[] {
  return csvList(process.env.FR_FLOW_RUN_WRITER_AZP);
}

/** FR_CONVEYOR_ISSUER — the issuer(s) the conveyor-priority identity is honoured from (CSV, default KEYCLOAK_ISSUER). */
export function frConveyorIssuers(): string[] {
  return doorIssuerList(process.env.FR_CONVEYOR_ISSUER);
}

/**
 * FR_SUPER_ADMIN_SWITCH_ISSUER — the issuer(s) (CSV, full URLs) whose `super_admin` tokens get the
 * George 2026-10-27 arm: switch into any live customer workspace and act there as tenant-admin.
 * Production: `https://auth.nonagentic.ai/realms/fr` (gitops fr Deployment).
 *
 * ⛔ NO DEFAULT, deliberately (coordinator decision 2026-10-27): nothing is derived from
 * KEYCLOAK_URL / KEYCLOAK_REALM / KEYCLOAK_USER_REALM, because every one of those can name the portal
 * realm. Unset ⇒ the arm is OFF (every customer switch is 403 `untrusted_session`) and the server
 * logs `superAdminSwitchConfigWarning()` at boot. Read live (tests set it per case).
 */
export function frSuperAdminSessionIssuers(): string[] {
  return csvList(process.env.FR_SUPER_ADMIN_SWITCH_ISSUER).map(stripSlash).filter(Boolean);
}

/**
 * FR_SUPER_ADMIN_SWITCH_AZP — the Keycloak client(s) (`azp`, CSV) of fr's HUMAN browser login whose
 * super_admin tokens get that arm. Production: `fr-frontend` (the fr realm's browser client —
 * VITE_KEYCLOAK_CLIENT_ID). ⛔ NO DEFAULT: unset ⇒ the arm is OFF, same as the issuer.
 */
export function frSuperAdminSessionAzps(): string[] {
  return csvList(process.env.FR_SUPER_ADMIN_SWITCH_AZP);
}

/**
 * The boot warning when the super-admin tenant-admin arm is OFF because its config is missing, or
 * `null` when both FR_SUPER_ADMIN_SWITCH_ISSUER and FR_SUPER_ADMIN_SWITCH_AZP are set.
 */
export function superAdminSwitchConfigWarning(): string | null {
  const missing = [
    frSuperAdminSessionIssuers().length === 0 ? 'FR_SUPER_ADMIN_SWITCH_ISSUER' : null,
    frSuperAdminSessionAzps().length === 0 ? 'FR_SUPER_ADMIN_SWITCH_AZP' : null,
  ].filter((v): v is string => v !== null);
  if (missing.length === 0) return null;
  return (
    `[super-admin-switch] ${missing.join(' and ')} unset: the super_admin tenant-admin arm is OFF — ` +
    'every super_admin switch into a customer workspace is refused (403 untrusted_session).'
  );
}

/**
 * The realm-per-app config problems (empty when sound): an empty trusted list, a door pin outside it,
 * or a half-set user-realm admin client. `validateProductionConfig` refuses boot on any of them.
 * The signup pins are passed in (services/signup/config.ts owns them; importing it here would cycle).
 */
export function keycloakRealmConfigProblems(signupPins: { intake: string[]; decider: string[] }): string[] {
  const out: string[] = [];
  const id = (process.env.KEYCLOAK_USER_REALM_ADMIN_CLIENT_ID ?? '').trim();
  const secret = (process.env.KEYCLOAK_USER_REALM_ADMIN_CLIENT_SECRET ?? '').trim();
  if (Boolean(id) !== Boolean(secret)) {
    out.push('KEYCLOAK_USER_REALM_ADMIN_CLIENT_ID and KEYCLOAK_USER_REALM_ADMIN_CLIENT_SECRET (set both or neither)');
  }
  // Realm-per-app P7 chain C: the S2S token realm (lib/service-authenticators.ts
  // serviceTokenUsesSecureApps) — empty, or exactly the secure-apps realm.
  const serviceRealm = (process.env.KEYCLOAK_SERVICE_REALM ?? '').trim();
  const secureAppsRealm = (process.env.KEYCLOAK_SECURE_APPS_REALM ?? '').trim();
  if (serviceRealm !== '' && serviceRealm !== secureAppsRealm) {
    out.push(`KEYCLOAK_SERVICE_REALM (${serviceRealm} is not KEYCLOAK_SECURE_APPS_REALM ${secureAppsRealm || '<unset>'})`);
  }
  const trusted = keycloakTrustedIssuers();
  if (trusted.length === 0) {
    out.push('KEYCLOAK_TRUSTED_ISSUERS (empty list — no token could ever verify)');
    return out;
  }
  for (const [name, pins] of [
    ['FR_BRIDGE_ISSUER', frBridgeIssuers()],
    ['FR_CONVEYOR_ISSUER', frConveyorIssuers()],
    ['FR_FLOW_RUN_ISSUER', frFlowRunIssuers()],
    ['FR_SIGNUP_INTAKE_ISSUER', signupPins.intake],
    ['FR_SIGNUP_DECIDER_ISSUER', signupPins.decider],
  ] as const) {
    if (pins.length === 0) out.push(`${name} (<empty> is not in KEYCLOAK_TRUSTED_ISSUERS)`);
    for (const iss of pins) {
      if (!trusted.includes(iss)) out.push(`${name} (${iss} is not in KEYCLOAK_TRUSTED_ISSUERS)`);
    }
  }
  return out;
}

export const config = {
  // Server
  port: parseInt(process.env.PORT || '8888'),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',

  // Public base URL of fr-backend, used to build absolute links in
  // outbound notifications. When empty, callers
  // emit RELATIVE URLs (`/api/assets/artifacts/...`) and channel
  // adapters that need an absolute URL (cross-host email) document
  // their own fallback. Set in production to `https://fr.nonagentic.ai`.
  publicBaseUrl: (process.env.FR_PUBLIC_URL || '').replace(/\/+$/, ''),

  // Database — ⛔ NO DEFAULT DSN (George ruling 2026-10-21: no service defaults to a local-host
  // Postgres). It used to fall back to a `postgres:postgres@` DSN on the local host, port 5432.
  // The getter is LAZY on purpose: CI guard steps (e.g. check-served-spec)
  // import this module with no DATABASE_URL and never touch the database, so the refusal
  // fires on ACCESS, never at import. db/client.ts never reads this getter at import; with no URL
  // its pool refuses on first query (an empty URL handed to postgres-js would silently fall back
  // to PG* env → localhost).
  database: {
    get url(): string {
      return requireDatabaseUrl();
    },
  },

  // Redis
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  // Keycloak
  //
  // KEYCLOAK_URL is the FETCH base — used for JWKS discovery, admin API,
  // and client-credentials token endpoints. May safely point at an
  // in-cluster service URL (e.g. http://keycloak.example.com:8080)
  // to avoid Cloudflare egress.
  //
  // KEYCLOAK_ISSUER is the CLAIM string compared against the JWT `iss`
  // field during verification. It MUST match what Keycloak embeds in
  // tokens, which is the public URL the user's browser hit
  // (e.g. https://auth.nonagentic.ai/realms/portal). When unset, falls
  // back to `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}` so existing
  // single-URL deployments keep working unchanged.
  //
  // Per deployment/docs/config-externalization-policy.md and the
  // 2026-05-09 user directive: NO hardcoded URL fallbacks. KEYCLOAK_URL
  // is enforced in production by `validateProductionConfig` below; in
  // dev/test it stays empty unless the operator sets it.
  keycloak: {
    url: process.env.KEYCLOAK_URL || '',
    realm: process.env.KEYCLOAK_REALM || 'portal',
    // (trailing slash stripped — see keycloakDefaultIssuer above; Keycloak's `iss` never has one)
    issuer: keycloakDefaultIssuer,
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'fr-backend',
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || '',
    // Realm-per-app F1: the realm fr's USERS live in — the realm the admin API looks up / creates /
    // invites / execute-actions-emails users in. Defaults to KEYCLOAK_REALM, so nothing moves until
    // gitops sets KEYCLOAK_USER_REALM.
    userRealm: (process.env.KEYCLOAK_USER_REALM || '').trim() || process.env.KEYCLOAK_REALM || 'portal',
    // Optional admin client living IN the user realm. When BOTH are set the admin API authenticates in
    // KEYCLOAK_USER_REALM with them; otherwise exactly as today (KEYCLOAK_REALM + KEYCLOAK_CLIENT_*).
    // Half-set is refused at production boot (keycloakRealmConfigProblems).
    userRealmAdminClientId: (process.env.KEYCLOAK_USER_REALM_ADMIN_CLIENT_ID || '').trim(),
    userRealmAdminClientSecret: (process.env.KEYCLOAK_USER_REALM_ADMIN_CLIENT_SECRET || '').trim(),
    // Comma-separated list of accepted JWT audiences. When unset/empty,
    // aud validation is skipped (mirrors w2v_common bb9380d).
    audiences: parseAudiences(process.env.KEYCLOAK_AUDIENCES),
    // Write-through of fr workspace-admin grants/revokes to the portal realm
    // role `tenant_admin` ("a fr admin is a tenant_admin", fr#1289). See
    // `services/tenant-admin-sync.ts`.
    //
    // DEFAULT OFF — the fr-backend service account does not yet hold the
    // Keycloak `manage-users` permission needed to map realm roles; enabling
    // this before that grant makes every sync return 'failed' (and every
    // revoke refuse with 502).
    tenantAdminWriteThrough:
      (process.env.FR_TENANT_ADMIN_WRITE_THROUGH || 'false').toLowerCase() === 'true',
  },

  // External Services
  //
  // All baseUrl values default to '' (empty string) per the
  // config-externalization-policy. `validateProductionConfig` below
  // refuses to boot in NODE_ENV=production when any required service URL
  // is unset, so a misconfigured deploy fails LOUD at startup instead of
  // silently routing traffic to a dead in-cluster service name. Dev/test
  // environments may leave URLs empty and let individual integrations
  // skip / mock at the call site.
  services: {
    n8n: {
      webhookUrl: process.env.N8N_WEBHOOK_URL || '',
      apiUrl: process.env.N8N_API_URL || '',
      apiKey: process.env.N8N_API_KEY || '',
      // Shared secret for BOTH directions between fr and n8n: it gates inbound
      // n8n → fr webhooks, and fr sends it as `X-Webhook-Secret` on every
      // outbound fr → n8n webhook trigger (services/n8n.ts callWebhook,
      // integrations/n8n.ts triggerWorkflow).
      // n8n holds the same value as FR_BACKEND_N8N_WEBHOOK_SECRET.
      webhookSecret: process.env.N8N_WEBHOOK_SECRET || '',
      // Outbound shared secret on approval-decision callbacks (fr → n8n).
      // Paired with the same key in the n8n SealedSecret; the universal
      // improvement-approval-callback receiver workflow rejects requests
      // whose X-Approval-Callback-Secret header does not match. Disjoint
      // from N8N_WEBHOOK_SECRET (which gates inbound n8n → fr webhooks)
      // because the rotation paths are independent.
      approvalCallbackSecret: process.env.APPROVAL_CALLBACK_SECRET || '',
      // AA "Logical Thinking Process" (TOC) builder subroutine workflow ids.
      // The TOC agent-callable write actions (agui/actions/toc.ts) resolve
      // these to trigger the heavy author paths (IO-Map / Evaporating-Cloud /
      // CLR-lens authoring) that write trees back into requirements_management.
      // Optional + fail-at-call-site when unset (NOT in the prod required-URL
      // list) — the read/CRUD proxy surface works without them; only the
      // build actions need them, and only where the AA orchestrator doesn't
      // already cover the flow. Known ids (2026-05-31):
      //   AA Subroutine - Build IO Map           = IkVw5MzHYwAbdrTL
      //   AA Subroutine - Build Evaporating Cloud = n7NJ3ZbezwmkOitX
      aaBuildIoMapWorkflowId: process.env.AA_BUILD_IO_MAP_WORKFLOW_ID || '',
      aaBuildEvaporatingCloudWorkflowId:
        process.env.AA_BUILD_EVAPORATING_CLOUD_WORKFLOW_ID || '',
      aaEvaluateLensesWorkflowId:
        process.env.AA_EVALUATE_LENSES_WORKFLOW_ID || '',
      // Webhook PATHS for the on-demand TOC build actions. n8n's public API
      // has NO run-by-id endpoint (`POST /api/v1/workflows/{id}/run` → 405),
      // so the build actions trigger the AA builder subroutines via their
      // production webhook (n8n.svc/webhook/<path>) using triggerWorkflow().
      // Defaults are the builders' PRODUCTION webhook paths
      // (`aa-subroutine-build-*`, authenticated by X-Webhook-Secret on the n8n
      // side). They replaced the old `test-subroutine-build-*` test webhooks,
      // which were unauthenticated and are being removed from n8n. The
      // workflow ids above are kept only for the execution→project mapping row.
      // No lens-eval builder/webhook exists yet → toc.evaluate_lenses stays
      // unconfigured (fails at call-site) until the lens-read work (plan §2.2).
      aaBuildIoMapWebhook:
        process.env.AA_BUILD_IO_MAP_WEBHOOK || 'aa-subroutine-build-io-map',
      aaBuildEvaporatingCloudWebhook:
        process.env.AA_BUILD_EVAPORATING_CLOUD_WEBHOOK ||
        'aa-subroutine-build-evaporating-cloud',
      aaEvaluateLensesWebhook: process.env.AA_EVALUATE_LENSES_WEBHOOK || '',
      // Webhook PATH fr posts `lease.released` to (services/card-phase-lease-events.ts)
      // after a card phase lease is released, superseded on expiry, or preempted by
      // the watchdog — the event-driven QA re-pull. Fire-and-forget via
      // callWebhook (X-Webhook-Secret); a failure only counts
      // fr_card_phase_lease_release_emit_failures_total.
      // DEFAULT OFF (empty ⇒ the emitter is a no-op), same shape as
      // aaEvaluateLensesWebhook above: the consumer (`aa-qa-repull`) is not in
      // n8n yet. Arm by setting the env in gitops together with the consumer.
      leaseReleasedWebhook: process.env.AA_LEASE_RELEASED_WEBHOOK || '',
      // CONVEYOR START WEBHOOK (services/conveyor-start-webhook.ts): after a project
      // is created and its RM pm_project + Planka board exist, fr POSTs
      // `{event:'project.created', rm_project_id, tenant_id, fr_project_id}` ONCE to
      // this FULL URL (n8n's start webhook, possibly cluster-internal), signed
      // `X-FR-Signature: sha256=<HMAC-SHA256(body, secret)>` AND `X-Conveyor-Token: <secret>`
      // (same secret, for n8n's Webhook Header Auth), `Idempotency-Key: <fr id>`.
      //   * conveyorStartWebhookUrl    — NON-SECRET (ConfigMap). Empty ⇒ inert (one
      //     boot log line, no POST).
      //   * conveyorStartWebhookSecret — SECRET (secret-bound env). REQUIRED when the
      //     URL is set: validateConveyorStartWebhookConfig() refuses to boot without it.
      // fr-agui P3 (SPEC §7.4a) — how the conveyor tags its n8n executions with the
      // fr project (`projects.list_conveyor_executions`). NON-SECRET (ConfigMap).
      // DEFAULT OFF: empty ⇒ the read answers `available:false,
      // reason:'conveyor_runs_untagged'` and calls nothing. Set to `custom_data`
      // ONLY once the conveyor sets `fr_project_id` + `fr_tenant_id` custom data on
      // every execution (the cross-repo §7.4a issue): fr then reads the n8n public
      // executions list and keeps only executions whose custom data names the
      // bound project AND its tenant. Any other value is refused the same way.
      conveyorRunTags: (process.env.FR_CONVEYOR_RUN_TAGS || '').trim(),
      // The n8n instance the conveyor v4 runs on — NOT fr's default n8n client
      // (`apiUrl` / `apiKey` above): v4 runs live on another instance, so reading
      // fr's own n8n would answer a confident `available:true, runs:[]`. The flag
      // above is honoured ONLY with BOTH of these set; otherwise the read answers
      // `available:false, reason:'conveyor_instance_unconfigured'` and calls nothing.
      //   * conveyorRunsN8nUrl    — NON-SECRET (ConfigMap): that instance's public API base (…/api/v1).
      //   * conveyorRunsN8nApiKey — SECRET (secret-bound env): its X-N8N-API-KEY.
      conveyorRunsN8nUrl: (process.env.FR_CONVEYOR_RUNS_N8N_URL || '').trim(),
      conveyorRunsN8nApiKey: (process.env.FR_CONVEYOR_RUNS_N8N_API_KEY || '').trim(),
      conveyorStartWebhookUrl: (process.env.CONVEYOR_START_WEBHOOK_URL || '').trim(),
      conveyorStartWebhookSecret: process.env.CONVEYOR_START_WEBHOOK_SECRET || '',
      // Per-attempt timeout of the start POST, ms (NON-SECRET, ConfigMap). Unset ⇒
      // 30 000. MEASURED 2026-10-21 (project ff8bb1f0, n8n execs 1214206/07/10): an R320
      // restart took 13.8 s and even the `running` guard answer ~10 s, so the old fixed
      // 10 s timed out all three attempts and recorded a restart that HAPPENED as failed.
      // A malformed value (not an integer in [1000, 120000]) refuses to boot
      // (validateConveyorStartWebhookConfig).
      conveyorStartWebhookTimeoutMs: parseConveyorStartWebhookTimeoutMs(process.env.CONVEYOR_START_WEBHOOK_TIMEOUT_MS),
      // R320 (services/conveyor-failures.ts): offer "Start again" for a STALLED start card
      // (READY/DOING, no progress for 30 min). NON-SECRET (ConfigMap). DEFAULT OFF: turn on
      // only once the conveyor answers such a start 200 {accepted, restarted|running}; before
      // that it answers `duplicate` / 409 psra_exists and fr shows "could not restart".
      conveyorStartStalledRetry: (process.env.CONVEYOR_START_STALLED_RETRY || 'false').toLowerCase() === 'true',
      // D17 — N8N_CALLBACK_ORIGINS (non-secret, ConfigMap): comma-separated http(s)
      // ORIGINS a licence-minted approval's `callback_url` (the n8n Wait node's
      // resume URL) may point at (lib/approval-callback-url.ts). DEFAULT EMPTY ⇒
      // every callback_url is refused 422 `callback_url_not_allowed`.
      // validateN8nCallbackOriginsConfig() refuses to boot on a malformed entry.
      callbackOrigins: (process.env.N8N_CALLBACK_ORIGINS || '').trim(),
      // fr-initiated TOC workflow hooks (plan §5 B/C; A removed). DEFAULT OFF +
      // coordination-gated: the AA n8n orchestrator ALREADY builds IO-Maps at
      // project-start and auto-ECs on QA conflicts, so firing these from fr
      // risks double-building the same tree. Turn one on ONLY after confirming
      // the AA path does NOT already cover that fr-initiated flow. Each hook is
      // additionally a no-op unless its target workflow id (above) is set, and
      // is best-effort/non-blocking (a failure never breaks the user action).
      hookEvaporateOnBlocked:
        (process.env.AA_HOOK_EVAPORATE_ON_BLOCKED || 'false').toLowerCase() === 'true',
      hookClrCheckOnImprovementApproval:
        (process.env.AA_HOOK_CLR_CHECK_ON_IMPROVEMENT_APPROVAL || 'false').toLowerCase() ===
        'true',
    },
    teams: {
      // When enabled, the teams notification channel is registered and
      // outbound adaptive cards can be posted to Incoming Webhook URLs.
      // The recipient address passed to `send()` is itself the webhook URL
      // (so multiple Teams channels can be targeted per approval).
      enabled: (process.env.TEAMS_ENABLED || 'false').toLowerCase() === 'true',
      // Optional default webhook URL used when a recipient entry in
      // fanOut() has an empty/placeholder address.
      webhookUrl: process.env.TEAMS_WEBHOOK_URL || '',
      // Optional shared secret used to validate inbound action callbacks.
      // When empty, signature validation is skipped (rely on network policy).
      webhookSecret: process.env.TEAMS_WEBHOOK_SECRET || '',
      // Public callback URL embedded in adaptive-card actions. MUST be
      // set in production; validated by `validateProductionConfig` below.
      callbackUrl: process.env.TEAMS_CALLBACK_URL || '',
    },
    // Approval routing (migration 101). The tenant-independent human of last resort.
    //
    // MEASURED 2026-08-18, and the reason this exists: of the 8 tenants that have ever
    // raised an approval, exactly ONE (…0003) has a workspace-admin reachable on a push
    // channel. Tenant …0001 alone raised 200. Without a fallback, refusing to create an
    // unroutable approval would convert a silent 24h timer into a hard 422 for seven of
    // eight tenants — trading a quiet bug for a loud outage, which is not an improvement.
    //
    // So: unroutable falls back to this human rather than to nobody. Leave it UNSET and
    // the routing throws instead, which is the correct behaviour for a deployment that
    // has deliberately configured a reachable admin per tenant.
    approvals: {
      fallbackApproverUserId: process.env.APPROVAL_FALLBACK_APPROVER_USER_ID || '',
    },
    mcp: {
      // The `mcp` engagement channel: the MCP server is one more channel, like
      // Telegram. Inbound: POST /api/webhooks/mcp/incoming (signed). Outbound:
      // approvals and replies POSTed to `eventsUrl`. Both directions sign with
      // `secret` (SOPS-managed, shared only with the MCP server). Always on: a
      // blank secret fails every signature closed, so unconfigured = refuses.
      eventsUrl: process.env.MCP_EVENTS_URL || '',
      secret: process.env.FR_MCP_CHANNEL_SECRET || '',
    },
    telegram: {
      // When enabled, the telegram notification channel is registered and
      // outbound approvals/messages are posted via the Bot API through the
      // dedicated bot account (frn8n_bot).
      enabled: (process.env.TELEGRAM_ENABLED || 'false').toLowerCase() === 'true',
      // Bot API base. `sendMessage` is called as `${apiUrl}/bot${botToken}/sendMessage`.
      apiUrl: process.env.TELEGRAM_API_URL || 'https://api.telegram.org',
      // @BotFather token. SOPS-encrypted secret only — never committed plaintext.
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      // The frn8n supergroup chat id (a `-100…`). Used as the default outbound
      // destination when a per-user channel pref's `address` is not itself a
      // numeric Telegram chat/user id (i.e. a DM target the user has /start-ed).
      chatId: process.env.TELEGRAM_CHAT_ID || '',
      // Echoed by Telegram in the `X-Telegram-Bot-Api-Secret-Token` header on
      // every inbound update; the webhook handler rejects mismatches. Generate
      // with `openssl rand -hex 32`. When empty, header validation is skipped
      // (rely on the in-cluster network path — Telegram → n8n → fr).
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
      // When true, approval/notification sends that carry a project context are
      // posted into the forum supergroup (config.chatId) inside ONE topic per
      // project (named after the project), instead of the recipient's DM. The
      // (chat_id, project_id) -> message_thread_id map is cached in
      // telegram_forum_topics. Requires config.chatId to be a forum supergroup.
      useTopics: (process.env.TELEGRAM_USE_TOPICS || 'false').toLowerCase() === 'true',
    },
    email: {
      // Shared secret presented by the inbound mail provider on
      // POST /api/webhooks/email/incoming, in the `X-Email-Webhook-Secret`
      // header. Its own variable, disjoint from TELEGRAM_WEBHOOK_SECRET,
      // so the channels rotate independently (same reasoning as the
      // n8n webhookSecret / approvalCallbackSecret split above).
      //
      // Deliberately NOT added to `validateProductionConfig`'s required list:
      // the per-channel receiver secrets (telegram, email) all
      // fail closed at REQUEST time via `isAuthorizedBySharedSecret` instead.
      // See the header of utils/webhook-secret.ts — fr's image also runs as
      // kag-frontend/kag, whose secret does not carry these vars, and a boot
      // guard on a var one deployment lacks CrashLoops that deployment.
      webhookSecret: process.env.EMAIL_WEBHOOK_SECRET || '',
    },
    planka: {
      baseUrl: process.env.PLANKA_BASE_URL || '',
      email: process.env.PLANKA_AGENT_EMAIL || 'agent@example.com',
      password: process.env.PLANKA_AGENT_PASSWORD || '',
      termsPath: process.env.PLANKA_TERMS_PATH || '/api/terms',
      acceptTermsPath: process.env.PLANKA_ACCEPT_TERMS_PATH || '/api/access-tokens/accept-terms',
      defaultLanguage: process.env.PLANKA_DEFAULT_LANGUAGE || 'en-US',
      // Planka user id of the n8n conveyor's own Planka account
      // (deployment#4397). When set, every NEW board fr creates for a
      // PLATFORM tenant also gets this user as `editor`; customer-tenant boards
      // never do. Empty ⇒ the grant is skipped entirely (inert until set).
      conveyorUserId: process.env.PLANKA_CONVEYOR_USER_ID || '',
      // Planka webhook rows a NEW board is subscribed to (planka-private#24:
      // delivery is opt-in per board). Platform-tenant boards → the conveyor
      // n8n row; kata-tenant boards → the kata-n8n row.
      conveyorWebhookName: process.env.PLANKA_CONVEYOR_WEBHOOK_NAME || 'n8n-per-flow',
      kataWebhookName: process.env.PLANKA_KATA_WEBHOOK_NAME || 'kata-n8n-per-flow',
    },
    workers: {
      baseUrl: process.env.WORKERS_API_URL || '',
    },
    // Single FastAPI upstream (Service name `requirements`, port 8921) serves
    // all three asset types: requirements, principles, decisions. The
    // principles/decisions integrations read `config.services.requirements.baseUrl`
    // directly (see src/integrations/{principles,decisions}.ts), so there's
    // one knob here.
    requirements: {
      baseUrl: process.env.REQUIREMENTS_API_URL || '',
    },
    // Planka kanban upstream. Reuses the Planka base host but pins the `/api`
    // prefix because the generated @fr/service-client-kanban URL builders
    // emit bare resource paths (e.g. `/projects`, `/boards/{id}`).
    kanban: {
      baseUrl:
        process.env.KANBAN_API_URL ||
        (process.env.PLANKA_BASE_URL ? `${process.env.PLANKA_BASE_URL}/api` : ''),
    },
    // coding-gateway is the aggregate entry point for all coding-* microservices
    // (architecture, dependencies, quality, containers, testing, …). The legacy
    // CODE_GRAPH_HELPER_URL fallback is gone: code-graph-helper was archived
    // 2026-05-27, so CODING_GATEWAY_URL is the only name read.
    codingGateway: process.env.CODING_GATEWAY_URL || '',
    // In-cluster service DNS — avoids a private TLS bundle dependency.
    // Istio ambient mesh provides mTLS at L4; HTTP here is fine.
    // KAG unified API gateway (docs: <KAG_API_URL>/docs).
    // KAG_API_URL is the canonical env var; KAG_INGESTION_URL is kept as a
    // fallback for older deployments that set only the ingestion URL.
    //
    // OPTIONAL: the KAG family was removed from the cluster (gitops #4968,
    // 2026-10-30). Unset ⇒ every client built on this base URL (kag, research,
    // media) refuses before any fetch with SERVICE_NOT_CONFIGURED (503, see
    // integrations/_lib/http-client.ts), and the reviews proxy answers its own
    // 503 `upstream_not_configured`. Deliberately NOT in the required-URL gate.
    kag: {
      baseUrl:
        process.env.KAG_API_URL ||
        process.env.KAG_INGESTION_URL ||
        '',
    },
    // evidence_review_service (ER-001..005) — the `/reviews/*` surface behind
    // `/api/assets/kag/reviews`. A SEPARATE service that today merely happens to
    // be fronted by the kag gateway, which is why it gets its own var: every
    // other distinct upstream in this file (kagOrchestrator, secrets, artifacts,
    // metering) already has one, and reviews was the outlier.
    //
    // Named EVIDENCE_REVIEW_URL, not KAG_REVIEWS_URL: the latter re-encodes in
    // the variable name the exact conflation this exists to undo, and
    // EVIDENCE_REVIEW_URL is already the fleet's name for this value — it is
    // literally what the kag gateway calls it (kag/src/routers/reviews.py:94).
    //
    // UNSET IS THE PRODUCTION SHAPE and is byte-identical to before: the reviews
    // proxy falls back to `kag.baseUrl` and emits the same gateway URL it always
    // did. Deliberately NOT in the required-URL gate below for that reason — an
    // operator who sets nothing gets exactly today's behaviour, so this can never
    // block boot.
    //
    // It is NOT a bare base swap, because the two hops disagree on the prefix:
    // fr emits `{kag}/reviews/...`, the gateway rewrites that to
    // `{ers}/api/reviews/...` (reviews.py:115), and Evidence Review mounts at
    // `/api/reviews`. `resolveReviewsTarget` in routes/assets/kag-reviews.ts
    // owns both forms so the difference cannot be got wrong by an operator: set
    // this to the service ROOT (e.g. `http://127.0.0.1:8810`) and the `/api`
    // prefix is added here, not by whoever writes the env var.
    evidenceReview: {
      baseUrl: process.env.EVIDENCE_REVIEW_URL || '',
    },
    // kag_orchestrator — the ingestion pipeline coordinator (distinct from the
    // KAG unified gateway above). Only its public GET /health/lag backlog gauge
    // is consumed here (control-tower fleet backlog age). Best-effort +
    // baseUrl-only, deliberately NOT in the required-URL gate below: when unset
    // the fleet kag-lag block degrades to available:false rather than blocking boot.
    kagOrchestrator: {
      baseUrl: process.env.KAG_ORCHESTRATOR_URL || '',
    },
    // secrets-service — tenant-isolated encrypted storage (secrets, BYOC client
    // configs, URL credentials). Asset adapter at src/integrations/secrets.ts
    // exposes list/get/create for the /secrets collection (no delete surface).
    secrets: {
      baseUrl: process.env.SECRETS_API_URL || '',
    },
    // artifact_service — tenant-isolated produced-document storage. Adapter at
    // src/integrations/artifacts.ts exposes list/get/manifest/download/preview;
    // download flow uses FR-issued one-shot HMAC tokens (see
    // src/services/download-tokens.ts) so license tokens never leave fr-backend.
    artifacts: {
      baseUrl: process.env.ARTIFACTS_API_URL || '',
      downloadSigningKey: process.env.ARTIFACTS_DOWNLOAD_SIGNING_KEY || '',
    },
    // Public GitHub App (`nonagenticai`) — tenant-bound customer installs.
    // See routes/github-app.ts + ~/.claude/plans/public-github-app-usable.md.
    // ALL OPTIONAL AT BOOT and deliberately absent from validateProductionConfig:
    // the feature is INERT until configured — install-url and callback answer
    // 503 `github_app_not_configured` while slug/client id/secret/state key are
    // unset, and the internal binding lookup answers 401 without
    // FR_GITHUB_BINDING_TOKEN. Read through services/github-app-config.ts,
    // which also consults process.env live (test preloads set env after this
    // snapshot is taken).
    githubApp: {
      slug: process.env.GITHUB_PUBLIC_APP_SLUG || '',
      clientId: process.env.GITHUB_PUBLIC_APP_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_PUBLIC_APP_CLIENT_SECRET || '',
      stateSigningKey: process.env.GITHUB_APP_STATE_SIGNING_KEY || '',
      bindingToken: process.env.FR_GITHUB_BINDING_TOKEN || '',
    },
    // billing-service — the financial domain carved out of metering-service
    // (metering→billing split). Owns the customer-facing billing reads/writes:
    // /api/usage, /api/costs, /api/budget, /api/admin/usage (consumed by
    // integrations/metering/usage.ts + services/metering-admin.ts). Billing reads
    // ONLY BILLING_* — there is no METERING_* fallback (the improvement-loop-service
    // METERING_BASE_URL pointed at was removed, gitops #4968), and BILLING_BASE_URL
    // is REQUIRED in production (validateProductionConfig below).
    billing: {
      baseUrl:
        process.env.BILLING_BASE_URL ||
        process.env.BILLING_SERVICE_URL ||
        '',
      // HMAC-SHA256 key that billing_service's budget watcher signs its
      // threshold-crossing webhooks with (X-Metering-Signature header). MUST
      // equal billing's PLATFORM_BUDGET_WEBHOOK_SECRET. REQUIRED in production
      // — validateProductionConfig() below refuses to boot without it, and the
      // /api/webhooks/billing/budget-threshold receiver 401s rather than accept
      // unsigned traffic. Empty only skips verification OUTSIDE production
      // (dev loop), mirroring the n8n webhook-secret contract.
      budgetWebhookSecret: process.env.PLATFORM_BUDGET_WEBHOOK_SECRET || '',
      // The stream Redis billing_service's span consumer reads `billing:events`
      // on (services/metering-emit.ts). fr's own `config.redis.url` is the
      // cache Redis in the fr namespace — XADDing there is a no-op as far as
      // billing rollups go. Keep this disjoint from cache redis.
      redisUrl: process.env.METERING_REDIS_URL || '',
    },

    // provisioning-service — the single tenant/license/quota lifecycle engine.
    // The super-admin console routes its license grant/revoke through here (via
    // services/provisioning.ts) so a mint/revoke also registers/deregisters the
    // billing request-quota that license-authz enforces at 402 — a quota fr's
    // direct-to-licenses path never touched. Portal-realm auth: the fr-backend
    // portal SA must hold the `provision-caller` realm role.
    provisioning: {
      baseUrl:
        process.env.PROVISIONING_BASE_URL ||
        'http://provisioning.example.com:8546',
    },

    // inference-router — the platform LLM router. fr reads only its internal
    // served-model ledger (below). EMPTY baseUrl disables the client, so this is
    // safe to deploy before INFERENCE_ROUTER_URL is set and is intentionally
    // NOT in the required-URL validation list.
    inferenceRouter: {
      baseUrl: process.env.INFERENCE_ROUTER_URL || '',
      // X-Internal-Secret for inference-router's /api/internal/* ledger reads
      // (served-model timeline, judge-oracle tournament review J1). Empty =
      // those reads refuse before any call (unavailable), never an empty timeline.
      internalSecret: process.env.INFERENCE_ROUTER_INTERNAL_SECRET || '',
    },

    // licenses-service — license token introspection + admin API.
    licenses: {
      baseUrl:
        process.env.LICENSES_SERVICE_URL ||
        process.env.LICENSES_URL ||
        '',
    },

    // Common Practice (CP) — Phase 5.1 fr→CP promotion feedback. When an fr
    // project_request that CP forwarded (external_origin.source ==
    // "commonpractice") is approved & promoted, fr POSTs the new fr_project_id
    // back to CP's POST /api/delivery/fr-feedback (authed by the fr-backend
    // portal SA carrying the delivery-feedback-writer realm role). This is a
    // BEST-EFFORT, never-blocking callback — empty baseUrl disables it (so it
    // is intentionally NOT in the required-URL validation list; fr must boot
    // even when the loop is off).
    commonpractice: {
      baseUrl: (process.env.COMMONPRACTICE_API_URL || '').replace(/\/+$/, ''),
    },

    // Prometheus query API for analytics rollups + observability surfaces.
    prometheus: {
      baseUrl: process.env.PROMETHEUS_URL || '',
    },

    // Pushgateway for cron freshness metrics (scheduled-trigger-health +
    // similar cron/worker producers).
    pushgateway: {
      baseUrl: process.env.PUSHGATEWAY_URL || '',
    },

    // Grafana Explore deep-link base used to build Tempo trace URLs in
    // n8n observability rows. This is a CLIENT-FACING URL (rendered into
    // hyperlinks the user clicks), so it MUST be the public Grafana host.
    grafana: {
      baseUrl: process.env.GRAFANA_URL || '',
    },
  },

  // Security
  security: {
    encryptionKey: process.env.SECRET_ENCRYPTION_KEY || 'your-32-byte-encryption-key-here',
    jwtSecret: process.env.JWT_SECRET_KEY || 'your-jwt-secret',
  },

  // CORS — see `parseCorsOrigins`. Production never allows a loopback origin.
  cors: {
    origins: parseCorsOrigins(process.env.CORS_ORIGINS, process.env.NODE_ENV || 'development'),
  },

  // File Upload
  upload: {
    maxSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || '50'),
    allowedTypes: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
  },

  // Budget top-up (self-serve `POST /api/me/budget/topup` and the super-admin
  // `POST /api/admin/licenses/budget/topup/:tenantId`). DEFAULT OFF — George's
  // ruling 2026-10-02: no free top-up. Every package is priced 0 and
  // FreeSettlement always reports "paid", so with this on any tenant-admin could
  // add 1M-100M tokens/month for nothing. Re-enable ONLY once a real payment
  // gateway is wired into the settlement seam (services/billing/topup.ts).
  // Accepts exactly "true" or "1".
  budgetTopup: {
    enabled: ['true', '1'].includes(process.env.BUDGET_TOPUP_ENABLED ?? ''),
  },

  // Tenant inference provisioning (PLAN tenant-inference-provisioning §2.6).
  // Both DEFAULT OFF; accept exactly "true" or "1".
  //   * enabled       — FR_INFERENCE_PROVISIONING: the owner's provision form
  //     gains an "Inference" section, a provision carrying `inference` sends
  //     byo_mode + budget_currency per seat, skips the manual token budget
  //     and calls provisioning `inference/apply` once. Off = the provision flow
  //     is byte-identical to before (a body carrying `inference` is a 422) and
  //     the /api/admin/.../inference* routes answer 404.
  //   * setup2Enabled — FR_SETUP2_ENABLED: setup 2 (owner commercial keys) may
  //     be chosen. Arm ONLY after the runaway drill (PLAN §1.2 gate 1c);
  //     provisioning refuses it 409 `setup2_disabled` until IR is armed anyway.
  // Setup 3 (BYO) has no flag here: it is refused until IR gate 1b ships BYO
  // key custody (`byo:<cred>` identities + the credentials API).
  inferenceProvisioning: {
    enabled: ['true', '1'].includes(process.env.FR_INFERENCE_PROVISIONING ?? ''),
    setup2Enabled: ['true', '1'].includes(process.env.FR_SETUP2_ENABLED ?? ''),
  },

  // fr package license gate (per-tenant entitlement enforced at fr-backend).
  //
  // When enabled, every authenticated request to a gated route requires the
  // caller's tenant to hold an active `fr` license (looked up via the licenses
  // service `GET /licenses/active?tenant_id=&app_key=fr`). See
  // `lib/require-fr-license.ts`.
  //
  // DEFAULT OFF — flipping this on before every active tenant has been
  // provisioned an `fr` license would lock all users out. Safe rollout order:
  //   1. seed the `fr` app+plan (licenses `seed-apps` Job),
  //   2. provision `fr` licenses for existing tenants
  //      (licenses `scripts/provision_fr_tenant.py`),
  //   3. set FR_LICENSE_GATE_ENABLED=true on fr-backend.
  frLicense: {
    gateEnabled:
      (process.env.FR_LICENSE_GATE_ENABLED || 'false').toLowerCase() === 'true',
    // Redis cache TTLs (seconds) for the per-tenant check.
    //
    // The POSITIVE TTL is the revocation lag: until it expires, a tenant whose
    // fr license was revoked keeps working. It was 3600 and prod overrides
    // NOTHING here (the fr Deployment sets only FR_LICENSE_GATE_ENABLED), so
    // the default IS what runs live — an hour of access after revocation.
    //
    // 60 is anchored on license-authz, which answers the IDENTICAL question
    // (`GET /licenses/active?tenant_id=&app_key=`) at the gateway with
    // ACTIVE_LICENSE_CACHE_TTL=30 (`license-authz/src/jwt_mode.py`, and "30" in
    // its Deployment). 3600 made fr 120x staler than the gateway for the same
    // fact; 60 puts the two on the same order of magnitude.
    //
    // Shortening the TTL is only safe because the lookup is single-flighted
    // (`lib/single-flight.ts`): concurrent misses for one tenant collapse to
    // ONE upstream call, so steady-state load is <= 1 call per tenant per TTL
    // regardless of request concurrency (~52 tenants / 60s => well under 1 rps).
    //
    cacheTtlSeconds: parseInt(process.env.FR_LICENSE_CACHE_TTL || '60'),
    // Negative TTL: how long a DENIAL sticks, i.e. how long a freshly-provisioned
    // tenant waits for access. Left at 120.
    //
    // ⚠️ This is now LONGER than the positive TTL (60). That inverts the old
    // "negatives shorter than positives" rule, and deliberately so: the two TTLs
    // guard opposite failure modes and only the positive one is a SECURITY lag
    // (a revoked tenant still working). A stale denial is a provisioning-latency
    // annoyance, self-limited to 2 minutes, and keeping it long is what stops an
    // unlicensed tenant's traffic from becoming an unbounded stream of live
    // licenses-service misses. Do not "restore symmetry" by lowering it without
    // that second consideration.
    negativeCacheTtlSeconds: parseInt(
      process.env.FR_LICENSE_NEGATIVE_CACHE_TTL || '120',
    ),
  },

  // ⛔ There is deliberately NO `PACKAGE_APP_KEY` / `packageAppKey` here. Which
  // product this deployment serves is DERIVED from the gate flags by
  // `lib/package-license-gate.ts servingAppKey()`. A bare env override won the
  // derivation unconditionally, so `PACKAGE_APP_KEY=kag` on the fr Deployment
  // (which sets FR_LICENSE_GATE_ENABLED=true) made every request resolve to the
  // kag branch, whose flag is off there — skipping the licence check for every
  // tenant on every route, silently, fleet-wide. It was set nowhere in gitops.
  // Do not reintroduce it without a flag cross-check and a loud boot log.

  // KAG package license gate. Same backend image as fr, but the kag-backend
  // DEPLOYMENT (ns kag-frontend, serving kag.nonagentic.ai) sets
  // KAG_LICENSE_GATE_ENABLED=true.
  //
  // ⚠️ The gate is selected from the DEPLOYMENT, not from the request. The old
  // comment here claimed the edge-injected `X-App-Key` header selected it
  // per-request — that assumption is exactly what broke: only the PUBLIC
  // VirtualServices overwrite the header, so on `fr-backend.example.com` a client
  // could send `X-App-Key: kag`, land on the kag branch whose flag is OFF on the
  // fr deployment, and skip the licence check entirely (verified live). A
  // client header may now only select a product whose gate is ENABLED here.
  // See `lib/require-kag-license.ts` + the central enforcement in `server.ts`.
  kagLicense: {
    gateEnabled:
      (process.env.KAG_LICENSE_GATE_ENABLED || 'false').toLowerCase() === 'true',
    // Same revocation-lag reasoning + license-authz anchor as frLicense above.
    // NB fr and kag run SEPARATE Redis instances (distinct REDIS_URL / SOPS
    // blob), so the two caches are independent — one invalidation can never
    // clear both.
    cacheTtlSeconds: parseInt(process.env.KAG_LICENSE_CACHE_TTL || '60'),
    // Negative TTL asymmetry: identical reasoning to frLicense above.
    negativeCacheTtlSeconds: parseInt(
      process.env.KAG_LICENSE_NEGATIVE_CACHE_TTL || '120',
    ),
  },

  // Background document reconcile — closes the poll-driven-only settle gap so a
  // doc whose uploader navigated away still settles out of `processing` (and
  // catches the ~21% of jobs whose orchestrator terminal-callback is lost).
  // Default ON; flip off for rollback.
  docReconcile: {
    enabled: (process.env.DOC_RECONCILE_ENABLED || 'true').toLowerCase() === 'true',
    intervalMs: parseInt(process.env.DOC_RECONCILE_INTERVAL_MS || '45000'),
    batchSize: parseInt(process.env.DOC_RECONCILE_BATCH_SIZE || '25'),
    // Skip rows touched more recently than this so we don't race the live poll.
    minAgeMs: parseInt(process.env.DOC_RECONCILE_MIN_AGE_MS || '10000'),
  },
} as const;

export type Config = typeof config;

/**
 * Startup-time validation of production-only invariants.
 *
 * Enforced when `NODE_ENV=production`:
 *
 * 1. `N8N_WEBHOOK_SECRET` MUST be set — it gates the inbound n8n → fr
 *    webhooks and is sent on every outbound fr → n8n webhook trigger.
 *
 * 2. ALL service URLs MUST be set (non-empty). Per
 *    `deployment/docs/config-externalization-policy.md` and the
 *    user's 2026-05-09 directive, we no longer carry hardcoded
 *    hardcoded cluster-DNS fallbacks in source. Service
 *    addresses come from the gitops fr ConfigMap; missing ones are an
 *    operator error and must crash the process before traffic lands.
 *
 * Called once from `src/server.ts` before `Bun.serve`. Throwing here
 * crashes the process before it accepts traffic — the desired
 * fail-fast behavior. Tests can call this directly to assert the
 * production-mode invariant.
 *
 * The `cfg` parameter is typed loosely (object lookups by string key)
 * so tests can construct a minimal partial config without matching the
 * full `Config` interface; missing keys are treated as empty strings,
 * which is what the validator wants to flag anyway.
 */
type AnyServices = Record<string, unknown>;
export function validateProductionConfig(
  cfg: { env: string; services: AnyServices } = config,
): void {
  // A prod-shaped deploy (ENVIRONMENT=production) that forgot NODE_ENV=production
  // leaves this guard silently inert — ~25 required-var checks become no-ops.
  // That coupling caused the analytics outage; make its recurrence loud, not silent.
  if (process.env.ENVIRONMENT === 'production' && cfg.env !== 'production') {
    console.warn(
      '[config] PROD-BOOT GUARD INERT: ENVIRONMENT=production but NODE_ENV is ' +
        `'${cfg.env}' — validateProductionConfig is a NO-OP and ~25 required-var ` +
        'checks are being SKIPPED. Set NODE_ENV=production on this deployment.',
    );
  }
  // ── AUTH_BYPASS must never reach production ────────────────────────────
  //
  // `AUTH_BYPASS=true` does far more than skip Keycloak. Measured on
  // origin/main, it also disables:
  //   * the fr licence gate            (lib/require-fr-license.ts:148)
  //   * the kag licence gate           (lib/require-kag-license.ts)
  //   * the board+card TENANT gates    (lib/board-tenant-access.ts:105)
  //   * the n8n API-key requirement    (integrations/n8n.ts:82)
  // and hands every request a synthetic admin. It is a complete authentication
  // AND tenant-isolation bypass, and until now NOTHING stopped it being set on a
  // production deployment — there was no guard anywhere in the codebase.
  //
  // This check deliberately fires on EITHER production signal, and BEFORE the
  // `cfg.env` early-return below. The comment above documents that this guard
  // goes inert when ENVIRONMENT=production but NODE_ENV does not say so — that
  // exact coupling already caused one outage. A deploy shaped like production
  // but missing NODE_ENV is precisely where a stray AUTH_BYPASS would survive,
  // so this one refuses on the union rather than the intersection.
  if (
    process.env.AUTH_BYPASS === 'true' &&
    (cfg.env === 'production' || process.env.ENVIRONMENT === 'production')
  ) {
    throw new Error(
      'AUTH_BYPASS=true on a production deployment. This disables authentication, ' +
        'the fr and kag licence gates, and board tenant isolation, and grants every ' +
        'caller a synthetic admin. Refusing to start. Unset AUTH_BYPASS.',
    );
  }

  if (cfg.env !== 'production') return;

  const missing: string[] = [];
  const svcs = cfg.services;

  /** Read a `services.<group>.<key>` string; '' when missing. */
  const get = (group: string, key: string): string => {
    const g = svcs[group];
    if (!g || typeof g !== 'object') return '';
    const v = (g as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : '';
  };

  /** Read a top-level scalar string under `services.<key>`. */
  const getScalar = (key: string): string => {
    const v = svcs[key];
    return typeof v === 'string' ? v : '';
  };

  // -- Secrets / shared keys --------------------------------------------
  if (!get('n8n', 'webhookSecret')) {
    missing.push(
      'N8N_WEBHOOK_SECRET (n8n webhook shared secret)',
    );
  }

  // PLATFORM_BUDGET_WEBHOOK_SECRET is the HMAC key billing_service's budget
  // watcher signs threshold-crossing webhooks with. It was absent from this
  // list while the receiver treated an empty value as "skip verification", so
  // blanking or rotating it silently disabled auth on
  // /api/webhooks/billing/budget-threshold instead of failing. The receiver now
  // fails closed in production; this check makes it fail at BOOT instead of on
  // the first (rejected) delivery.
  if (!get('billing', 'budgetWebhookSecret')) {
    missing.push(
      'PLATFORM_BUDGET_WEBHOOK_SECRET (HMAC key for the billing budget-threshold webhook)',
    );
  }

  // APPROVAL_CALLBACK_SECRET gates the fr → n8n approval-decision
  // callback. Empty in prod means fr sends a literal "Bearer "-style
  // missing-header to the receiver, which the n8n workflow rejects as
  // 401 — improvement decisions silently dead-letter. Fail loud.
  if (!get('n8n', 'approvalCallbackSecret')) {
    missing.push(
      'APPROVAL_CALLBACK_SECRET (fr → n8n approval-decision callback shared secret)',
    );
  }

  // FR_AGENT_JWT_SECRET signs the short-lived tokens carried on AG-UI
  // streaming sessions (see routes/agui.ts). Without it the lazy fallback
  // chain in getJwtSecret() lands on JWT_SECRET_KEY or, worst case, the
  // 'dev-only-fr-agent-secret-change-me' placeholder — silent prod compromise.
  // Read the env directly: cfg.security.jwtSecret has a 'your-jwt-secret'
  // dev placeholder that would mask emptiness through cfg lookups.
  const frAgentJwt = (process.env.FR_AGENT_JWT_SECRET ?? '').trim();
  const jwtSecretKey = (process.env.JWT_SECRET_KEY ?? '').trim();
  if (!frAgentJwt && !jwtSecretKey) {
    missing.push(
      'FR_AGENT_JWT_SECRET or JWT_SECRET_KEY (signs AG-UI agent session tokens)',
    );
  }

  // ARTIFACTS_DOWNLOAD_SIGNING_KEY HMACs the one-shot download tokens
  // issued for /api/artifacts/* (see services/download-tokens.ts). Empty
  // means HMAC keys to '' — any client can forge a download URL.
  if (!get('artifacts', 'downloadSigningKey')) {
    missing.push(
      'ARTIFACTS_DOWNLOAD_SIGNING_KEY (HMAC for artifact one-shot download tokens)',
    );
  }

  // -- Service URLs ------------------------------------------------------
  // Each row: env-var name(s) the operator should set, plus the
  // `services.<group>.<key>` we resolved from. When two env vars share a
  // slot (e.g. KAG_API_URL or KAG_INGESTION_URL), we list them together
  // and require AT LEAST ONE to be set.
  const urlChecks: Array<{ envVars: string[]; value: string }> = [
    { envVars: ['N8N_WEBHOOK_URL'], value: get('n8n', 'webhookUrl') },
    { envVars: ['N8N_API_URL'], value: get('n8n', 'apiUrl') },
    { envVars: ['PLANKA_BASE_URL'], value: get('planka', 'baseUrl') },
    { envVars: ['WORKERS_API_URL'], value: get('workers', 'baseUrl') },
    {
      envVars: ['REQUIREMENTS_API_URL'],
      value: get('requirements', 'baseUrl'),
    },
    {
      envVars: ['KANBAN_API_URL', 'PLANKA_BASE_URL'],
      value: get('kanban', 'baseUrl'),
    },
    { envVars: ['CODING_GATEWAY_URL'], value: getScalar('codingGateway') },
    { envVars: ['SECRETS_API_URL'], value: get('secrets', 'baseUrl') },
    { envVars: ['ARTIFACTS_API_URL'], value: get('artifacts', 'baseUrl') },
    // METERING_BASE_URL and KAG_API_URL/KAG_INGESTION_URL are NOT required:
    // improvement-loop-service and the KAG family were removed from the
    // cluster (gitops #4968/#4991). Their clients degrade to a 503
    // SERVICE_NOT_CONFIGURED when unset. Billing reads use BILLING_*.
    {
      envVars: ['BILLING_BASE_URL', 'BILLING_SERVICE_URL'],
      value: get('billing', 'baseUrl'),
    },
    {
      envVars: ['LICENSES_SERVICE_URL', 'LICENSES_URL'],
      value: get('licenses', 'baseUrl'),
    },
    { envVars: ['PROMETHEUS_URL'], value: get('prometheus', 'baseUrl') },
    { envVars: ['PUSHGATEWAY_URL'], value: get('pushgateway', 'baseUrl') },
    { envVars: ['GRAFANA_URL'], value: get('grafana', 'baseUrl') },
    { envVars: ['TEAMS_CALLBACK_URL'], value: get('teams', 'callbackUrl') },
  ];

  for (const { envVars, value } of urlChecks) {
    if (!value) {
      missing.push(
        envVars.length === 1
          ? envVars[0]!
          : `one of [${envVars.join(', ')}]`,
      );
    }
  }

  // KEYCLOAK_URL is NOT under `services.*` — it lives on `cfg.keycloak`.
  // Resolve it via the same loose lookup path so partial test configs
  // that only populate `services` don't trip on a missing keycloak.
  const kc = (cfg as { keycloak?: { url?: unknown } }).keycloak;
  const kcUrl = kc && typeof kc.url === 'string' ? kc.url : '';
  if (!kcUrl) missing.push('KEYCLOAK_URL');
  // Realm-per-app F1: a door pin outside the trusted list could never verify (that door would 401
  // forever), and a half-set user-realm admin client would silently fall back — refuse both at boot.
  if (kcUrl) missing.push(...keycloakRealmConfigProblems({ intake: signupIntakeIssuers(), decider: signupDeciderIssuers() }));

  if (missing.length > 0) {
    throw new Error(
      'Refusing to boot in production with missing required env vars:\n' +
        missing.map((m) => `  - ${m}`).join('\n') +
        '\n\nSet these in the gitops fr ConfigMap (or the secret-bound ' +
        'env block) and redeploy. See ' +
        'deployment/docs/config-externalization-policy.md.',
    );
  }
}

/**
 * Boot-time validation of N8N_CALLBACK_ORIGINS (D17), in EVERY environment.
 *
 *   * empty           ⇒ logs ONE line (every callback_url is refused 422), returns.
 *   * a bad entry     ⇒ throws (refuse to boot): not http(s), userinfo, a path,
 *                       query or fragment. An origin is scheme + host + port only.
 *
 * Called once from `src/server.ts` next to {@link validateConveyorStartWebhookConfig}.
 */
export function validateN8nCallbackOriginsConfig(): void {
  const cfg: { services: AnyServices } = config;
  const n8n = cfg.services.n8n as Record<string, unknown> | undefined;
  const raw = typeof n8n?.callbackOrigins === 'string' ? n8n.callbackOrigins : '';
  const { origins, errors } = parseCallbackOrigins(raw);
  if (errors.length > 0) {
    throw new Error(
      'Refusing to boot: N8N_CALLBACK_ORIGINS has invalid entries — ' +
        errors.join('; ') +
        '. Each entry is an http(s) origin (scheme://host[:port]), comma-separated.',
    );
  }
  if (origins.length === 0) {
    console.log('[config] N8N_CALLBACK_ORIGINS is empty — every approval callback_url is refused (422 callback_url_not_allowed).');
    return;
  }
  console.log(`[config] N8N_CALLBACK_ORIGINS allows approval callback_url origins: ${origins.join(', ')}`);
}

/**
 * CONVEYOR_START_WEBHOOK_TIMEOUT_MS → ms. Unset/blank ⇒ the default; an integer in
 * [1000, 120000] ⇒ that; anything else ⇒ NaN, which {@link validateConveyorStartWebhookConfig}
 * refuses at boot (a typo must not silently become a 0 s or a 10 min timeout).
 */
export function parseConveyorStartWebhookTimeoutMs(raw: string | undefined): number {
  const v = (raw ?? '').trim();
  if (!v) return CONVEYOR_START_WEBHOOK_TIMEOUT_DEFAULT_MS;
  if (!/^\d+$/.test(v)) return Number.NaN;
  const n = Number(v);
  return n >= CONVEYOR_START_WEBHOOK_TIMEOUT_MIN_MS && n <= CONVEYOR_START_WEBHOOK_TIMEOUT_MAX_MS ? n : Number.NaN;
}

/**
 * Boot-time validation of the conveyor start webhook pair
 * (services/conveyor-start-webhook.ts), in EVERY environment — a set URL with no
 * secret would send unsigned (unverifiable) project-created events, which is a
 * misconfiguration wherever it happens, not only in production.
 *
 *   * URL unset            ⇒ inert: logs ONE line, returns.
 *   * URL set, not http(s) ⇒ throws (refuse to boot).
 *   * URL set, secret unset⇒ throws (refuse to boot).
 *   * CONVEYOR_START_WEBHOOK_TIMEOUT_MS malformed ⇒ throws (refuse to boot), URL set or not.
 *
 * Called once from `src/server.ts` next to {@link validateProductionConfig}.
 */
export function validateConveyorStartWebhookConfig(): void {
  const cfg: { services: AnyServices } = config;
  const n8n = cfg.services.n8n as Record<string, unknown> | undefined;
  const url = typeof n8n?.conveyorStartWebhookUrl === 'string' ? n8n.conveyorStartWebhookUrl.trim() : '';
  const secret = typeof n8n?.conveyorStartWebhookSecret === 'string' ? n8n.conveyorStartWebhookSecret : '';
  const timeoutMs = n8n?.conveyorStartWebhookTimeoutMs;
  if (timeoutMs !== undefined && !(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs))) {
    throw new Error(
      'Refusing to boot: CONVEYOR_START_WEBHOOK_TIMEOUT_MS is set but is not an integer number of ' +
        `milliseconds in [${CONVEYOR_START_WEBHOOK_TIMEOUT_MIN_MS}, ${CONVEYOR_START_WEBHOOK_TIMEOUT_MAX_MS}]. ` +
        `Unset it for the default (${CONVEYOR_START_WEBHOOK_TIMEOUT_DEFAULT_MS}).`,
    );
  }
  if (!url) {
    console.log('[config] CONVEYOR_START_WEBHOOK_URL is unset — the conveyor start webhook is INERT (no project.created POST).');
    return;
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(
      'Refusing to boot: CONVEYOR_START_WEBHOOK_URL is set but is not an absolute http(s) URL. ' +
        'Set it to n8n\'s full start-webhook URL, or unset it to disable the conveyor start webhook.',
    );
  }
  if (!secret) {
    throw new Error(
      'Refusing to boot: CONVEYOR_START_WEBHOOK_URL is set but CONVEYOR_START_WEBHOOK_SECRET is not. ' +
        'Every project.created POST is HMAC-signed (X-FR-Signature) with that secret; set it in the ' +
        'secret-bound env block (paired with the n8n receiver), or unset the URL.',
    );
  }
}

/**
 * ⭐ IS THE v4 CONVEYOR WIRED ON THIS INSTANCE? (George 2026-10-13)
 *
 * kag.nonagentic.ai runs this same image WITHOUT the v4 wiring. There a created
 * project would get an fr row, an RM pm_project and a Planka board and then sit
 * forever, because nothing tells n8n it exists. So project creation (direct
 * POST /api/projects, bulk, createSingleProject, and the project-request flow)
 * refuses 503 `conveyor_not_configured` BEFORE any side effect when this is
 * false, and the SPA hides "New project" (GET /api/auth/me `conveyor_configured`).
 *
 * True only when ALL THREE are present (trimmed, non-blank):
 *   * REQUIREMENTS_SERVICE_TOKEN    — fr's RM licence (integrations/_lib/service-credential.ts)
 *   * CONVEYOR_START_WEBHOOK_URL    — n8n's start webhook
 *   * CONVEYOR_START_WEBHOOK_SECRET — its HMAC secret
 *
 * ⛔ This is NOT a boot check and must not become one: kag boots without any of
 * them. `validateConveyorStartWebhookConfig` still refuses to boot only on the
 * malformed pair (URL set, secret missing / URL not http(s)); a fully-unset
 * instance boots and simply refuses creation.
 *
 * Read from `env` at CALL time (not the module-load `config` snapshot) so a test
 * can drive both postures in one process.
 */
export function conveyorConfigured(): boolean {
  const env = process.env;
  const present = (name: string): boolean => (env[name] ?? '').trim().length > 0;
  return (
    present('REQUIREMENTS_SERVICE_TOKEN') &&
    present('CONVEYOR_START_WEBHOOK_URL') &&
    present('CONVEYOR_START_WEBHOOK_SECRET')
  );
}

/** The machine code (and `error` string) of the refusal. */
export const CONVEYOR_NOT_CONFIGURED_CODE = 'conveyor_not_configured' as const;
