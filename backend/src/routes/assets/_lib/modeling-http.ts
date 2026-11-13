// The modeling family's HTTP conventions, shared by the modeling, UML, view
// contents and ArchiMate CRUD routes and the RM pass-through table
// (`rm-passthrough.ts`): RM refusals in plain words, the caller's expected head
// (`If-Match` / body `expected_head`), `ETag` relay, body and query helpers.

import {
  IntegrationError,
  integrationErrorResponse,
  isIntegrationError,
} from '../../../integrations/_lib/errors';
import { jsonResponse } from '../../../utils/response';

// ---------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------

/**
 * RM refusal code → the sentence a user reads. Every entry names what happened
 * and what to do next; none uses an internal term. The code itself is relayed
 * unchanged so the UI (and the agent) can branch on it.
 */
const MODELING_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  stale_head:
    'Someone changed this model after you opened it. Reload to see the latest version, then make your change again.',
  invalid_if_match: 'Your copy of this model is out of date. Reload it and try again.',
  if_match_not_applicable: 'This item does not belong to a model, so it cannot be checked for newer changes.',
  model_has_revisions:
    'This model has saved versions, so it cannot be deleted on its own. You can delete it together with all its versions, validation results and imported changes.',
  model_visibility_owner_only: 'Only the person who owns this model can change who can see it.',
  visibility_change_foreign_rows: 'This model cannot be made private because other people have added content to it.',
  default_model_visibility_fixed: "This is the workspace's default model; who can see it cannot be changed.",
  model_integrity: 'This change would leave the model inconsistent, so it was not made. See the problems listed.',
  input_too_large: 'This model is too large to process in one go (more than 5,000 elements and relationships).',
  revision_not_approved: 'This version cannot be published until it has been approved.',
  revision_not_validated:
    'This version cannot be published until a complete validation with no errors has been run on it with the current rules. Run a validation on this version first.',
  revision_already_published: 'This version is already the published one.',
  review_reason_required: 'Please say why you are rejecting this version.',
  change_set_not_proposed: 'These changes were already applied or rejected. Reload to see where they stand.',
  change_set_not_open: 'These changes were already applied or rejected. Reload to see where they stand.',
  change_set_op_invalid:
    'One of these changes no longer fits the model, so none of them were applied. Import the file again to prepare an up-to-date set.',
  exchange_unsupported_language: 'Only ArchiMate models can be exported or imported as exchange files.',
  exchange_too_large: 'The file is too large to import. The limit is 25 MB.',
  exchange_invalid: 'This file is not a valid ArchiMate exchange file, so nothing was imported.',
  unsupported_media_type: 'Only ArchiMate exchange files (.xml) can be imported.',
  organizations_unsupported_language: 'Only ArchiMate models have a folder structure.',
  invalid_organizations: 'The folder structure is not valid. Reload the model and try again.',
  unknown_ruleset: 'That set of rules is not available. Choose another one and try again.',
  unknown_rule: 'One of the chosen rules is not available. Choose others and try again.',
  idempotency_conflict: 'This request was already sent with different content. Reload and try again.',
  idempotency_in_progress: 'This request is still being processed. Wait a moment, then reload.',
  invalid_idempotency_key: 'This request could not be matched to an earlier attempt. Try again.',
  VALIDATION_ERROR: 'Some of the details are not valid. Check the fields and try again.',
};

/**
 * A `model_integrity` refusal about WHICH model a row may join carries one of
 * these in its finding's `evidence.reason` (RM services/modeling_models.py,
 * services/uml_store.py): said in plain words, with the way out.
 */
const MODEL_MEMBERSHIP_MESSAGES: Readonly<Record<string, string>> = {
  model_not_writable: 'You cannot add to that model: it was deleted, or it is private to someone else. Choose another model.',
  model_language_mismatch: 'That model is in another modeling language. Choose a model of the right language.',
  model_visibility_mismatch: 'That model is visible to different people than this item. Choose a model with the same visibility.',
  model_project_mismatch: 'That model belongs to another project. Choose a model of this project.',
};

interface RmErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    head?: unknown;
    findings?: unknown;
    details?: unknown;
  };
}

