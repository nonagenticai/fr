// src/lib/api/llm-provider.ts
//
// Typed client for the fr backend's per-tenant BYO LLM provider settings,
// which proxy worker_management's /tenant-config/llm endpoints.
//
// Wire contracts (mirror backend/src/routes/settings/llm-provider.ts):
//   GET    /api/settings/llm-provider[?tier=]   → { data: LlmConfigView }
//   GET    /api/settings/llm-provider/all        → { data: { configs: LlmConfigRow[] } }
//   GET    /api/settings/llm-provider/catalog    → { data: LlmCatalog }
//   PUT    /api/settings/llm-provider[?tier=]    → { data: LlmConfigView }
//   DELETE /api/settings/llm-provider[?tier=]    → 204
//   POST   /api/settings/llm-provider/test       → { data: LlmKeyTestResult }
//   GET    /api/settings/llm-provider/audit[?limit=] → { data: { entries: LlmAuditEntry[] } }
//
// The SAME contract is served for a named customer tenant at
// /api/admin/tenants/:tenantId/llm-provider (owner / super-admin only), so the
// calls are built by `llmProviderApi(base)`; the settings page uses
// `settingsLlmProviderApi`, the owner's tenant page `adminTenantLlmProviderApi`.
//
// `tier` selects a per-work-size row (small/medium/high); absent ⇒ the default
// row. Each tier carries its own provider/model/key; resolution falls back
// tier → default → platform.
//
// All calls require a workspace-admin (or super-admin) caller — the backend
// gates and returns 403 otherwise. Every call goes through `authFetch`
// (attaches the Keycloak Bearer + X-Active-Tenant), so these helpers MUST run
// client-side after the auth store has hydrated.

import { apiErrorMessage } from './api-error';
import { authFetch } from './auth-fetch';

/** Current tenant LLM config. The API key is NEVER returned — only `hasKey`. */
export interface LlmConfigView {
  configured: boolean;
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  temperature: number | null;
  maxTokens: number | null;
  params: Record<string, unknown>;
  hasKey: boolean;
  updatedAt: string | null;
}

/**
 * PUT body. apiKey tri-state:
 *   - omit the property → preserve the stored key
 *   - apiKey === ''     → clear it
 *   - apiKey === 'x'    → set/overwrite
 */
export interface LlmConfigUpdate {
  provider: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  params?: Record<string, unknown>;
  apiKey?: string;
}

/** Work-size tiers. Absent ⇒ the tenant's default row. */
export type WorkTier = 'small' | 'medium' | 'high';

export const WORK_TIERS: readonly WorkTier[] = ['small', 'medium', 'high'];

/** Per-class recommended-model hints (small→flash, medium→reasoning, high→frontier). */
export interface LlmModelClasses {
  flash?: string;
  reasoning?: string;
  frontier?: string;
}

export interface LlmCatalogProvider {
  key: string;
  label: string;
  provider: string;
  default_base_url: string | null;
  requires_api_key: boolean;
  requires_base_url: boolean;
  is_external: boolean;
  models: string[];
  model_classes: LlmModelClasses;
  required_params: string[];
}

export interface LlmCatalog {
  providers: LlmCatalogProvider[];
}

/** One row from GET .../all — a masked config view plus its role/tier. */
export interface LlmConfigRow extends LlmConfigView {
  role: string;
  tier: WorkTier | null;
}

function tierQuery(tier?: WorkTier | null): string {
  return tier ? `?tier=${encodeURIComponent(tier)}` : '';
}

/**
 * Pull a human-readable message out of fr-backend's error envelope.
 *
 * Delegates to the shared formatter — the string-`detail` path (which is what
 * worker_management sends) behaves exactly as it did when this function owned
 * the unwrapping; the formatter only ADDS the array-`detail` and billing
 * `error.details` shapes, which used to be JSON.stringify'd verbatim.
 */
async function errorMessage(r: Response, fallback: string): Promise<string> {
  return apiErrorMessage(r, fallback);
}

/**
 * Result of a live key test (worker_management POST /tenant-config/llm/test via
 * fr). `ok:false` is a normal answer — missing row, withheld key, vendor
 * rejection — with `error` saying which. The key itself is never returned.
 */
export interface LlmKeyTestResult {
  ok: boolean;
  provider?: string | null;
  model?: string | null;
  latency_ms?: number | null;
  error?: string | null;
  warning?: string | null;
}

