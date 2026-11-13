// src/lib/approvals-ws-project-tenant.ts
//
// fr row 14d-0b — the DB lookup behind the `approvals:project:<id>` subscribe
// gate. Returns the project row's id + project_data (the shape
// `classifyProjectOwnership` reads), or null when no row exists. Kept out of
// `domain/engagement/adapters/websocket.ts` so that module stays DB-free; it is
// injected via `WebSocketManager.setProjectLookup` in server.ts.
import { eq } from 'drizzle-orm';
import { db, projects } from '../db/client';
import type { OwnershipCandidateProject } from './project-owner-guard';

export async function lookupApprovalsWsProject(
  projectId: string,
): Promise<OwnershipCandidateProject | null> {
  const [row] = await db
    .select({ id: projects.id, project_data: projects.project_data })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}
