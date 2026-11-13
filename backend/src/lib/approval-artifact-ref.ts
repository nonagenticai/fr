// src/lib/approval-artifact-ref.ts
//
// D13 (George 2026-10-13): an approval may name ONE artifact — the thing the
// human is being asked to approve — as `artifact_ref: { artifact_id, version? }`.
// Both n8n minting doors accept it (POST /api/execution/approvals and
// POST /api/webhooks/n8n/card-approval); it is stored in `approvals.artifact_ref`
// (migration 192), returned on every approval read, echoed on the decision
// callback (buildCallbackPayload) and rendered as an "Artifact" link on the
// approval detail page.
//
// VALIDATED AT CREATE, against the artifact service, through the SAME
// project-scoped read the artifacts browser uses (`getArtifact(projectId, id)`),
// scoped to the approval's resolved (project) tenant, not the caller's frame:
//   * malformed (not an object, unknown key, non-uuid id, version not an
//     integer >= 1)                                  → 422 `artifact_ref_invalid`
//   * the approval resolves to no project, the artifact does not exist, or it
//     belongs to another project (and so possibly another tenant)
//                                                     → 422 `artifact_ref_not_found`
//   * `version` names a version the artifact does not have (> its current
//     version)                                        → 422 `artifact_ref_not_found`
//   * the artifact service is down (5xx / unreachable) → the IntegrationError
//     propagates (502/504): an outage is not the caller's bad input.
//
// VERSION SEMANTICS. `version` is optional. Omitted ⇒ the ref names the
// artifact, not a pinned version (stored without `version`; the reader sees
// whatever is current). Present ⇒ it must be between 1 and the artifact's
// CURRENT version at create time (the artifact service exposes only the current
// version's metadata, so an older version can be checked only for range); it is
// stored as given.
//
// DEDUPE (one card, one open gate). A create that dedupes onto an existing
// pending gate KEEPS that gate's ref. A request that names a ref DIFFERENT from
// the gate's (including a ref where the gate has none) is refused 409
// `artifact_ref_conflict` — the repo's existing pattern for a deduped request
// that asks a different question (`open_gate_conflict`, services/approvals/u3-gates.ts):
// answering `deduplicated: true` would tell the caller its artifact is being
// approved while the human decides about another one. A request with NO ref
// dedupes onto any gate as before.

import { z } from 'zod';

import { getArtifact } from '../integrations/artifacts';
import { isIntegrationError } from '../integrations/_lib/errors';
import { AppError, ValidationError } from '../utils/errors';

export const ARTIFACT_REF_INVALID = 'artifact_ref_invalid';
export const ARTIFACT_REF_NOT_FOUND = 'artifact_ref_not_found';
export const ARTIFACT_REF_CONFLICT = 'artifact_ref_conflict';

export interface ApprovalArtifactRef {
  artifact_id: string;
  version?: number;
}

/**
 * The shape of an artifact_service id: 8-4-4-4-12 hex, case-insensitive, ANY
 * version/variant nibble. artifact_service is the authority on its ids and mints
 * them as `UUID(int=secrets.randbits(128))` (src/routes/artifacts.py) — 128 random
 * bits, so the RFC 4122 variant nibble is random too (live: `…-567b-54ab-…`, v4
 * run 11, 2026-10-15). Its column is Postgres `uuid`, which takes any such value.
 * A strict RFC validator (`isValidUuid`) refused real ids, so it must not be used
 * here; every OTHER uuid field keeps it.
 */
export const ARTIFACT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const artifactRefSchema = z
  .object({
    artifact_id: z.string().regex(ARTIFACT_ID_RE, { message: 'artifact_id must be an 8-4-4-4-12 hex id' }),
    version: z.number().int().min(1).optional(),
  })
  .strict();

/** The body field: accepted as anything, narrowed by {@link parseArtifactRef} so a bad value gets its own code. */
export const artifactRefBodyField = z.unknown().optional();

/**
 * Narrow a body's `artifact_ref`: `undefined` (absent) and `null` mean "no ref";
 * anything else must be `{artifact_id: 8-4-4-4-12 hex, version?: int >= 1}` exactly, else
 * 422 `artifact_ref_invalid`.
 */
