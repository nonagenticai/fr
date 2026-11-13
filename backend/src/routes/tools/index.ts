/**
 * Tools route modules — boot-order side-effect imports.
 *
 * fr-agui P4d-2d: every `/api/tools/*` route is capability-derived (deriveRouter registers them;
 * the declarations bind these modules' handlers late):
 *   - n8n.*    — the execution reads (capabilities/platform/inbound.ts) and the workflow list
 *                (capabilities/operate/workflows.ts);
 *   - kanban.* — the liveness read (capabilities/kanban/board.ts);
 *   - kag.*    — ingestion (capabilities/kag/tools.ts);
 *   - coding.* — the analysis jobs (capabilities/platform/coding.ts);
 *   - analytics.* (capabilities/tools/analytics.ts).
 *
 * The router registration this file used to hold (`registerToolsRoutes`) is gone; what stays is the
 * module-load ORDER, because ./kanban, ./kag, ./coding and ./analytics register their AG-UI actions
 * at module load. src/server.ts imports this file at the same position as before, so the boot order
 * (and the registry's catalogue order) is byte-identical.
 */

// Kept at its position (it was the first import): the execution / workflow handlers' module.
import './n8n';
// Side-effect import, kept at this exact position: ./kanban registers the
// `kanban.verify_liveness` AG-UI action at module load. Its HTTP route is
// capability-derived (fr-agui P4d-2b, capabilities/kanban/board.ts).
import './kanban';
// Side-effect import, kept at this exact position: ./kag registers the `kag.*`
// AG-UI actions at module load. Its HTTP handlers are now bound late by the
// capability declarations (fr-agui P4a1), so without this line the module would
// first load inside registerAllActions() — same set, but a different
// registration (catalog) order. Keeps the boot order byte-identical.
import './kag';
// Side-effect import, kept at this exact position: ./coding registers the `coding.*`
// AG-UI actions at module load. Its six HTTP routes are capability-derived (fr-agui
// P4d-2d, capabilities/platform/coding.ts).
import './coding';
// Side-effect import, kept at this exact position: ./analytics registers the
// `analytics.*` AG-UI actions at module load. Its four HTTP routes are
// capability-derived (fr-agui P4b part 3, capabilities/tools/analytics.ts).
import './analytics';
