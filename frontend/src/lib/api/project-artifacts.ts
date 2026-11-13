// The requirements_management (RM) knowledge assets a project produced, read
// through fr's existing asset routes with `?project_id=` so the narrowing
// happens SERVER-SIDE. Read-only.
//
// Which routes forward a project filter to RM (measured on this branch):
//   - /api/assets/requirements                 → `rm_project_id` (RM `project_id`)
//   - /api/assets/decisions                    → `rm_project_id` (RM `project_id`)
//   - /api/assets/architecture/elements        → `project_id` (params forwarded verbatim)
//   - /api/assets/architecture/relationships   → `project_id` (params forwarded verbatim)
//   - /api/assets/principles                   → `rm_project_id`, forwarded as
//     RM `project_id`, which RM (rm#208) applies to `origin_project_id`: the
//     principles this project MINTED — provenance, not "the principles that
//     apply to this project". Labelled exactly that. fr's own `?project_id=` on
//     that route is its effective-scope filter and never reaches RM.
//
// Requirements and decisions use `rm_project_id`, NOT `project_id`: the latter
// also runs fr's effective-scope filter (`listWithSystemUnion` →
// `applyEffectiveFilter`) on top of RM's narrowing, which answers "what applies
// to this project" and hides a row an admin BLOCKED in this project's scope even
// when the project produced it (and lazily writes `owns` rows on a read). The
// strict system-row drop for customer tenants still applies on both params.
// `rm_project_id` sends no `X-Project-Resolved`, so `projectUnknown` stays false.

import { authFetch } from './auth-fetch';
import { failureOf, unreachable, type CatalogueFailure } from './conveyor-catalogue';

export type ProjectArtifactKind =
  | 'requirements'
  | 'decisions'
  | 'principles'
  | 'architecture-elements'
  | 'architecture-relationships';

export const PROJECT_ARTIFACT_PATHS: Readonly<Record<ProjectArtifactKind, string>> = {
  requirements: '/api/assets/requirements',
  decisions: '/api/assets/decisions',
  principles: '/api/assets/principles',
  'architecture-elements': '/api/assets/architecture/elements',
  'architecture-relationships': '/api/assets/architecture/relationships',
};

/** The query parameter each route narrows by (see the header). */
export const PROJECT_ARTIFACT_PARAM: Readonly<Record<ProjectArtifactKind, 'project_id' | 'rm_project_id'>> = {
  requirements: 'rm_project_id',
  decisions: 'rm_project_id',
  principles: 'rm_project_id',
  'architecture-elements': 'project_id',
  'architecture-relationships': 'project_id',
};

/** One page; the route says (`X-Truncated`) whether more exist. */
export const PROJECT_ARTIFACT_PAGE = 100;

export interface ArtifactRow {
  id: string;
  title?: string | null;
  name?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

export interface ProjectArtifactPage {
  rows: ArtifactRow[];
  /** The route reported more rows than this page holds. */
  truncated: boolean;
  /** `X-Project-Resolved: false` — fr does not know this project. */
  projectUnknown: boolean;
}

export type ProjectArtifactResult = { ok: true; data: ProjectArtifactPage } | CatalogueFailure;

export function projectArtifactUrl(kind: ProjectArtifactKind, projectId: string, limit = PROJECT_ARTIFACT_PAGE): string {
  const sp = new URLSearchParams({ [PROJECT_ARTIFACT_PARAM[kind]]: projectId, limit: String(limit) });
  return `${PROJECT_ARTIFACT_PATHS[kind]}?${sp.toString()}`;
}

export async function listProjectArtifacts(kind: ProjectArtifactKind, projectId: string): Promise<ProjectArtifactResult> {
  let r: Response;
  try {
    r = await authFetch(projectArtifactUrl(kind, projectId));
  } catch (e) {
    return unreachable(e);
  }
  if (!r.ok) return failureOf(r);
  try {
    const json = (await r.json()) as { data: ArtifactRow[] };
    return {
      ok: true,
      data: {
        rows: Array.isArray(json.data) ? json.data : [],
        truncated: r.headers.get('X-Truncated') === 'true',
        projectUnknown: r.headers.get('X-Project-Resolved') === 'false',
      },
    };
  } catch (e) {
    return unreachable(e);
  }
}

/** A row's display label: title, else name, else its id. */
export function artifactLabel(row: ArtifactRow): string {
  const t = typeof row.title === 'string' && row.title.trim() ? row.title : null;
  const n = typeof row.name === 'string' && row.name.trim() ? row.name : null;
  return t ?? n ?? row.id;
}

function shortId(v: unknown): string {
  const s = String(v ?? '?');
  return s.length > 8 ? s.slice(0, 8) : s;
}

/** A relationship row: `source → type → target` (entity type + short id), led by its name when it has one. */
export function relationshipLabel(row: ArtifactRow): string {
  const src = `${String(row.source_entity_type ?? 'entity')} ${shortId(row.source_id)}`;
  const tgt = `${String(row.target_entity_type ?? 'entity')} ${shortId(row.target_id)}`;
  const edge = `${src} → ${String(row.relationship_type ?? 'relates to')} → ${tgt}`;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name : null;
  return name ? `${name}: ${edge}` : edge;
}
