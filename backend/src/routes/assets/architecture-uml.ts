// UML (profile uml-2.5.1-p1, RM target spec §8.2) and TRACE LINK (§7.4) routes.
//
// Same conventions as routes/assets/architecture-modeling.ts, whose helpers this
// module reuses: `validateAuth` first, the request tenant only, `{ data }`
// envelopes, `If-Match` (or a body `expected_head`) forwarded and `ETag`
// relayed, `Idempotency-Key` forwarded on the creates RM declares it on, RM
// refusals in plain words (`modelingRefusal`). A UML delete answers 200
// `{ data: { cascaded } }` — RM lists what the delete took with it, and the UI
// tells the user.
//
// Every RM path, body type and header comes from the generated client. Bodies
// are forwarded as sent (minus fr's `expected_head`); RM validates them against
// the whole model and its own schemas and refuses with 422 (`model_integrity` +
// findings, or `VALIDATION_ERROR` + details), which the UI shows in words.

import { validateAuth } from '../../middleware/auth';
import { rmCall, rmReadListedRow, rmReadRow, rmUpdateModelRow, seg } from '../../integrations/architecture';
import { bodyKeysOf } from '../../integrations/_lib/merge-update';
import {
  getCreateTraceLinkUrl,
  getGetUmlDiagramUrl,
  getGetUmlElementUrl,
  getGetUmlInteractionUrl,
  getGetUmlRelationshipUrl,
  getListUmlDiagramConnectionsUrl,
  getListUmlDiagramObjectsUrl,
  getUpdateUmlDiagramConnectionUrl,
  getUpdateUmlDiagramObjectUrl,
  getUpdateUmlDiagramUrl,
  getUpdateUmlElementUrl,
  getUpdateUmlInteractionUrl,
  getUpdateUmlRelationshipUrl,
  PUT_BODY_PROPERTIES,
  TraceLinkInLinkType,
  TraceRefKind,
  type SchemasUmlApiUmlDiagramConnectionIn,
  type SchemasUmlApiUmlDiagramObjectIn,
  type TraceLinkIn,
  type TraceLinkOut,
  type TraceRef,
  type UmlDiagramConnectionOut,
  type UmlDiagramObjectOut,
  type UmlDiagramOut,
  type UmlDiagramUpdate,
  type UmlElementOut,
  type UmlElementUpdate,
  type UmlInteractionOut,
  type UmlInteractionUpdate,
  type UmlRelationshipOut,
  type UmlRelationshipUpdate,
  type UpdateUmlDiagramConnectionHeaders,
  type UpdateUmlDiagramObjectHeaders,
  type UpdateUmlDiagramHeaders,
  type UpdateUmlInteractionHeaders,
  type UpdateUmlRelationshipHeaders,
  type UpdateUmlElementHeaders,
} from '@fr/service-client-requirements';
import { jsonResponse } from '../../utils/response';
import { rmDownload, rmPassthrough } from './_lib/rm-passthrough';
import { badRequest, bodyObject, etagHeaders, expectedHeadOf, modelingHandle, withoutExpectedHead } from './_lib/modeling-http';

// The keys each replacing UML PUT accepts, from the GENERATED snapshot.
const UML_ELEMENT_KEYS = bodyKeysOf<UmlElementUpdate>()(PUT_BODY_PROPERTIES.UmlElementUpdate);
const UML_RELATIONSHIP_KEYS = bodyKeysOf<UmlRelationshipUpdate>()(PUT_BODY_PROPERTIES.UmlRelationshipUpdate);
const UML_INTERACTION_KEYS = bodyKeysOf<UmlInteractionUpdate>()(PUT_BODY_PROPERTIES.UmlInteractionUpdate);
const UML_DIAGRAM_KEYS = bodyKeysOf<UmlDiagramUpdate>()(PUT_BODY_PROPERTIES.UmlDiagramUpdate);
const UML_DIAGRAM_OBJECT_KEYS = bodyKeysOf<SchemasUmlApiUmlDiagramObjectIn>()(
  PUT_BODY_PROPERTIES.schemas__uml_api__UmlDiagramObjectIn,
);
const UML_DIAGRAM_CONNECTION_KEYS = bodyKeysOf<SchemasUmlApiUmlDiagramConnectionIn>()(
  PUT_BODY_PROPERTIES.schemas__uml_api__UmlDiagramConnectionIn,
);

