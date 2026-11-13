// src/lib/fr-issuable-apps.ts
//
// Which licences apps fr may provision — an ALLOWLIST of fr's own platform
// context. Each platform's web UI provisions only its own context (George,
// 2026-10-14; restated 2026-10-21). fr's context is the fr bundle:
//
//   - per PERSON, fr provisions exactly `fr` + `fr-frontend` (FR_PERSON_APPS).
//     Kanban and n8n are shared fr platform accounts (one Planka account, one
//     N8N_API_KEY reused by every tenant) — nothing to provision per person.
//   - per TENANT, fr may grant the members of its own licences bundles
//     (FR_BUNDLES → FR_TENANT_APPS).
//
// Why an allowlist: this module used to be a DENYLIST of foreign owners
// (commonpractice, w2v, merqi family, book-fulfillment). A denylist only knows
// the owners someone remembered to write down, so every app a new owner added
// later leaked into fr's pickers. Measured 2026-10-21 in the prod licences
// catalogue: `agent` (issuer agent), `care-bus` (issuer care-bus) and
// `strata-configurator` (issuer strata-configurator) were all offered at
// /admin/users, and `ingestion` / `signal` are not fr per-person products
// either. An unknown future key is now refused by default.
//
// The licences service stays the BACKSTOP: its `app_issuer` table (migration
// 050) answers a mint for an app fr does not issue with 403
// `app_not_issuable_by_caller`. That check fires only when a run reaches the
// app — provisioning is NOT transactional, so a request mixing `fr` and a
// foreign app mints the fr licence and then dies, leaving an orphan behind
// (measured 2026-08-26). Hence the up-front refusal here.
//
// When licences exposes issuers / bundle membership on `/apps`, replace these
// literals with a read of that data.

/** The only licences fr provisions per person. `fr` is the key fr's own gate requires. */
export const FR_PERSON_APPS: readonly string[] = ['fr', 'fr-frontend'];

/** fr's licences bundles (the tenant-level grants fr may make). */
export const FR_BUNDLES: readonly string[] = ['conveyor', 'non-agentic-ai', 'n8n-nodes', 'inference-router'];

/**
 * Members of FR_BUNDLES, measured 2026-10-21 from the prod licences DB:
 *
 *   SELECT b.key AS bundle, a.key AS app
 *     FROM bundle_app ba
 *     JOIN bundle b ON b.id = ba.bundle_id
 *     JOIN app a    ON a.id = ba.app_id
 *    WHERE b.key IN ('conveyor','non-agentic-ai','n8n-nodes','inference-router')
 *    ORDER BY 1, 2;
 *
 * The app_requires dependency workers → inference-router is covered by the
 * inference-router bundle.
 */
const FR_BUNDLE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  conveyor: [
    'coding', 'kag', 'laya', 'procedures', 'requirements', 'secrets', 'skill-builder', 'workers',
  ],
  'non-agentic-ai': [
    'artifacts', 'coding', 'fr', 'fr-frontend', 'improvement-loop', 'kag', 'kanban', 'keycloak',
    'licenses', 'mcp', 'n8n', 'procedures', 'requirements', 'secrets', 'signal', 'skill-builder',
    'tools', 'workers',
  ],
  'n8n-nodes': [
    'kaizen_core_actions', 'kaizen_discover_actions', 'meta_prompt_core_actions',
    'meta_prompt_discover_actions', 'metering', 'observability',
  ],
  'inference-router': ['inference-router'],
};

/** Every app fr may grant at tenant level: the union of FR_BUNDLES' members. */
export const FR_TENANT_APPS: readonly string[] = [
  ...new Set(FR_BUNDLES.flatMap((b) => FR_BUNDLE_MEMBERS[b] ?? [])),
].sort();

const TENANT_SET: ReadonlySet<string> = new Set(FR_TENANT_APPS);
const PERSON_SET: ReadonlySet<string> = new Set(FR_PERSON_APPS);

/** Whether fr may offer and grant `appKey` at tenant level (it is in an fr bundle). */
export function isFrIssuable(appKey: string): boolean {
  return TENANT_SET.has(appKey);
}

/** Whether `appKey` is one of the licences fr provisions per person. */
export function isFrPersonApp(appKey: string): boolean {
  return PERSON_SET.has(appKey);
}

/** Whether `bundleKey` is one of fr's own licences bundles. */
export function isFrBundle(bundleKey: string): boolean {
  return FR_BUNDLES.includes(bundleKey);
}

/** The subset of `appKeys` fr does not provision per person, in request order. */
export function selectAppsNotFrPersonApps(appKeys: readonly string[]): string[] {
  return appKeys.filter((key) => !isFrPersonApp(key));
}

/** Operator-facing explanation for a refusal of `appKeys` (all outside fr's context). */
export function notIssuableDetail(appKeys: readonly string[]): string {
  return (
    `${appKeys.join(', ')} ${appKeys.length === 1 ? 'is' : 'are'} outside fr's platform ` +
    `context (the fr bundle). Provision ${appKeys.length === 1 ? 'it' : 'them'} from the ` +
    `owning app. Nothing was attempted.`
  );
}

/** Operator-facing explanation for a per-person refusal of `appKeys`. */
export function notPersonAppDetail(appKeys: readonly string[]): string {
  return (
    `${appKeys.join(', ')} ${appKeys.length === 1 ? 'is' : 'are'} outside fr's platform ` +
    `context (the fr bundle). fr provisions only ${FR_PERSON_APPS.join(' + ')} per person; ` +
    `kanban and n8n are shared fr platform accounts. Provision other apps from the owning ` +
    `app. Nothing was attempted.`
  );
}