/** The structured RM refusal inside an IntegrationError, when there is one. */
function rmRefusalOf(err: IntegrationError): { code: string; message: string; head?: number; findings?: unknown[]; details?: string } | null {
  const body = err.upstreamBody as RmErrorEnvelope | undefined;
  const e = body && typeof body === 'object' ? body.error : undefined;
  if (!e || typeof e !== 'object' || typeof e.code !== 'string') return null;
  return {
    code: e.code,
    message: typeof e.message === 'string' ? e.message : e.code,
    ...(typeof e.head === 'number' ? { head: e.head } : {}),
    ...(Array.isArray(e.findings) ? { findings: e.findings } : {}),
    // Which of the caller's own fields were refused (RM 422 VALIDATION_ERROR): theirs to see.
    ...(typeof e.details === 'string' && e.code === 'VALIDATION_ERROR' ? { details: e.details } : {}),
  };
}

/**
 * An IntegrationError as the response a user can act on. A known RM refusal
 * keeps its status and code and gets a plain message (+ `head` / `findings`);
 * anything else is the generic converter's answer, unchanged. The generic
 * converter runs either way, so the failure is logged exactly once.
 */
function modelingRefusal(err: IntegrationError): Response {
  const generic = integrationErrorResponse(err);
  const status = err.upstreamStatus;
  if (status === undefined || status < 400 || status >= 500 || status === 401) return generic;
  const refusal = rmRefusalOf(err);
  if (!refusal) return generic;
  let plain: string | undefined = MODELING_REFUSAL_MESSAGES[refusal.code];
  if (plain === undefined) return generic;
  if (refusal.code === 'model_integrity') {
    const reason = (refusal.findings ?? [])
      .map((f) => ((f as { evidence?: { reason?: unknown } })?.evidence?.reason))
      .find((r): r is string => typeof r === 'string' && r in MODEL_MEMBERSHIP_MESSAGES);
    if (reason) plain = MODEL_MEMBERSHIP_MESSAGES[reason]!;
  }
  return jsonResponse(
    {
      error: {
        code: refusal.code,
        message: plain,
        status,
        service: 'requirements_management',
        ...(refusal.head !== undefined ? { head: refusal.head } : {}),
        ...(refusal.findings !== undefined ? { findings: refusal.findings } : {}),
        ...(refusal.details !== undefined ? { details: refusal.details } : {}),
      },
    },
    status,
    refusal.head !== undefined ? { ETag: `"${refusal.head}"` } : undefined,
  );
}

export function modelingHandle<T>(run: () => Promise<T>, toResponse: (value: T) => Response): Promise<Response> {
  return run().then(toResponse, (err: unknown) => {
    if (isIntegrationError(err)) return modelingRefusal(err);
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

export function badRequest(message: string): IntegrationError {
  return new IntegrationError({ code: 'BAD_REQUEST', message });
}

/** The query keys of `sp` named in `keys`, non-empty only. */
export function pickQuery(sp: URLSearchParams, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = sp.get(k);
    if (v !== null && v.trim() !== '') out[k] = v.trim();
  }
  return out;
}

/**
 * The head the caller expects: the `If-Match` header, else a body
 * `expected_head` (the agent's form). A malformed value is a 400 here rather
 * than an opaque upstream refusal.
 */
export function expectedHeadOf(req: Request, body?: { expected_head?: unknown }): string | undefined {
  const header = req.headers.get('if-match');
  const raw = header !== null && header.trim() !== '' ? header.trim().replace(/^W\//, '').replace(/^"|"$/g, '') : body?.expected_head;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isInteger(n) || n < 0) {
    throw badRequest('The model version you are editing is not recognised. Reload the model and try again.');
  }
  return String(n);
}

export const etagHeaders = (etag: string | undefined): Record<string, string> | undefined =>
  etag !== undefined ? { ETag: `"${etag}"` } : undefined;

/** A body object, or a 400. */
export async function bodyObject(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest('Invalid JSON request body');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest('The request body must be a JSON object.');
  return parsed as Record<string, unknown>;
}

/** The body RM receives: fr's `expected_head` is the If-Match header, never a body field. */
export function withoutExpectedHead(body: Record<string, unknown>): Record<string, unknown> {
  const { expected_head: _drop, ...rest } = body;
  return rest;
}

/** The caller's Idempotency-Key, forwarded only to operations RM declares it on. */
export const idempotencyKeyOf = (req: Request): string | undefined => req.headers.get('idempotency-key')?.trim() || undefined;