/**
 * A UML update. RM's PUT REPLACES the row (`uml_store.py` `update` rebuilds it
 * from the payload), so the stored row is read first and only the caller's keys
 * are overlaid: a field the caller omits — or one RM adds later — keeps its
 * value (merge-update.ts). `keys` come from the GENERATED snapshot. RM checks
 * If-Match against the model's head: the caller's own expected head is
 * forwarded, else the head fr read with the row (`rmUpdateModelRow`); a 412
 * `stale_head` is relayed in plain words. `H` is the GENERATED `Update<Row>Headers`.
 */
async function update<T, H extends { 'If-Match'?: string }>(
  req: Request,
  url: string,
  keys: readonly string[],
  readCurrent: () => Promise<Record<string, unknown>>,
): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  const clientIfMatch = expectedHeadOf(req, body);
  return modelingHandle(
    () => rmUpdateModelRow<T, H>({ putUrl: url, patch: withoutExpectedHead(body), keys, readCurrent, clientIfMatch }),
    (r) => jsonResponse({ data: r.data }, 200, etagHeaders(r.etag)),
  );
}

// --- Read-modify-write updates ------------------------------------------------

export const handleUpdateUmlElement = (req: Request, id: string) => update<UmlElementOut, UpdateUmlElementHeaders>(req, getUpdateUmlElementUrl(seg(id)), UML_ELEMENT_KEYS, () => rmReadRow(getGetUmlElementUrl(seg(id))));
export const handleUpdateUmlRelationship = (req: Request, id: string) => update<UmlRelationshipOut, UpdateUmlRelationshipHeaders>(req, getUpdateUmlRelationshipUrl(seg(id)), UML_RELATIONSHIP_KEYS, () => rmReadRow(getGetUmlRelationshipUrl(seg(id))));
export const handleUpdateUmlInteraction = (req: Request, id: string) => update<UmlInteractionOut, UpdateUmlInteractionHeaders>(req, getUpdateUmlInteractionUrl(seg(id)), UML_INTERACTION_KEYS, () => rmReadRow(getGetUmlInteractionUrl(seg(id))));
export const handleUpdateUmlDiagram = (req: Request, id: string) => update<UmlDiagramOut, UpdateUmlDiagramHeaders>(req, getUpdateUmlDiagramUrl(seg(id)), UML_DIAGRAM_KEYS, () => rmReadRow(getGetUmlDiagramUrl(seg(id))));
export const handleUpdateUmlDiagramObject = (req: Request, did: string, oid: string) =>
  update<UmlDiagramObjectOut, UpdateUmlDiagramObjectHeaders>(req, getUpdateUmlDiagramObjectUrl(seg(did), seg(oid)), UML_DIAGRAM_OBJECT_KEYS, () =>
    rmReadListedRow(getListUmlDiagramObjectsUrl(seg(did)), oid),
  );
export const handleUpdateUmlDiagramConnection = (req: Request, did: string, cid: string) =>
  update<UmlDiagramConnectionOut, UpdateUmlDiagramConnectionHeaders>(req, getUpdateUmlDiagramConnectionUrl(seg(did), seg(cid)), UML_DIAGRAM_CONNECTION_KEYS, () =>
    rmReadListedRow(getListUmlDiagramConnectionsUrl(seg(did)), cid),
  );

// --- Downloads (rm-passthrough.ts `rmDownload`) ---------------------------------

export const handleDownloadUmlDiagramPng = rmDownload('renderUmlDiagram', { format: 'png' });
export const handleDownloadUmlDiagramSvg = rmDownload('renderUmlDiagram', { format: 'svg' });
export const handleDownloadUmlDiagramPdf = rmDownload('renderUmlDiagram', { format: 'pdf' });
export const handleDownloadRevisionUmlDiagramPng = rmDownload('renderModelRevisionDiagram', { format: 'png' });
export const handleDownloadRevisionUmlDiagramSvg = rmDownload('renderModelRevisionDiagram', { format: 'svg' });
export const handleDownloadRevisionUmlDiagramPdf = rmDownload('renderModelRevisionDiagram', { format: 'pdf' });

// --- Trace links (§7.4) -------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_KIND_VALUES: readonly string[] = Object.values(TraceRefKind);
const LINK_TYPE_VALUES: readonly string[] = Object.values(TraceLinkInLinkType);

