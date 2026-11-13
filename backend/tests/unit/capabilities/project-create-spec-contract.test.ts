// tests/unit/capabilities/project-create-spec-contract.test.ts
//
// THE SERVED SPEC vs THE CREATE DOOR.
//
// The published OpenAPI document is what every `@nonagentic/n8n-nodes-*` client is
// generated from. `POST /api/projects` used to be described as `{ name,
// repository_url, branch }` while the door REQUIRES a project type (422
// project_type_required) and accepts the whole intake/brief — so the generated fr
// node could not create a typed project at all.
//
// This is a spec-vs-ROUTE contract test, not a mock of the route:
//   * the published component is compared with `ProjectCreateSchema`, the schema
//     `createProjectCore` parses (both directions — an omitted field and an
//     invented one are both failures);
//   * every `BRIEF_KEYS` entry — the brief the create engine always sends to
//     requirements_management — must be published;
//   * the requiredness the spec claims is DRIVEN through the real create engine:
//     a body without `project_type` must answer 422 project_type_required, with
//     no stubbed/mocked route in between.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openapiSpec } from '../../../src/capabilities/served-spec';
import { createProjectCore } from '../../../src/routes/projects';
import { BRIEF_KEYS } from '../../../src/services/catalogue/project-intake';
import { ProjectCreateSchema, type User } from '../../../src/types/api';

/** Just enough shape to read a component schema; deliberately loose. */
interface SchemaObject {
  required?: string[];
  properties?: Record<string, unknown>;
}

const schemas =
  (openapiSpec as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {};
const projectCreate = (schemas.ProjectCreate ?? {}) as SchemaObject;

/**
 * A CUSTOMER tenant — deliberately NOT one of the four canonical non-execution
 * tenants, so `assertProjectTypeTenant` cannot be the gate that refuses the
 * untyped create; the refusal under test is the catalogue's.
 */
const CUSTOMER_TENANT = '11111111-1111-4111-8111-111111111111';

const user: User = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'spec-contract@example.test',
  name: 'Spec Contract',
  roles: [],
  tenantId: CUSTOMER_TENANT,
};

/** The three env values `conveyorConfigured()` reads; set so the create door's
 * first gate passes and the project-type gate is the one that answers. */
const CONVEYOR_ENV = {
  REQUIREMENTS_SERVICE_TOKEN: 'test-requirements-service-token',
  CONVEYOR_START_WEBHOOK_URL: 'http://conveyor.test/webhook',
  CONVEYOR_START_WEBHOOK_SECRET: 'test-conveyor-start-secret',
} as const;

describe('served ProjectCreate matches the create door', () => {
  test('CONTROL: the component is published and non-trivial', () => {
    expect(Object.keys(projectCreate.properties ?? {}).length).toBeGreaterThan(10);
  });

  test('project_type is REQUIRED (the door 422s without it) and name is REQUIRED', () => {
    expect(projectCreate.required).toContain('project_type');
    expect(projectCreate.required).toContain('name');
  });

  test('the required list is exactly what the door requires — name and project_type', () => {
    // `name` is zod-required; `project_type` is required by the catalogue gate
    // proven live in the describe block below. Every other field has a default or
    // is genuinely optional.
    expect([...(projectCreate.required ?? [])].sort()).toEqual(['name', 'project_type']);
  });

  test('every field the route parses is published, and nothing else is', () => {
    const routeFields = Object.keys(ProjectCreateSchema.shape).sort();
    const specFields = Object.keys(projectCreate.properties ?? {}).sort();
    // One assertion, both directions: an omitted field and an invented field are
    // both drift between the generated client and the door.
    expect(specFields).toEqual(routeFields);
  });

  test('every brief key the create engine forwards to RM is published', () => {
    const published = new Set(Object.keys(projectCreate.properties ?? {}));
    const missing = BRIEF_KEYS.filter((k) => !published.has(k));
    expect(missing).toEqual([]);
  });

  test('the create response publishes the Planka board the door returns', () => {
    const response = (schemas.ProjectCreateResponse ?? {}) as {
      allOf?: Array<{ required?: string[] }>;
    };
    const required = (response.allOf ?? []).flatMap((branch) => branch.required ?? []);
    expect(required).toContain('planka');
  });
});

describe('the door really refuses an untyped create (live engine, no mock)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [key, value] of Object.entries(CONVEYOR_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('a create body with no project_type → 422 project_type_required', async () => {
    const out = await createProjectCore({ body: { name: 'untyped attempt' }, user });
    expect(out.status).toBe(422);
    expect(out.body.error).toBe('project_type_required');
  });
});
