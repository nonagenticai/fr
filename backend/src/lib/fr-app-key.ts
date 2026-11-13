// src/lib/fr-app-key.ts
//
// The ONE literal for the app_key fr's licence gate requires (`require-fr-license.ts`, which
// re-exports it). Its own side-effect-free module so request schemas and the signup config can
// name it without importing the gate's Redis / licences-client graph.
//
// Every path that licenses a tenant FOR fr must include this key. 2026-10-20: the early-access
// signup approve licensed `fr-frontend` (+ the conveyor bundle) and never `fr`, so the gate refused
// the workspace it had just founded ("No active license for this workspace").

export const FR_APP_KEY = 'fr';