/**
 * One row of the tenant's BYO change history (worker_management
 * `tenant_llm_config_audit`, newest first). Owner ruling 2026-10-02: when the
 * platform operator sets, tests or removes a customer's key, the customer sees
 * it here. `tier` is null for the default row; `keyId` is a short fingerprint
 * or 'none' — never the key.
 */
/**
 * Thrown by `listAudit` when the audit endpoint answers 404. fr relays
 * worker_management's 404 unchanged (UPSTREAM_NOT_FOUND → 404), which is what
 * a not-yet-deployed WM returns. The UI shows a neutral line, not an error.
 */
export class LlmAuditUnavailableError extends Error {
  constructor() {
    super('Recent changes are not available yet.');
    this.name = 'LlmAuditUnavailableError';
  }
}

export interface LlmAuditEntry {
  at: string;
  tier: WorkTier | null;
  action: 'set_key' | 'clear_key' | 'update' | 'remove' | 'test';
  actor: 'platform_operator' | 'workspace_admin' | 'service';
  provider: string | null;
  keyId: string;
}

export const LLM_AUDIT_ACTION_LABELS: Record<LlmAuditEntry['action'], string> = {
  set_key: 'Key set',
  clear_key: 'Key removed',
  update: 'Config updated',
  remove: 'Config removed',
  test: 'Key tested',
};

export const LLM_AUDIT_ACTOR_LABELS: Record<LlmAuditEntry['actor'], string> = {
  platform_operator: 'Platform operator',
  workspace_admin: 'Workspace admin',
  service: 'System',
};

/** Label lookups that never render `undefined` for a value WM adds later. */
export function auditActionLabel(action: string): string {
  return Object.hasOwn(LLM_AUDIT_ACTION_LABELS, action)
    ? LLM_AUDIT_ACTION_LABELS[action as LlmAuditEntry['action']]
    : action;
}
export function auditActorLabel(actor: string): string {
  return Object.hasOwn(LLM_AUDIT_ACTOR_LABELS, actor)
    ? LLM_AUDIT_ACTOR_LABELS[actor as LlmAuditEntry['actor']]
    : actor;
}

/** The calls, bound to one base path. */
export interface LlmProviderApi {
  getConfig(tier?: WorkTier | null): Promise<LlmConfigView>;
  listConfigs(): Promise<LlmConfigRow[]>;
  getCatalog(): Promise<LlmCatalog>;
  putConfig(body: LlmConfigUpdate, tier?: WorkTier | null): Promise<LlmConfigView>;
  deleteConfig(tier?: WorkTier | null): Promise<void>;
  testConfig(tier?: WorkTier | null): Promise<LlmKeyTestResult>;
  listAudit(limit?: number): Promise<LlmAuditEntry[]>;
}

