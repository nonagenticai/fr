/**
 * The ONE place that decides which modules contribute actions to the AG-UI
 * registry (fr#1383).
 *
 * Before this file the registry was assembled in three disjoint ways inside
 * `server.ts`: nine side-effect `import './agui/actions/x'` lines, a block of
 * `await import(...)` + `register*Actions()` calls, and — invisibly — the
 * import-time `registerAction` calls inside `routes/tools/{kag,coding,
 * analytics,kanban}.ts` and `routes/assets/artifacts.ts`, which only ran
 * because those route modules happened to be imported for their HTTP handlers.
 * A test that wanted "the production catalogue" had to re-derive that set and
 * got it wrong (117 of 149). Production and the keep-out test now both call
 * `registerAllActions()`, so a test cannot see a different registry than the
 * server builds.
 *
 * ⭐ P1c (OQ-17 = c): the tenant rail is retired, yet EVERY module stays here.
 * A retired action is stamped `catalog:'none'` at registration
 * (agui/agent-surface.ts) and drops out of every agent catalog, but it stays
 * registered because a REST route (the tools routes' `safeRegister`,
 * `/api/tools/*`, `assets/artifacts`) or the deterministic channel grammar
 * (`status` → status.summary, `help` → help.list_commands, `comment` /
 * `card` → kanban.*) still invokes it as a HUMAN. No route is removed.
 *
 * Adding an action module = adding ONE loader below. A module that calls
 * `registerAction(` but is not listed here is caught by the completeness guard
 * in `tests/unit/agent/tool-catalog-schema.test.ts`.
 *
 * ⚠️ The loaders are LITERAL `import('./…')` calls on purpose:
 * `tests/unit/server-no-boot-seeding.test.ts` walks literal dynamic imports to
 * build `server.ts`'s boot closure. A computed specifier would silently drop
 * these modules out of that guard's scan.
 */

import { listActions } from './registry';

type ActionModule = Record<string, unknown>;

export const ACTION_MODULE_LOADERS: ReadonlyArray<() => Promise<ActionModule>> = [
  // Import-time registration: each module registers itself when first loaded and
  // also exports an idempotent `register<X>Actions()` that the loop below calls.
  () => import('./actions/agent-search'),
  () => import('./actions/agent-asset'),
  () => import('./actions/channels'),
  () => import('./actions/status'),
  () => import('./actions/kanban-comment'),
  () => import('./actions/kanban-card'),
  // Route modules whose action records register at import time, next to the
  // HTTP handlers that share their domain helpers.
  () => import('../routes/tools/kag'),
  () => import('../routes/tools/coding'),
  () => import('../routes/tools/analytics'),
  () => import('../routes/tools/kanban'),
  () => import('../routes/assets/artifacts'),
  // Explicit registrars (`register<X>Actions()`), registered unconditionally —
  // see the per-module headers. Bridge: unconditional even while
  // FR_FEATURE_BRIDGE is off, because the agent + GET /api/agui/actions must
  // discover bridge.* and invocation still goes through the approval pipeline.
  () => import('./actions/bridge'),
  () => import('./actions/n8n'),
  // E-14 read-side coverage for the integration modules.
  () => import('./actions/requirements'),
  () => import('./actions/principles'),
  () => import('./actions/decisions'),
  () => import('./actions/workers'),
  () => import('./actions/secrets'),
  () => import('./actions/toc'),
  () => import('./actions/architecture'),
  // The ArchiMate modeling lifecycle (models, versions, validation, review, exchange).
  () => import('./actions/architecture-modeling'),
  // UML (profile uml-2.5.1-p1) and trace links.
  () => import('./actions/architecture-uml'),
  // ArchiMate model contents: elements, relationships, views, their shapes and lines, the metamodel.
  () => import('./actions/architecture-archimate'),
  () => import('./actions/pm'),
  () => import('./actions/research'),
  () => import('./actions/media'),
  () => import('./actions/quality-history'),
  () => import('./actions/pm_catalogue'),
  () => import('./actions/projects-create'),
  () => import('./actions/projects-read'),
  // The conveyor's close step — `projects.close` (FR-CLOSE-CONTRACT.md).
  () => import('./actions/project-lifecycle'),
  () => import('./actions/project-requests'),
  () => import('./actions/approvals-decide'),
  // fr-agui P1c — the project agent's navigation intents and its meta-tool.
  () => import('./actions/ui-navigate'),
  () => import('./actions/project-core'),
  () => import('./actions/capabilities-search'),
  () => import('./actions/project-assets'),
  () => import('./actions/project-asset-edit'),
  // fr-agui P3 — execution observability (capabilities/projects/execution.ts).
  () => import('./actions/project-execution'),
  // fr-agui P2-c1 — asset scope (bind / unbind / override / block), knowledge allocation, quality.
  () => import('./actions/project-scope-people-quality'),
  // fr-agui P2-c2 — artifact review, project provision / archive.
  () => import('./actions/project-outputs'),
];

/** Exported production registrars: `registerBridgeActions`, `registerN8nActions`, … */
const REGISTRAR_RE = /^register\w*Actions$/;

/**
 * Load every action module and call its exported `register<X>Actions()`
 * registrar(s). Production calls this exactly once at boot; the registrars are
 * idempotent, so a second call is a no-op. Returns the loaded modules.
 */
export async function registerAllActions(): Promise<{ modules: ActionModule[]; count: number }> {
  const modules: ActionModule[] = [];
  for (const load of ACTION_MODULE_LOADERS) {
    const mod = await load();
    modules.push(mod);
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn === 'function' && REGISTRAR_RE.test(name)) (fn as () => void)();
    }
  }
  return { modules, count: listActions().length };
}
