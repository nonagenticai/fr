/**
 * fr-agui SPEC §6.0 (OQ-15 = a) — the DOORWAY agent's tool set.
 *
 * On the tenant-level doorway pages (`/projects/new`, `/projects/intake`,
 * `/projects/requests[/id]`) the agent runs in REQUEST-INTAKE mode: it may list
 * types, create a project (a confirm card) and run the request lifecycle —
 * nothing else. No project, tenant or admin tool is ever offered there.
 *
 * This is the DECLARED set; the catalog is its intersection with what is
 * registered. Since P1b (SPEC §13) the registered members are `projects.create`,
 * `projects.list` / `projects.get`, the two `conveyor.*` reads and the ten
 * agent-exposed `project_requests.*` capabilities. The members in
 * DOORWAY_NOT_YET_REGISTERED (`ui.*`, `github_app.install_url`) are declared but
 * arrive in a later unit; nothing outside this list can ever join.
 *
 * ⛔ `project_requests.create` is NOT a member: `POST /api/project-requests` is the
 * Common Practice bridge intake (service account + `project-request-writer`),
 * declared `service-to-service`. A person's request starts at
 * `project_requests.draft_from_text`.
 *
 * ⭐ P1c: the set IS the `request-intake` capability pack
 * (agent/packs/request-intake/capabilities.json, SPEC §11.3) — one source.
 *
 * Asserted EXACTLY (catalog == declared − not-yet-registered, for the booted
 * registry) by tests/unit/agent/intake-catalog.test.ts.
 */
import { packMembers } from './packs';

export const DOORWAY_INTAKE_ACTIONS: ReadonlySet<string> = packMembers('request-intake');

/**
 * Which catalog a chat turn gets. P1c (OQ-17 = c): decided by the SERVER from
 * the thread, never by the client — a project-bound thread gets `project` (the
 * project agent), an unbound one `intake` (the doorway). `default` survives only
 * as the value an old client may still send; it is mapped to the thread's mode
 * (routes/agent.ts), so it can no longer widen to the retired tenant rail.
 */
export type AgentCatalogMode = 'default' | 'intake' | 'project';

/**
 * Declared doorway members that no unit has registered yet. An exact set that
 * may only shrink: a member that becomes registered must be deleted here (the
 * intake-catalog test fails until it is).
 */
export const DOORWAY_NOT_YET_REGISTERED: ReadonlySet<string> = new Set([
  'github_app.install_url',
]);
