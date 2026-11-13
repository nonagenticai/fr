// Architecture asset routes (control-plane roadmap Phase 4 read + Phase 5 CRUD).
//
// Surfaces the ArchiMate domain owned by requirements_management
// (elements / relationships / views / standards) under the canonical
// `/api/assets/architecture/*` namespace, mirroring the requirements asset
// route shape (list → { data: T[] }, get/create/update → { data: T },
// delete → 204). The pure relays (lists, gets, deletes, the standard create)
// are rows of the RM pass-through table (`_lib/rm-passthrough.ts`).
// Relationships are immutable upstream: create + delete only, no PUT handler.
//
// NOTE: distinct from `/api/architecture/graph/:container`, which is the
// code-graph surface — different upstream, untouched here.

import { validateAuth } from '../../middleware/auth';
import { rmCall, updateArchitectureElement, updateArchitectureStandard, updateArchitectureView } from '../../integrations/architecture';
import {
  getCreateArchitectureElementUrl,
  getCreateArchitectureRelationshipUrl,
  getCreateArchitectureViewUrl,
  type ArchitectureElementIn,
  type ArchitectureViewIn,
  type CreateArchitectureElementHeaders,
  type CreateArchitectureRelationshipHeaders,
  type CreateArchitectureViewHeaders,
  type StandardIn,
} from '@fr/service-client-requirements';
import { jsonResponse } from '../../utils/response';
import { handle } from './_lib/handler';
import { bodyObject, etagHeaders, expectedHeadOf, idempotencyKeyOf, modelingHandle, withoutExpectedHead } from './_lib/modeling-http';
import { readJsonBody } from '../_lib';
import { rmPassthrough } from './_lib/rm-passthrough';

/**
 * A create of an ArchiMate element, relationship or view with the headers RM
 * declares on it (the generated `Create<Row>Headers`):
 *   * `If-Match` (or a body `expected_head`) — the head of the model the row
 *     joins; a mismatch is 412 `stale_head` with the current `head`;
 *   * `Idempotency-Key` — a retried create answers with the first one's row;
 *   * `X-Visibility` ('tenant' | 'user') — a row joins only a model of its own
 *     visibility, so a private model's rows are created private.
 * RM's refusals (422 `model_integrity` + findings, e.g. a relationship the
 * metamodel does not allow) come back in plain words with their findings.
 * RM answers 200 for a get-or-create hit; fr keeps 201 for every create, as before.
 */
async function createArchimateRow(req: Request, url: string): Promise<Response> {
  const body = await bodyObject(req);
  const v = req.headers.get('x-visibility')?.trim().toLowerCase();
  const headers = {
    'If-Match': expectedHeadOf(req, body),
    'Idempotency-Key': idempotencyKeyOf(req),
    ...(v === 'user' || v === 'tenant' ? { 'X-Visibility': v } : {}),
  } satisfies CreateArchitectureElementHeaders & CreateArchitectureRelationshipHeaders & CreateArchitectureViewHeaders;
  return modelingHandle(
    () => rmCall<unknown>(url, { method: 'POST', json: withoutExpectedHead(body), headers }),
    (r) => jsonResponse({ data: r.data }, 201, etagHeaders(r.etag)),
  );
}

// --- Elements -------------------------------------------------------------

export async function handleCreateArchitectureElement(req: Request): Promise<Response> {
  await validateAuth(req);
  return createArchimateRow(req, getCreateArchitectureElementUrl());
}

export async function handleUpdateArchitectureElement(
  req: Request,
  eid: string,
): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  // RM checks If-Match against the model's head on this PUT. The caller's own
  // expected head (header or body `expected_head`) wins; without one fr uses the
  // head of the row it reads for the merge (integrations/architecture.ts
  // `mergeUnderModelHead`). A 412 `stale_head` comes back in plain words.
  const ifMatch = expectedHeadOf(req, body);
  return modelingHandle(
    () => updateArchitectureElement(eid, withoutExpectedHead(body) as unknown as ArchitectureElementIn, { ifMatch }),
    (r) => jsonResponse({ data: r.data }, 200, etagHeaders(r.etag)),
  );
}

// --- Relationships --------------------------------------------------------

// No update handler — relationships are immutable upstream (edit = delete +
// recreate).
export async function handleCreateArchitectureRelationship(
  req: Request,
): Promise<Response> {
  await validateAuth(req);
  return createArchimateRow(req, getCreateArchitectureRelationshipUrl());
}

// --- Views ----------------------------------------------------------------

export async function handleCreateArchitectureView(req: Request): Promise<Response> {
  await validateAuth(req);
  return createArchimateRow(req, getCreateArchitectureViewUrl());
}

export async function handleUpdateArchitectureView(
  req: Request,
  vid: string,
): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  // RM checks If-Match against the model's head on this PUT. The caller's own
  // expected head (header or body `expected_head`) wins; without one fr uses the
  // head of the row it reads for the merge (integrations/architecture.ts
  // `mergeUnderModelHead`). A 412 `stale_head` comes back in plain words.
  const ifMatch = expectedHeadOf(req, body);
  return modelingHandle(
    () => updateArchitectureView(vid, withoutExpectedHead(body) as unknown as ArchitectureViewIn, { ifMatch }),
    (r) => jsonResponse({ data: r.data }, 200, etagHeaders(r.etag)),
  );
}

// --- Standards ------------------------------------------------------------

export async function handleUpdateArchitectureStandard(
  req: Request,
  sid: string,
): Promise<Response> {
  await validateAuth(req);
  const body = await readJsonBody<StandardIn>(req);
  return handle(
    () => updateArchitectureStandard(sid, body),
    (data) => jsonResponse({ data }),
  );
}

// --- Pure relays (routes/assets/_lib/rm-passthrough.ts) ---------------------

export const handleListArchitectureElements = rmPassthrough('listArchitectureElements');
export const handleGetArchitectureElement = rmPassthrough('getArchitectureElement');
export const handleDeleteArchitectureElement = rmPassthrough('deleteArchitectureElement');
export const handleListArchitectureRelationships = rmPassthrough('listArchitectureRelationships');
export const handleGetArchitectureRelationship = rmPassthrough('getArchitectureRelationship');
export const handleDeleteArchitectureRelationship = rmPassthrough('deleteArchitectureRelationship');
export const handleListArchitectureViews = rmPassthrough('listArchitectureViews');
export const handleGetArchitectureView = rmPassthrough('getArchitectureView');
export const handleDeleteArchitectureView = rmPassthrough('deleteArchitectureView');
export const handleListArchitectureStandards = rmPassthrough('listArchitectureStandards');
export const handleGetArchitectureStandard = rmPassthrough('getArchitectureStandard');
export const handleDeleteArchitectureStandard = rmPassthrough('deleteArchitectureStandard');
export const handleCreateArchitectureStandard = rmPassthrough('createArchitectureStandard');
