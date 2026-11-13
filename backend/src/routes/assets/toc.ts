// Theory-of-Constraints (TOC) asset proxies over requirements_management's
// `/toc` API. The pure relays (list / get / create / delete) are rows of the
// RM pass-through table (`_lib/rm-passthrough.ts`); the handlers below carry fr
// logic: the read-modify-write updates and the cached graph / quality / config
// reads (`integrations/toc.ts`).
//
// fr does NOT reimplement TOC; reads/CRUD/graph/quality/config proxy straight
// to RM. The heavy "build" ops (author IO-Map / Evaporating-Cloud / lenses)
// are NOT here — they go through the n8n AA builder subroutines wired in
// `agui/actions/toc.ts`.

import { validateAuth } from '../../middleware/auth';
import { IntegrationError } from '../../integrations/_lib/errors';
import {
  getTocConfig,
  getTocGraph,
  getTocQuality,
  updateTocConfig,
  updateTocNode,
  updateTocTree,
  type TocNodeIn,
  type TocSettingsIn,
  type TocTreeIn,
} from '../../integrations/toc';
import { jsonResponse } from '../../utils/response';
import { handle } from './_lib/handler';
import { rmPassthrough } from './_lib/rm-passthrough';

function badBody(): never {
  throw new IntegrationError({
    code: 'BAD_REQUEST',
    message: 'Invalid JSON request body',
  });
}

// --- Trees ----------------------------------------------------------------

export async function handleUpdateTocTree(
  req: Request,
  treeId: string,
): Promise<Response> {
  await validateAuth(req);
  const body = (await req.json().catch(badBody)) as TocTreeIn;
  return handle(
    () => updateTocTree(treeId, body),
    (data) => jsonResponse({ data }),
  );
}

// --- Graph / Quality ------------------------------------------------------

export async function handleGetTocGraph(
  req: Request,
  treeId: string,
): Promise<Response> {
  await validateAuth(req);
  const fresh = new URL(req.url).searchParams.get('fresh') === 'true';
  return handle(
    () => getTocGraph(treeId, { fresh }),
    (data) => jsonResponse({ data }),
  );
}

export async function handleGetTocQuality(
  req: Request,
  treeId: string,
): Promise<Response> {
  await validateAuth(req);
  const fresh = new URL(req.url).searchParams.get('fresh') === 'true';
  return handle(
    () => getTocQuality(treeId, { fresh }),
    (data) => jsonResponse({ data }),
  );
}

// --- Config ---------------------------------------------------------------

export async function handleGetTocConfig(req: Request): Promise<Response> {
  await validateAuth(req);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id') ?? undefined;
  const fresh = url.searchParams.get('fresh') === 'true';
  return handle(
    () => getTocConfig({ projectId, fresh }),
    (data) => jsonResponse({ data }),
  );
}

export async function handleUpdateTocConfig(req: Request): Promise<Response> {
  await validateAuth(req);
  const body = (await req.json().catch(badBody)) as TocSettingsIn;
  return handle(
    () => updateTocConfig(body),
    (data) => jsonResponse({ data }),
  );
}

// --- Nodes ----------------------------------------------------------------

export async function handleUpdateTocNode(
  req: Request,
  treeId: string,
  nodeId: string,
): Promise<Response> {
  await validateAuth(req);
  const body = (await req.json().catch(badBody)) as TocNodeIn;
  return handle(
    () => updateTocNode(treeId, nodeId, body),
    (data) => jsonResponse({ data }),
  );
}

// --- Edges ----------------------------------------------------------------


// --- Pure relays (routes/assets/_lib/rm-passthrough.ts) ---------------------

export const handleListTocTrees = rmPassthrough('listTocTrees');
export const handleCreateTocTree = rmPassthrough('createTocTree');
export const handleGetTocTree = rmPassthrough('getTocTree');
export const handleDeleteTocTree = rmPassthrough('deleteTocTree');
export const handleListTocNodes = rmPassthrough('listTocNodes');
export const handleCreateTocNode = rmPassthrough('createTocNode');
export const handleDeleteTocNode = rmPassthrough('deleteTocNode');
export const handleListTocEdges = rmPassthrough('listTocEdges');
export const handleCreateTocEdge = rmPassthrough('createTocEdge');
export const handleDeleteTocEdge = rmPassthrough('deleteTocEdge');
