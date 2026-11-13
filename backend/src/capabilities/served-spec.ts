// src/capabilities/served-spec.ts
//
// fr-agui SPEC §13 P4d-2e — THE served OpenAPI document (`GET /openapi.json`): every operation is
// a capability's (registry.ts), in the committed order of `served-spec.lock.json`, inside the
// non-path document of spec-document.ts. There is no hand-written path anywhere.
//
// The lock is also the CI guard's baseline (scripts/check-served-spec.ts): one row per served
// operation with its sha256, plus the components and the rest of the document. Regenerate it
// with `bun run scripts/check-served-spec.ts --write` IN THE PR THAT CHANGES THE SPEC, and read
// the diff: every changed row is an operation n8n-nodes-fr / the frontend client may consume.
//
// ⛔ Side-effect free: the guards import this with no environment.
import { buildOpenApiSpec, SERVED_SPEC_EXTENSIONS } from './derive-openapi';
import { CAPABILITIES } from './registry';
import { SPEC_DOCUMENT } from './spec-document';
import lock from './served-spec.lock.json';

/** The lock's operation order (`METHOD /openapi/path`). */
export const SERVED_SPEC_ORDER: ReadonlyArray<string> = (lock as { operations: Array<{ op: string }> }).operations.map((o) => o.op);

/** The served document (`GET /openapi.json`). */
export const openapiSpec = buildOpenApiSpec(SPEC_DOCUMENT, CAPABILITIES, { extensions: SERVED_SPEC_EXTENSIONS }, SERVED_SPEC_ORDER);
