// src/services/catalogue/tenant-catalogue.ts
//
// THE ONE READER of a tenant's PM vocabulary (design: fr consumes RM vocabulary,
// George 2026-10-12). Every fr consumer that needs a project type, a phase, a
// gate, a card type, a WIP limit, a priority level or a board template
// asks HERE, and this module asks requirements_management through the single
// seam `integrations/pm-catalogue.ts`.
//
// ⛔ RM-ONLY, NO FALLBACK. There is no local constant behind any getter. A tenant
// whose catalogue has no phases or no project types is NOT INITIALISED and every
// getter that needs them throws `CatalogueNotInitialised` (409
// `catalogue_not_initialised`). The only remedy is RM's import-defaults, which a
// super-admin runs (POST /api/admin/tenants/:tenantId/catalogue/import-defaults,
// and automatically at tenant provisioning). fr never seeds.
//
// ⛔ THE TENANT IS ALWAYS EXPLICIT. Every getter takes the tenant it reads for.
// A request handler passes the tenant it authorised against; a background path
// (the plan phase-exit sweep, approval re-delivery, …) passes the tenant of the
// PROJECT ROW it is acting on (`projectCatalogueTenant`), never an ambient one.
//
// CACHE. Per tenant, per resource, TTL 60 s. A write through fr's own catalogue
// routes (routes/conveyor-catalogue.ts, the super-admin import-defaults route)
// drops that tenant's entries (`invalidateTenantCatalogue`), so an fr-side edit
// is visible on the next read. A failed read is never cached.

import { z } from 'zod';

import {
  getProjectTypeCardTypes,
  listPmCatalogue,
  resolvePmWipLimit,
  type PmCatalogueResource,
} from '../../integrations/pm-catalogue';
import { AppError } from '../../utils/errors';

// ── errors ──────────────────────────────────────────────────────────────────

export const CATALOGUE_NOT_INITIALISED = 'catalogue_not_initialised';

/**
 * The tenant has no PM catalogue (0 phases or 0 project types in RM). 409:
 * the request is well-formed, the tenant's state does not allow it yet. The
 * body carries `code: catalogue_not_initialised` and `details.tenant_id`, which
 * the frontend reads to offer a super-admin the import-defaults action.
 */
export class CatalogueNotInitialised extends AppError {
  constructor(
    public readonly tenantId: string,
    public readonly missing: readonly string[],
  ) {
    super(
      409,
      `the PM catalogue of tenant ${tenantId} is not initialised (no ${missing.join(' / ')} in ` +
        'requirements_management); a super-admin must import the catalogue defaults for this tenant',
      { tenant_id: tenantId, missing: [...missing] },
    );
    this.name = 'CatalogueNotInitialised';
    this.code = CATALOGUE_NOT_INITIALISED;
  }
}

export const PROJECT_TENANT_UNKNOWN = 'project_tenant_unknown';

/**
 * The tenant whose catalogue governs a project: its own tenant tag
 * (`project_data.keycloak_tenant_id`, the authoritative tag — lib/project-access.ts
 * PROJECT_KC_TENANT). ⛔ Fail closed: a project with no tag has no catalogue,
 * and guessing the acting tenant would read another tenant's vocabulary.
 */
export function projectCatalogueTenant(project: { id?: string; project_data?: unknown }): string {
  const tag = (project.project_data as { keycloak_tenant_id?: unknown } | null | undefined)
    ?.keycloak_tenant_id;
  if (typeof tag === 'string' && tag.trim() !== '') return tag.trim();
  throw new AppError(
    409,
    `project ${project.id ?? '(unknown)'} has no tenant tag (project_data.keycloak_tenant_id), ` +
      'so its PM catalogue cannot be resolved',
  ).withCode(PROJECT_TENANT_UNKNOWN);
}

// ── shapes (validated: RM's body is `unknown` until proven) ─────────────────

const PhaseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    title: z.string(),
    has_gate: z.boolean().optional().default(false),
    description: z.string().nullable().optional(),
  })
  .passthrough();
type CataloguePhase = z.infer<typeof PhaseSchema>;

const TypePhaseSchema = z
  .object({
    phase_id: z.string(),
    name: z.string(),
    title: z.string(),
    position: z.number().int(),
    has_gate: z.boolean().optional().default(false),
  })
  .passthrough();
type CatalogueTypePhase = z.infer<typeof TypePhaseSchema>;

const ProjectTypeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    /**
     * RM's retirement stamp. A retired type still EXISTS in the catalogue (so its
     * name still resolves and its phase labels still read), but nothing may
     * START a project of it. `null` = live. The `.default(null)` matters: every
     * read goes through this schema, so a caller may rely on the key being
     * present without a second null check.
     */
    retired_at: z.string().nullable().optional().default(null),
    phases: z.array(TypePhaseSchema).optional().default([]),
  })
  .passthrough();
export type CatalogueProjectType = z.infer<typeof ProjectTypeSchema>;

const GateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    title: z.string(),
    phase_id: z.string(),
    approver_role: z.string().optional(),
    quorum: z.number().int().optional(),
    expires_after_hours: z.number().int().positive().nullable().optional(),
  })
  .passthrough();
type CatalogueGate = z.infer<typeof GateSchema>;

const CapabilitySchema = z
  .object({ id: z.string(), name: z.string(), title: z.string(), description: z.string().nullable().optional() })
  .passthrough();
type CatalogueCapability = z.infer<typeof CapabilitySchema>;

const CardTypeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    title: z.string(),
    capability_id: z.string(),
    description: z.string().nullable().optional(),
    // RM: NULL = "not set" (import-defaults fills it); fr reads it as no entries.
    inputs: z.array(z.string()).nullable().optional(),
    outputs: z.array(z.string()).nullable().optional(),
    acceptance: z.array(z.string()).nullable().optional(),
    rules: z.array(z.string()).nullable().optional(),
    human_task: z.boolean().nullable().optional(),
    definition_of_done: z.unknown().optional(),
  })
  .passthrough();
type CatalogueCardType = z.infer<typeof CardTypeSchema>;

const PrioritySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    title: z.string(),
    rank: z.number().int(),
    is_default: z.boolean().optional().default(false),
    conveyor_may_set: z.boolean().optional().default(true),
    description: z.string().nullable().optional(),
  })
  .passthrough();
export type CataloguePriority = z.infer<typeof PrioritySchema>;

const BoardListSpecSchema = z
  .object({ name: z.string(), position: z.number().int(), closed: z.boolean().optional().default(false) })
  .passthrough();
const BoardLabelSpecSchema = z.object({ name: z.string(), color: z.string().nullable().optional() }).passthrough();
const CustomFieldGroupSpecSchema = z
  .object({ name: z.string(), fields: z.array(z.string()).optional().default([]) })
  .passthrough();
const BoardTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    project_type_id: z.string().nullable().optional(),
    // RM: NULL = not set. fr reads a not-set list as "the template defines none".
    lists: z.array(BoardListSpecSchema).nullable().optional(),
    labels: z.array(BoardLabelSpecSchema).nullable().optional(),
    custom_field_groups: z.array(CustomFieldGroupSpecSchema).nullable().optional(),
  })
  .passthrough();
export type CatalogueBoardTemplate = z.infer<typeof BoardTemplateSchema>;

const CompositionSchema = z
  .object({ project_type_id: z.string(), name: z.string(), phases: z.array(z.unknown()).optional() })
  .passthrough();
type CatalogueComposition = z.infer<typeof CompositionSchema>;

const WipResolveSchema = z.object({ id: z.string(), wip_limit: z.number().int() }).passthrough();
type CatalogueWipLimit = z.infer<typeof WipResolveSchema>;

// ── cache ───────────────────────────────────────────────────────────────────

const TENANT_CATALOGUE_TTL_MS = 60_000;

const cache = new Map<string, Map<string, { expiresAt: number; value: Promise<unknown> }>>();

function cached<T>(tenantId: string, key: string, load: () => Promise<T>): Promise<T> {
  let perTenant = cache.get(tenantId);
  if (!perTenant) {
    perTenant = new Map();
    cache.set(tenantId, perTenant);
  }
  const hit = perTenant.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as Promise<T>;
  const value = load();
  const entry = { expiresAt: Date.now() + TENANT_CATALOGUE_TTL_MS, value: value as Promise<unknown> };
  perTenant.set(key, entry);
  // A failed read is never cached: drop it (only if it is still this entry).
  value.catch(() => {
    if (cache.get(tenantId)?.get(key) === entry) cache.get(tenantId)?.delete(key);
  });
  return value;
}

/** Drop every cached entry of `tenantId` (called by fr's catalogue write routes). */
export function invalidateTenantCatalogue(tenantId: string): void {
  cache.delete(tenantId);
}

// ── reads ───────────────────────────────────────────────────────────────────

const PAGE = 1000; // RM's list maximum

