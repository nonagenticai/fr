// src/routes/_lib/index.ts
//
// Barrel for the route-layer shared library. Route files import from
// `../_lib` so the import sites stay stable if a helper is ever split out.
export {
  readJsonBody,
  withIntegrationCatch,
  requireStringField,
  requireArrayField,
  parseSearchParams,
  readJsonValidated,
} from './request';