export function parseArtifactRef(raw: unknown): ApprovalArtifactRef | null {
  if (raw === undefined || raw === null) return null;
  const parsed = artifactRefSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      'artifact_ref must be {artifact_id: <8-4-4-4-12 hex id>, version?: <integer >= 1>} or null. Nothing was written',
      { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    ).withCode(ARTIFACT_REF_INVALID);
  }
  const { artifact_id, version } = parsed.data;
  return version === undefined ? { artifact_id: artifact_id.toLowerCase() } : { artifact_id: artifact_id.toLowerCase(), version };
}

function notFound(ref: ApprovalArtifactRef, why: string): never {
  throw new ValidationError(
    `artifact_ref names artifact ${ref.artifact_id}${ref.version !== undefined ? ` version ${ref.version}` : ''}, ` +
      `which ${why}. Nothing was written`,
    { artifact_id: ref.artifact_id, ...(ref.version !== undefined ? { version: ref.version } : {}) },
  ).withCode(ARTIFACT_REF_NOT_FOUND);
}

/**
 * Prove the ref names an artifact of `projectId` (the approval's own,
 * server-resolved project). 422 `artifact_ref_not_found` otherwise; an outage of
 * the artifact service propagates.
 *
 * The read is scoped to `tenantId` — the approval's resolved tenant, i.e. the
 * PROJECT's — sent as an explicit `x-tenant-id`, never the caller's ambient
 * frame tenant: artifact_service scopes by that header, so a caller whose frame
 * names another tenant would read a valid ref as a 404.
 */
export async function assertArtifactRefInProject(
  ref: ApprovalArtifactRef,
  projectId: string | null,
  tenantId: string,
): Promise<void> {
  if (!projectId) notFound(ref, 'cannot be checked: this approval resolves to no project (an artifact always belongs to one)');
  let artifact: { id: string; project_id: string; version: number };
  try {
    artifact = await getArtifact(projectId, ref.artifact_id, tenantId);
  } catch (err) {
    const status = isIntegrationError(err) ? err.upstreamStatus : undefined;
    if (status === 404 || status === 403) notFound(ref, `is not an artifact of project ${projectId}`);
    throw err;
  }
  if (!artifact || String(artifact.project_id).toLowerCase() !== projectId.toLowerCase()) {
    notFound(ref, `is not an artifact of project ${projectId}`);
  }
  if (ref.version !== undefined && !(typeof artifact.version === 'number' && ref.version <= artifact.version)) {
    notFound(ref, `does not exist (the artifact's current version is ${String(artifact.version)})`);
  }
}

function sameRef(a: ApprovalArtifactRef | null, b: ApprovalArtifactRef | null): boolean {
  if (!a || !b) return a === b;
  return a.artifact_id.toLowerCase() === b.artifact_id.toLowerCase() && (a.version ?? null) === (b.version ?? null);
}

/** Narrow a stored column value (jsonb) to the ref shape, or null. */
export function storedArtifactRef(raw: unknown): ApprovalArtifactRef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.artifact_id !== 'string' || !r.artifact_id) return null;
  return typeof r.version === 'number' && Number.isInteger(r.version) && r.version >= 1
    ? { artifact_id: r.artifact_id, version: r.version }
    : { artifact_id: r.artifact_id };
}

/**
 * A request deduped onto `existing` keeps the gate's ref. A request that names
 * a DIFFERENT ref (incl. one where the gate has none) is 409
 * `artifact_ref_conflict`; a request with no ref is always compatible.
 */
export function assertArtifactRefDedupeCompatible(
  existing: { id: string; artifact_ref?: unknown },
  requested: ApprovalArtifactRef | null,
): void {
  if (!requested) return;
  const have = storedArtifactRef(existing.artifact_ref);
  if (sameRef(have, requested)) return;
  throw new AppError(
    409,
    `card already holds open approval ${existing.id} for ` +
      (have ? `artifact ${have.artifact_id}${have.version !== undefined ? ` v${have.version}` : ''}` : 'no artifact') +
      `; a request for artifact ${requested.artifact_id}${requested.version !== undefined ? ` v${requested.version}` : ''} ` +
      'cannot be deduplicated onto it. Nothing was written',
    { existing_approval_id: existing.id, existing_artifact_ref: have, requested_artifact_ref: requested },
  ).withCode(ARTIFACT_REF_CONFLICT);
}
