// ArchiMate VIEW CONTENTS (RM target spec §8.1: a view's objects and connections)
// and the ArchiMate METAMODEL reference data, under `/api/assets/architecture/*`.
//
// Same conventions as routes/assets/architecture-modeling.ts: `validateAuth`
// first, the request tenant only, `{ data }` envelopes, `If-Match` (or a body
// `expected_head`) forwarded and `ETag` relayed, RM refusals in plain words
// (`modelingRefusal`). Paths, bodies and headers are the generated client's.
//
// ⚠️ RM declares NO Idempotency-Key on a view's objects or connections, so fr
// neither forwards nor promises one: a create whose outcome is unknown (a
// timeout, a 5xx) may have landed, and the caller must RE-READ the view before
// adding again (the contents panel and the agent both do).
//
// The metamodel routes are read-only reference data (no tenant rows): every
// concept with its layer, and the relationship types the ArchiMate matrix
// allows between two concept types. The UI's pickers are fed from them.

import { validateAuth } from '../../middleware/auth';
import { rmReadListedRow, rmUpdateModelRow, seg } from '../../integrations/architecture';
import { bodyKeysOf } from '../../integrations/_lib/merge-update';
import {
  getListArchitectureViewConnectionsUrl,
  getListArchitectureViewObjectsUrl,
  getUpdateArchitectureViewConnectionUrl,
  PUT_BODY_PROPERTIES,
  getUpdateArchitectureViewObjectUrl,
  type UpdateArchitectureViewConnectionHeaders,
  type UpdateArchitectureViewObjectHeaders,
  type ViewConnectionIn,
  type ViewConnectionOut,
  type ViewObjectIn,
  type ViewObjectOut,
} from '@fr/service-client-requirements';
import { jsonResponse } from '../../utils/response';
import { rmPassthrough } from './_lib/rm-passthrough';
import { bodyObject, etagHeaders, expectedHeadOf, modelingHandle, withoutExpectedHead } from './_lib/modeling-http';

// The keys each replacing PUT accepts, from the GENERATED snapshot.
const VIEW_OBJECT_KEYS = bodyKeysOf<ViewObjectIn>()(PUT_BODY_PROPERTIES.ViewObjectIn);
const VIEW_CONNECTION_KEYS = bodyKeysOf<ViewConnectionIn>()(PUT_BODY_PROPERTIES.ViewConnectionIn);

/**
 * RM's PUT REPLACES the object / connection (`view_occurrences.py` `update_object`
 * sets every payload field), and RM serves no single GET for one, so the stored
 * row is read from the view's list and only the caller's keys are overlaid
 * (merge-update.ts): an omitted field — or one RM adds later — keeps its value.
 */
async function updatePart<T, H extends { 'If-Match'?: string }>(
  req: Request,
  url: string,
  keys: readonly string[],
  readCurrent: () => Promise<Record<string, unknown>>,
): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  // RM checks If-Match against the view's model head: the caller's own expected
  // head is forwarded, else the head fr read with the row (`rmUpdateModelRow`).
  const clientIfMatch = expectedHeadOf(req, body);
  return modelingHandle(
    () => rmUpdateModelRow<T, H>({ putUrl: url, patch: withoutExpectedHead(body), keys, readCurrent, clientIfMatch }),
    (r) => jsonResponse({ data: r.data }, 200, etagHeaders(r.etag)),
  );
}

// --- Read-modify-write updates ----------------------------------------------------

export const handleUpdateArchitectureViewObject = (req: Request, vid: string, oid: string) =>
  updatePart<ViewObjectOut, UpdateArchitectureViewObjectHeaders>(req, getUpdateArchitectureViewObjectUrl(seg(vid), seg(oid)), VIEW_OBJECT_KEYS, () =>
    rmReadListedRow(getListArchitectureViewObjectsUrl(seg(vid)), oid),
  );
export const handleUpdateArchitectureViewConnection = (req: Request, vid: string, cid: string) =>
  updatePart<ViewConnectionOut, UpdateArchitectureViewConnectionHeaders>(req, getUpdateArchitectureViewConnectionUrl(seg(vid), seg(cid)), VIEW_CONNECTION_KEYS, () =>
    rmReadListedRow(getListArchitectureViewConnectionsUrl(seg(vid)), cid),
  );

// --- Pure relays (routes/assets/_lib/rm-passthrough.ts) ---------------------------

/** The view's shapes, in drawing order: `{ data: [...] }`. */
export const handleListArchitectureViewObjects = rmPassthrough('listArchitectureViewObjects');
export const handleCreateArchitectureViewObject = rmPassthrough('createArchitectureViewObject');
export const handleDeleteArchitectureViewObject = rmPassthrough('deleteArchitectureViewObject');
/** The view's lines: `{ data: [...] }`. */
export const handleListArchitectureViewConnections = rmPassthrough('listArchitectureViewConnections');
export const handleCreateArchitectureViewConnection = rmPassthrough('createArchitectureViewConnection');
export const handleDeleteArchitectureViewConnection = rmPassthrough('deleteArchitectureViewConnection');
/** Every ArchiMate concept RM accepts (`type`, `layer`, `aspect`, `archi_class`) and the relationship types. */
export const handleGetArchimateConcepts = rmPassthrough('listArchimateConcepts');
/** The relationship types the matrix allows per (source_type, target_type) pair; both filters optional. */
export const handleQueryArchimateRelationshipMatrix = rmPassthrough('queryArchimateRelationshipMatrix');