export function llmProviderApi(base: string): LlmProviderApi {
  return {
    async getConfig(tier) {
      const r = await authFetch(`${base}${tierQuery(tier)}`);
      if (!r.ok) throw new Error(await errorMessage(r, `Failed to load config (${r.status})`));
      return ((await r.json()) as { data: LlmConfigView }).data;
    },
    async listConfigs() {
      const r = await authFetch(`${base}/all`);
      if (!r.ok) throw new Error(await errorMessage(r, `Failed to load configs (${r.status})`));
      return ((await r.json()) as { data: { configs: LlmConfigRow[] } }).data.configs;
    },
    async getCatalog() {
      const r = await authFetch(`${base}/catalog`);
      if (!r.ok) throw new Error(await errorMessage(r, `Failed to load catalog (${r.status})`));
      return ((await r.json()) as { data: LlmCatalog }).data;
    },
    async putConfig(body, tier) {
      const r = await authFetch(`${base}${tierQuery(tier)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await errorMessage(r, `Failed to save (${r.status})`));
      return ((await r.json()) as { data: LlmConfigView }).data;
    },
    async deleteConfig(tier) {
      const r = await authFetch(`${base}${tierQuery(tier)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 204) {
        throw new Error(await errorMessage(r, `Failed to remove config (${r.status})`));
      }
    },
    async testConfig(tier) {
      const r = await authFetch(`${base}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tier ? { tier } : {}),
      });
      if (!r.ok) throw new Error(await errorMessage(r, `Key test failed (${r.status})`));
      return ((await r.json()) as { data: LlmKeyTestResult }).data;
    },
    async listAudit(limit) {
      const q = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
      const r = await authFetch(`${base}/audit${q}`);
      // worker_management answers 404 on /tenant-config/llm/audit until WM #320
      // is deployed; fr relays it as a 404 (UPSTREAM_NOT_FOUND). That is "not
      // available yet", not a failure the customer should see in red.
      if (r.status === 404) throw new LlmAuditUnavailableError();
      if (!r.ok) throw new Error(await errorMessage(r, `Failed to load recent changes (${r.status})`));
      return ((await r.json()) as { data: { entries: LlmAuditEntry[] } }).data.entries ?? [];
    },
  };
}

/** The caller's own (or switched) workspace — /settings/llm-provider. */
export const settingsLlmProviderApi: LlmProviderApi = llmProviderApi('/api/settings/llm-provider');

/** A named customer tenant — owner (super-admin) only; the backend 403s anyone else. */
export function adminTenantLlmProviderApi(tenantId: string): LlmProviderApi {
  return llmProviderApi(`/api/admin/tenants/${encodeURIComponent(tenantId)}/llm-provider`);
}

/**
 * What "no key on a tier" MEANS depends on the tenant's BYO mode, which
 * worker_management enforces (`llm_config_resolver`): only `local_allowed`
 * falls back to local-llm; `byo_required` hard-fails a keyless tier and
 * `platform_only` refuses external providers outright. So the explanation is
 * per mode — a single "no key ⇒ local-llm" line was false for byo_required.
 */
export const LLM_MODE_NOTES = {
  local_allowed: 'No key on a tier = local-llm (metered). Remove reverts that tier to local-llm.',
  byo_required:
    'This tenant must use its own provider keys; a tier without a key fails. Switch to ‘local-llm + BYO’ to allow local-llm.',
  platform_only:
    'Locked to local-llm; external providers are refused. Switch to ‘local-llm + BYO’ to allow BYO keys.',
} as const;

export type LlmByoMode = keyof typeof LLM_MODE_NOTES;

/**
 * For the tenant_admin's /settings page, which does NOT know its tenant's BYO
 * mode (only the owner's licences-admin routes expose it), so it states the
 * rule conditionally rather than asserting one mode's behaviour.
 */
export const LLM_MODE_NEUTRAL_NOTE =
  'If your workspace allows local-llm, a tier with no key runs on local-llm (metered) and Remove reverts it to local-llm; otherwise each tier needs your own provider key.';

/** The note for a mode; an unknown/absent mode gets the neutral wording. */
export function llmModeNote(mode: string | null | undefined): string {
  // Object.hasOwn, not `in`: `in` also matches prototype keys ('toString', …).
  return mode && Object.hasOwn(LLM_MODE_NOTES, mode) ? LLM_MODE_NOTES[mode as LlmByoMode] : LLM_MODE_NEUTRAL_NOTE;
}

/** What a tier card says when its config is removed: the confirm prompt and the success line. */
export interface RemoveCopy {
  confirm: string;
  success: string;
}

/**
 * Remove copy per BYO mode. Only `local_allowed` falls back to local-llm;
 * worker_management hard-fails a keyless `byo_required` tier, so saying
 * "back on local-llm" there is false. `platform_only` and an unknown mode
 * (the tenant_admin's /settings page cannot see its mode) get the neutral
 * "platform default" wording.
 */
export function removeCopy(mode: string | null | undefined, tier: WorkTier | null): RemoveCopy {
  switch (mode) {
    case 'local_allowed':
      return tier === null
        ? { confirm: 'Revert to local-llm?', success: 'Removed — this workspace is back on local-llm.' }
        : {
            confirm: 'Revert this tier to the default row?',
            success: 'Removed — this tier now falls back to the default row (local-llm if that is empty).',
          };
    case 'byo_required':
      return tier === null
        ? {
            confirm: 'Remove this key? The tier will have no provider.',
            success: 'Key removed — this tier has no provider now and will fail until a key is set.',
          }
        : {
            confirm: 'Revert this tier to the default row?',
            success: 'Removed — this tier now falls back to the default row, and fails if that has no key.',
          };
    default:
      return tier === null
        ? { confirm: 'Revert to platform default?', success: 'Reverted to the platform default provider.' }
        : {
            confirm: 'Revert this tier to the default row?',
            success: 'Reverted this tier — it now falls back to the default row.',
          };
  }
}
