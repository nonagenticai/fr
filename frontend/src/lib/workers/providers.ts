// Async client for FR's worker asset provider catalog.
// Backed by FR backend routes that proxy worker_management upstream.
import { authFetch } from '$lib/api/auth-fetch';
import { isHandledStateCode, type HandledStateCode } from '$lib/api/handled-state-codes';

export type Provider = {
  name: string;
  label: string;
  description: string;
  requires_api_key: boolean;
  // Present since worker_management#185. A provider requiring a key is
  // `available` only when that key is present server-side; selecting an
  // unavailable one 502s. Optional on purpose: during a rollout the upstream
  // pod may predate the field, and treating "absent" as "unavailable" would
  // black out the whole dropdown. See providerIsAvailable.
  available?: boolean;
};

/**
 * True unless the catalog explicitly says the provider cannot be served.
 *
 * `undefined` means "the upstream did not tell us" and MUST read as available —
 * anything else turns a routine rollout skew into an empty provider list.
 */
export function providerIsAvailable(p: Provider): boolean {
  return p.available !== false;
}

/**
 * The providers a picker offers: the AVAILABLE ones only. An unavailable
 * provider is hidden rather than shown disabled — selecting one can only 502.
 *
 * `keep` is a value the caller already holds (an existing worker's stored
 * provider). It stays in the list even when unavailable, so an edit form shows
 * the truth instead of silently switching the worker to something else.
 */
export function pickableProviders(list: readonly Provider[], keep?: string): Provider[] {
  return list.filter((p) => providerIsAvailable(p) || (!!keep && p.name === keep));
}

/**
 * The provider that serves the in-house `local-llm` model. worker_management
 * lists `/providers/inference_router/models` filtered to `local-llm`
 * (src/api/providers/_router.py), so this is the provider a picker defaults to.
 */
export const PREFERRED_DEFAULT_PROVIDER = 'inference_router';

/**
 * Which provider a picker selects first:
 *   - `inference_router` (the one offering local-llm), when it is available;
 *   - else the first available provider; '' when none can serve a request.
 * The model-level preference (`pickDefaultModel`) then lands on local-llm.
 */
export function defaultProviderName(list: readonly Provider[]): string {
  const available = list.filter(providerIsAvailable);
  return (
    available.find((p) => p.name === PREFERRED_DEFAULT_PROVIDER)?.name ?? available[0]?.name ?? ''
  );
}

export type ProviderModel = { id: string };

/** The in-house model every picker prefers when it is offered. */
export const PREFERRED_DEFAULT_MODEL = 'local-llm';

/**
 * Which model to select once a provider's model list has loaded:
 *   - `current`, when the list still offers it (never override a choice);
 *   - else `local-llm`, when the list offers it;
 *   - else the first model; '' for an empty list.
 */
export function pickDefaultModel(models: readonly ProviderModel[], current: string): string {
  if (current && models.some((m) => m.id === current)) return current;
  if (models.some((m) => m.id === PREFERRED_DEFAULT_MODEL)) return PREFERRED_DEFAULT_MODEL;
  return models[0]?.id ?? '';
}

/**
 * Whether `(provider, model)` may be SENT (fr#1407). True only when the model
 * list on screen was fetched for THIS provider (`modelsFor === provider`) and
 * still offers `model`. It is false while a provider's models are loading,
 * after a state/error (the list is empty), for an empty list, and — the bug —
 * for a model left over from the previously selected provider, which would
 * otherwise reach the backend as e.g. `{provider: 'vlm_local', model: 'local-llm'}`.
 */
export function modelIsSendable(
  provider: string,
  model: string,
  modelsFor: string,
  models: readonly ProviderModel[]
): boolean {
  if (!provider || !model || modelsFor !== provider) return false;
  return models.some((m) => m.id === model);
}

/**
 * The line a model picker shows when a provider's model list failed for a
 * reason that is NOT a provider state (fr#1407). Neutral on purpose: the raw
 * `${status} ${statusText}: detail` text is upstream/operator detail, never
 * customer copy.
 */
export function providerModelsErrorText(label: string): string {
  return `Couldn't load models for ${label || 'this provider'}. Try again.`;
}

/**
 * The line a provider picker shows when the provider CATALOG failed to load
 * (fr#1409). Neutral for the same reason as providerModelsErrorText:
 * `fetchProviders` throws `${status} ${statusText}: detail`, which is upstream
 * detail for the console log, never page copy.
 */
export const PROVIDERS_ERROR_TEXT = "Couldn't load providers. Try again.";

type ListBody<T> = { data?: T[] };
// worker_management error envelope (see error_handlers.create_error_response):
// { "error": { "code": "...", "message": "...", "status": N } }
// FastAPI's own validation errors instead return { "detail": "..." }, and older
// hand-rolled handlers use { "message": "..." }. Read all three.
type ErrorBody = {
  error?: { message?: string; code?: string };
  detail?: string;
  message?: string;
};

function extractErrorDetail(err: ErrorBody): string | undefined {
  return err.error?.message ?? err.detail ?? err.message;
}

