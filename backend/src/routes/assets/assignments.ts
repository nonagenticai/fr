// src/routes/assets/assignments.ts
//
// Read-only view of asset_assignments for the FE Library "Overrides only"
// + "Blocked" filters (frontend/src/routes/library/[type]/+page.svelte).
//
// Returns the (asset_id, link_kind) pairs that match the caller's
// current scope so the FE can client-side filter the existing rows
// list without a backend asset_type round-trip per row.
//
// GET /api/assets/_assignments
//   ?type=<asset_type>
//   [&scope_kind=workspace|department|project]
//   [&scope_id=<uuid>]    (required when scope_kind is department|project)
//
// Response body: `{ data: { asset_id: string; link_kind: 'owns'|'override'|'block' }[] }`

import type { z } from 'zod';
import { and, eq, isNull, or } from 'drizzle-orm';
import { QuerySchema } from './assignments-schemas';
import { validateAuth } from '../../middleware/auth';
import { tryCtxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { db, assetAssignments } from '../../db/client';
import {
  AppError,
  BadRequestError,
} from '../../utils/errors';

// The query schema lives in assignments-schemas.ts (side-effect free: the
// fr-agui capability declaration shares it, P4c part 1).

/**
 * Render a ZodError as one human sentence: `type: <msg>; scope_id: <msg>`.
 * Object-level `.refine()` issues carry an empty path and are emitted bare.
 */
function formatQueryIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const param = issue.path.join('.');
      return param ? `${param}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

interface AssignmentRow {
  asset_id: string;
  link_kind: 'owns' | 'override' | 'block';
}

export async function handleListAssetAssignments(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    // `?? undefined` (not the raw null from searchParams.get) so an ABSENT
    // param is reported as "required" rather than as a null of the wrong type.
    type: url.searchParams.get('type') ?? undefined,
    scope_kind: url.searchParams.get('scope_kind') ?? undefined,
    scope_id: url.searchParams.get('scope_id') ?? undefined,
  });
  if (!parsed.success) {
    // `parsed.error.message` is Zod's JSON-serialized issue ARRAY — a wall of
    // escaped JSON in the `error` field that names the offending param only if
    // the reader hand-parses it. Emit a readable sentence instead and keep the
    // machine-readable issues in `details`.
    throw new BadRequestError(
      `Invalid query parameters: ${formatQueryIssues(parsed.error)}`,
      parsed.error.issues,
    );
  }
  const { type, scope_kind, scope_id } = parsed.data;
  const tenantId = tryCtxTenantId() ?? user.tenantId;
  if (!tenantId) {
    throw new AppError(403, 'tenant context required');
  }
  // Workspace edges: target_id IS NULL.
  // Department/project edges: target_id = the dept/project id, scope_kind matches.
  let where;
  if (scope_kind === 'department' || scope_kind === 'project') {
    where = and(
      eq(assetAssignments.workspace_id, tenantId),
      eq(assetAssignments.asset_type, type),
      eq(assetAssignments.scope_kind, scope_kind),
      eq(assetAssignments.target_id, scope_id!),
    );
  } else {
    // Workspace scope (or unspecified) → workspace-level edges.
    where = and(
      eq(assetAssignments.workspace_id, tenantId),
      eq(assetAssignments.asset_type, type),
      eq(assetAssignments.scope_kind, 'workspace'),
      isNull(assetAssignments.target_id),
    );
  }
  const rows = await db
    .select({
      asset_id: assetAssignments.asset_id,
      link_kind: assetAssignments.link_kind,
    })
    .from(assetAssignments)
    .where(where);
  return jsonResponse({ data: rows as AssignmentRow[] });
}