/** One end of a link, checked so the user is told which end is wrong, in words. */
function traceRef(v: unknown, which: string): TraceRef {
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !TRACE_KIND_VALUES.includes(o.kind)) throw badRequest(`Choose what kind of item the ${which} is.`);
  if (typeof o.id !== 'string' || o.id.trim() === '') throw badRequest(`Choose the ${which} item.`);
  if (!UUID_RE.test(o.id.trim())) throw badRequest(`The ${which} item's id is not recognised. Copy it from the item's page.`);
  return { kind: o.kind as TraceRef['kind'], id: o.id.trim() };
}

export async function handleCreateTraceLink(req: Request): Promise<Response> {
  await validateAuth(req);
  const body = await bodyObject(req);
  const source = traceRef(body.source, 'starting');
  const linkType = body.link_type;
  if (typeof linkType !== 'string' || !LINK_TYPE_VALUES.includes(linkType)) throw badRequest('Choose how the two items are linked.');
  const hasTarget = body.target !== undefined && body.target !== null;
  const hasCode = body.target_code !== undefined && body.target_code !== null;
  if (hasTarget === hasCode) throw badRequest('Link to exactly one thing: another item, or a place in the code.');
  const payload: TraceLinkIn = { source, link_type: linkType as TraceLinkIn['link_type'] };
  if (hasTarget) payload.target = traceRef(body.target, 'linked');
  else {
    const c = body.target_code as Record<string, unknown>;
    const field = (k: 'repo' | 'commit' | 'symbol', label: string) => {
      const v = c?.[k];
      if (typeof v !== 'string' || v.trim() === '') throw badRequest(`Give the code ${label}.`);
      return v.trim();
    };
    payload.target_code = { repo: field('repo', 'repository'), commit: field('commit', 'commit'), symbol: field('symbol', 'symbol') };
  }
  if (typeof body.note === 'string' && body.note.trim()) payload.note = body.note.trim();
  return modelingHandle(
    () => rmCall<TraceLinkOut>(getCreateTraceLinkUrl(), { method: 'POST', json: payload }),
    (r) => jsonResponse({ data: r.data }, 201, etagHeaders(r.etag)),
  );
}

// --- Pure relays (routes/assets/_lib/rm-passthrough.ts) -------------------------

export const handleListUmlElements = rmPassthrough('listUmlElements');
export const handleCreateUmlElement = rmPassthrough('createUmlElement');
export const handleGetUmlElement = rmPassthrough('getUmlElement');
export const handleDeleteUmlElement = rmPassthrough('deleteUmlElement');
export const handleListUmlRelationships = rmPassthrough('listUmlRelationships');
export const handleCreateUmlRelationship = rmPassthrough('createUmlRelationship');
export const handleGetUmlRelationship = rmPassthrough('getUmlRelationship');
export const handleDeleteUmlRelationship = rmPassthrough('deleteUmlRelationship');
export const handleListUmlInteractions = rmPassthrough('listUmlInteractions');
export const handleCreateUmlInteraction = rmPassthrough('createUmlInteraction');
export const handleGetUmlInteraction = rmPassthrough('getUmlInteraction');
export const handleDeleteUmlInteraction = rmPassthrough('deleteUmlInteraction');
export const handleListUmlDiagrams = rmPassthrough('listUmlDiagrams');
export const handleCreateUmlDiagram = rmPassthrough('createUmlDiagram');
export const handleGetUmlDiagram = rmPassthrough('getUmlDiagram');
export const handleDeleteUmlDiagram = rmPassthrough('deleteUmlDiagram');
export const handleListUmlDiagramObjects = rmPassthrough('listUmlDiagramObjects');
export const handleCreateUmlDiagramObject = rmPassthrough('createUmlDiagramObject');
export const handleDeleteUmlDiagramObject = rmPassthrough('deleteUmlDiagramObject');
export const handleListUmlDiagramConnections = rmPassthrough('listUmlDiagramConnections');
export const handleCreateUmlDiagramConnection = rmPassthrough('createUmlDiagramConnection');
export const handleDeleteUmlDiagramConnection = rmPassthrough('deleteUmlDiagramConnection');
export const handleGetUmlDiagramPicture = rmPassthrough('renderUmlDiagram');
export const handleGetRevisionUmlDiagramPicture = rmPassthrough('renderModelRevisionDiagram');
export const handleGetUmlProfile = rmPassthrough('getUmlProfile');
export const handleListTraceLinks = rmPassthrough('listTraceLinks');
export const handleGetTraceLink = rmPassthrough('getTraceLink');
export const handleDeleteTraceLink = rmPassthrough('deleteTraceLink');