async function parseJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

export async function fetchProviders(): Promise<Provider[]> {
  const res = await authFetch('/api/assets/workers/providers');
  if (!res.ok) {
    const err = await parseJson<ErrorBody>(res);
    const detail = extractErrorDetail(err);
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`${res.status} ${res.statusText}${suffix}`);
  }
  const body = await parseJson<ListBody<Provider>>(res);
  return body.data ?? [];
}

/**
 * The two provider STATES fr's backend reports for a model list (fr#1385,
 * `backend/src/routes/assets/workers.ts::providerModelsState`). They are not
 * errors: `PROVIDER_NOT_ENABLED` is the workspace's LLM policy refusing on
 * purpose (e.g. the owner's commercial keys serve platform workspaces only),
 * `PROVIDER_UNAVAILABLE` is a backend that is down or dormant (e.g. the devbox
 * VLM). A picker renders them
 * as a neutral state line, never as a red `403 Forbidden: …` string.
 */
export type ProviderState = HandledStateCode;

export class ProviderStateError extends Error {
  constructor(
    readonly state: ProviderState,
    readonly provider: string
  ) {
    super(
      state === 'PROVIDER_NOT_ENABLED'
        ? `${provider} is not enabled for this workspace.`
        : `${provider} is unavailable right now.`
    );
    this.name = 'ProviderStateError';
  }
}

/**
 * worker_management's per-tenant refusals for a model list (tenant-scoped since
 * 2026-10-01): the workspace has no row for the provider, its key is withheld,
 * unusable, or rejected by the vendor. These are CONFIGURATION states with a
 * fix the user can make, not failures — but they used to fall through to the
 * generic "Couldn't load models for Inference Router. Try again." (UI review
 * 2026-10-07; measured live: GET …/inference_router/models → 403). The
 * sentences are fixed client-side (the fr#1409 rule: upstream text is never
 * page copy) and mirror backend/src/lib/wm-byo-errors.ts::wmByoUserMessage.
 */
const BYO_SENTENCES: Record<string, (provider: string) => string> = {
  BYO_PROVIDER_NOT_CONFIGURED: (p) =>
    `${p} is not configured for this workspace. Add it in Settings → LLM provider.`,
  BYO_KEY_WITHHELD: (p) =>
    `Your workspace's ${p} key could not be used because your sign-in could not be verified for this workspace. Sign out and in again, then retry.`,
  BYO_KEY_UNUSABLE: (p) =>
    `The ${p} key saved for this workspace cannot be used. Re-enter it in Settings → LLM provider and press Test.`,
  BYO_PROVIDER_CALL_FAILED: (p) =>
    `${p} rejected the request made with your workspace's key. Check the key in Settings → LLM provider.`,
  // inference-router's tenant gate (relayed by fr since 2026-10-07).
  //
  // ⛔ The sentence used to say "Sign out and in again; if you switched
  // workspace, switch back and retry." Signing in again CANNOT fix this: the
  // refusal happens because worker_management could not PROVE the workspace on
  // this request (`wm_ir_bundle_token outcome=tenant_not_proven`), and the
  // proof comes from the tenant's own licence or a sign-in that names the
  // tenant — never from a fresh session. It sent a super-admin who had switched
  // into an internal workspace (`system`) hunting a re-login that could only
  // ever reproduce the same 403. Name the two things that actually change the
  // answer instead: a workspace this account belongs to, or someone with the
  // authority to enable the provider there.
  END_TENANT_NOT_PROVEN: (p) =>
    `${p} is not available in this workspace. Switch to a workspace your account belongs to, or ask an administrator to enable it here.`,
};

export class ProviderConfigError extends Error {
  constructor(
    readonly code: string,
    readonly provider: string,
  ) {
    super(BYO_SENTENCES[code]!(provider));
    this.name = 'ProviderConfigError';
  }
}

export function providerConfigCode(code: string | undefined): string | null {
  return code && Object.prototype.hasOwnProperty.call(BYO_SENTENCES, code) ? code : null;
}

function providerStateOf(code: string | undefined): ProviderState | null {
  return isHandledStateCode(code) ? code : null;
}

export async function fetchProviderModels(
  name: string,
  signal?: AbortSignal
): Promise<ProviderModel[]> {
  const url = `/api/assets/workers/providers/${encodeURIComponent(name)}/models`;
  const res = signal ? await authFetch(url, { signal }) : await authFetch(url);
  if (!res.ok) {
    const err = await parseJson<ErrorBody>(res);
    const state = providerStateOf(err.error?.code);
    if (state) throw new ProviderStateError(state, name);
    const config = providerConfigCode(err.error?.code);
    if (config) throw new ProviderConfigError(config, name);
    const detail = extractErrorDetail(err);
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`${res.status} ${res.statusText}${suffix}`);
  }
  const body = await parseJson<ListBody<ProviderModel>>(res);
  return body.data ?? [];
}

export function resolveProvider(
  providers: Provider[],
  name: string
): Provider | undefined {
  return providers.find((p) => p.name === name);
}
