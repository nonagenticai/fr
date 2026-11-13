// Feature-flag knobs. Centralized here so route registration and AG-UI
// action registration share a single source of truth.
//
// FR_FEATURE_BRIDGE — gates the analysis-to-kanban bridge surface
//   (routes/tools/bridge.ts; AG-UI bridge.* action registration is
//   unconditional — see server.ts comment). On by default as of the
//   rollout cut-over: bridge has shipped (audit-fix wave registered all
//   bridge.* actions; target_list_id validation + structured frontend error
//   codes landed in PRs #11/#12). Set FR_FEATURE_BRIDGE=false in env to
//   disable the HTTP surface in an emergency rollback. The commit-callback
//   route mounts unconditionally so in-flight approvals always resolve. See
//   docs/superpowers/specs/completed/2026-04-24-analysis-to-kanban-bridge.md §Rollout plan.
export const FR_FEATURE_BRIDGE =
  (process.env.FR_FEATURE_BRIDGE ?? 'true').toLowerCase() === 'true';
