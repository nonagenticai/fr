// src/routes/kanban/index.ts
// Barrel for kanban route handlers — trimmed to the conveyor operations
// (George 2026-10-10). Every handler runs fr's tenant gate (./_gate.ts or
// lib/board-tenant-access) before any Planka call.
export * from './reads';
export * from './comments';
export * from './cards';
export * from './labels';
