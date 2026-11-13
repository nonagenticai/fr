// src/routes/assets/_lib/index.ts
//
// Barrel re-export for the assets-routes shared library. Adding
// `applyEffectiveFilter` per Foundation Plan 2 §Task 7 — every list route
// imports it from `./_lib` so the import sites are stable if the helper
// is ever moved or split.

export { handle } from './handler';
export { applyEffectiveFilter } from './effective-query';
export type { EffectiveFilterDb } from './effective-query';