async function listAll<S extends z.ZodTypeAny>(
  tenantId: string,
  resource: PmCatalogueResource,
  schema: S,
): Promise<Array<z.infer<S>>> {
  const out: Array<z.infer<S>> = [];
  for (let offset = 0; ; offset += PAGE) {
    const raw = await listPmCatalogue(
      tenantId,
      resource,
      new URLSearchParams({ limit: String(PAGE), offset: String(offset) }),
    );
    const page = z.array(schema).parse(raw);
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

/** Every phase of the tenant. Throws CatalogueNotInitialised when there are none. */
export async function phases(tenantId: string): Promise<CataloguePhase[]> {
  const rows = await cached(tenantId, 'project-phases', () => listAll(tenantId, 'project-phases', PhaseSchema));
  if (rows.length === 0) throw new CatalogueNotInitialised(tenantId, ['project-phases']);
  return rows;
}

/** Every project type of the tenant. Throws CatalogueNotInitialised when there are none. */
export async function projectTypes(tenantId: string): Promise<CatalogueProjectType[]> {
  const rows = await cached(tenantId, 'project-types', () => listAll(tenantId, 'project-types', ProjectTypeSchema));
  if (rows.length === 0) throw new CatalogueNotInitialised(tenantId, ['project-types']);
  return rows;
}

/** The tenant's project type named `name`, or null when it has none by that name. */
export async function projectType(tenantId: string, name: string): Promise<CatalogueProjectType | null> {
  return (await projectTypes(tenantId)).find((t) => t.name === name) ?? null;
}

/**
 * The ordered phases of the tenant's project type `typeName` (RM `position`
 * order), or null when the tenant has no such type.
 */
export async function typePhases(tenantId: string, typeName: string): Promise<CatalogueTypePhase[] | null> {
  const t = await projectType(tenantId, typeName);
  if (!t) return null;
  return [...t.phases].sort((a, b) => a.position - b.position);
}

/**
 * The phase requirements_management creates every project in (v4 D16): a
 * project of a type whose ordered phases do not START with it cannot be
 * created (RM: 409 project_type_missing_setup_phase).
 */
export const SETUP_PHASE = 'setup';

/**
 * A project type fr may START a project of: RM has not retired it (v4:
 * `retired_at` null) AND its ordered phase list starts with `setup`.
 *
 * ⚠️ `retired_at` is taken as OPTIONAL in the parameter type because callers
 * that construct a type shape by hand (tests, migrations) have no retirement
 * stamp to give; a real catalogue row always carries the schema's `null`.
 */
export function isStartableProjectType(
  t: Pick<CatalogueProjectType, 'phases'> & Partial<Pick<CatalogueProjectType, 'retired_at'>>,
): boolean {
  if (t.retired_at) return false;
  const first = [...t.phases].sort((a, b) => a.position - b.position)[0];
  return first?.name === SETUP_PHASE;
}

/** The tenant's startable project types (phase list starts with `setup`), in RM order. */
export async function startableProjectTypes(tenantId: string): Promise<CatalogueProjectType[]> {
  return (await projectTypes(tenantId)).filter(isStartableProjectType);
}

export async function gates(tenantId: string): Promise<CatalogueGate[]> {
  return await cached(tenantId, 'gates', () => listAll(tenantId, 'gates', GateSchema));
}

/** The gate guarding the exit of phase `phaseId`, or null. */
export async function gateForPhase(tenantId: string, phaseId: string): Promise<CatalogueGate | null> {
  return (await gates(tenantId)).find((g) => g.phase_id === phaseId) ?? null;
}

/** Every card type of the tenant. Throws CatalogueNotInitialised when there are none. */
export async function cardTypes(tenantId: string): Promise<CatalogueCardType[]> {
  const rows = await cached(tenantId, 'card-types', () => listAll(tenantId, 'card-types', CardTypeSchema));
  if (rows.length === 0) throw new CatalogueNotInitialised(tenantId, ['card-types']);
  return rows;
}

/** Every capability of the tenant (RM order) — the card-group vocabulary (design Q1 = a). Throws CatalogueNotInitialised when there are none. */
export async function capabilities(tenantId: string): Promise<CatalogueCapability[]> {
  const rows = await cached(tenantId, 'capabilities', () => listAll(tenantId, 'capabilities', CapabilitySchema));
  if (rows.length === 0) throw new CatalogueNotInitialised(tenantId, ['capabilities']);
  return rows;
}

/** The tenant's card type named `name`, or null when it has none by that name. */
export async function cardType(tenantId: string, name: string): Promise<CatalogueCardType | null> {
  return (await cardTypes(tenantId)).find((c) => c.name === name) ?? null;
}

/**
 * The capability NAME of the tenant's card type `name` — what fr used to call the
 * card's `card_group` (design Q1 = a). Null when the tenant has no such card type
 * (or the type's capability is not among the tenant's capabilities).
 */
export async function cardTypeCapability(tenantId: string, name: string): Promise<string | null> {
  const ct = await cardType(tenantId, name);
  if (!ct) return null;
  return (await capabilities(tenantId)).find((c) => c.id === ct.capability_id)?.name ?? null;
}

/** card type name → capability name, for every card type of the tenant. */
export async function cardTypeCapabilityMap(tenantId: string): Promise<Map<string, string>> {
  const [types, caps] = await Promise.all([cardTypes(tenantId), capabilities(tenantId)]);
  const capName = new Map(caps.map((c) => [c.id, c.name]));
  const out = new Map<string, string>();
  for (const t of types) {
    const n = capName.get(t.capability_id);
    if (n) out.set(t.name, n);
  }
  return out;
}

/**
 * Does the tenant's card type `name` carry the RM rule string `rule` in its
 * `rules[]`? (Design: the reclassify-refused list, the dependency_upgrade
 * subtype and ncn's coding set are card-type rules in RM, read by name.) An
 * unknown card type or a not-set (NULL) rules list carries no rule.
 */
export async function cardTypeHasRule(tenantId: string, name: string, rule: string): Promise<boolean> {
  return (await cardType(tenantId, name))?.rules?.includes(rule) ?? false;
}

/** The names of the tenant's card types whose `rules[]` holds any of `rules`. */
export async function cardTypesWithRule(tenantId: string, rules: readonly string[]): Promise<string[]> {
  return (await cardTypes(tenantId))
    .filter((c) => (c.rules ?? []).some((r) => rules.includes(r)))
    .map((c) => c.name);
}

/** The project type's card-type matrix (RM `GET /pm/project-types/{id}/card-types`), or null for an unknown type. */
export async function composition(tenantId: string, typeName: string): Promise<CatalogueComposition | null> {
  const t = await projectType(tenantId, typeName);
  if (!t) return null;
  return await cached(tenantId, `composition:${t.id}`, async () =>
    CompositionSchema.parse(await getProjectTypeCardTypes(tenantId, t.id)),
  );
}

/** Priority levels, ordered by rank. Throws CatalogueNotInitialised when there are none. */
export async function priorities(tenantId: string): Promise<CataloguePriority[]> {
  const rows = await cached(tenantId, 'priority-levels', () =>
    listAll(tenantId, 'priority-levels', PrioritySchema),
  );
  if (rows.length === 0) throw new CatalogueNotInitialised(tenantId, ['priority-levels']);
  return [...rows].sort((a, b) => a.rank - b.rank);
}

/**
 * The board template of project type `typeName`: the one bound to that type,
 * else the tenant's unbound `default` template (design: "falling back to the
 * tenant's default template" — an RM row, not an fr constant). Null when neither exists.
 */
export async function boardTemplate(tenantId: string, typeName: string): Promise<CatalogueBoardTemplate | null> {
  const t = await projectType(tenantId, typeName);
  const all = await cached(tenantId, 'board-templates', () =>
    listAll(tenantId, 'board-templates', BoardTemplateSchema),
  );
  return (
    (t ? all.find((b) => b.project_type_id === t.id) : undefined) ??
    all.find((b) => (b.project_type_id ?? null) === null && b.name === 'default') ??
    null
  );
}

/** RM's most specific WIP limit for the given dimensions (ids). Not cached: a claim-time read. */
export async function wip(
  tenantId: string,
  scope: { project_type_id?: string; phase_id?: string; capability_id?: string; card_type_id?: string },
): Promise<CatalogueWipLimit> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(scope)) if (v) params.set(k, v);
  return WipResolveSchema.parse(await resolvePmWipLimit(tenantId, params));
}

// ── a PROJECT's phases ──────────────────────────────────────────────────────

export const PROJECT_TYPE_MISSING = 'project_type_missing';
export const PROJECT_TYPE_NOT_IN_CATALOGUE = 'project_type_not_in_catalogue';

// A PROJECT's phases (and its type + current phase) are read from RM's
// pm_project: services/catalogue/project-state.ts `phasesOfProject`.

/** name → RM title for every phase of the tenant (labels for plan rails). */
export async function phaseTitles(tenantId: string): Promise<Map<string, string>> {
  return new Map((await phases(tenantId)).map((p) => [p.name, p.title]));
}
