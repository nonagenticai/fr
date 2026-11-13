// tests/unit/routes/approval-status-enum-drift.test.ts
//
// THE GATE THAT DID NOT EXIST.
//
// `approvals.status` is `text NOT NULL DEFAULT 'pending'` with NO CHECK and no
// enum type (db/schema.ts; migration 110 confirms the absence by grep through
// 109). So a new status becomes legal the instant application code writes it —
// silently, with no schema change for anyone to review. The only thing coupling
// the places that must know about it is a comment.
//
// That coupling has failed THREE TIMES, each time the same way:
//
//   #779           `expired` added  → the /approvals tab list not extended;
//                                     expired rows matched no tab and vanished.
//   migration 110  `voided` added   → APPROVAL_STATUS_FILTERS not extended, so
//                                     `?status=voided` answered 400 for 892 real
//                                     rows; the tab list missed it too.
//   fr#1149        (this lane)      → the PUBLISHED OpenAPI enum was still the
//                                     original 3 of 8, and the frontend
//                                     `ApprovalStatus` union was 5 of 8.
//
// Every one of those was found by a person reading code or walking the live UI.
// Nothing in CI could see any of them. This test is that missing coupling.
//
// ⚠️ SCOPE, deliberately: this pins the set of statuses a row can HOLD and that
// the API therefore reports. It must NOT be extended to the deliberately
// narrower contracts, which are not drift:
//   - PUT /api/approvals/{id} request body = approved | rejected. Those are
//     DECISIONS a caller may submit; expired/voided/executing/done/failed are
//     states the system REACHES.
//   - ApprovalDecisionPayload['decision'] (services/n8n.ts) =
//     approved | rejected | expired | voided. A WIRE contract: each value must
//     have been taught to the receiver, and one that has not been taught must
//     fail loud rather than be silently widened.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVAL_STATUS_FILTERS } from '../../../src/routes/approvals';
import { openapiSpec } from '../../../src/capabilities/served-spec';

const FRONTEND_TYPES = join(
  import.meta.dir,
  '../../../../frontend/src/lib/types/api.ts',
);

/** Source of truth. Everything else in this file is compared against it. */
const truth: string[] = [...APPROVAL_STATUS_FILTERS].sort();

function specEnum(): string[] {
  const schemas = (openapiSpec as { components?: { schemas?: Record<string, unknown> } })
    .components?.schemas;
  const approval = schemas?.Approval as
    | { properties?: { status?: { enum?: string[] } } }
    | undefined;
  const found = approval?.properties?.status?.enum;
  // ⛔ A MISSING ENUM MUST FAIL, NOT PASS VACUOUSLY. If the schema is renamed or
  // restructured, `found` is undefined and a `?? []` here would compare [] to []
  // on the "extra" direction and quietly report a clean bill of health for a spec
  // that no longer documents the field at all.
  if (!Array.isArray(found)) {
    throw new Error(
      'openapiSpec.components.schemas.Approval.properties.status.enum is missing or not an array. ' +
        'If the Approval schema moved, update this test — do not delete it.',
    );
  }
  return found;
}

function frontendUnion(): string[] {
  const src = readFileSync(FRONTEND_TYPES, 'utf8');
  const decl = /export type ApprovalStatus\s*=\s*([^;]+);/.exec(src);
  const body = decl?.[1];
  // ⛔ SAME RULE AS ABOVE: a parse that finds nothing is a FAILURE. A regex that
  // silently stops matching (the type is renamed, moved, or reformatted beyond
  // this pattern) would otherwise turn this half of the gate into a no-op that
  // still reports green — the exact "detector that cannot fire" this repo keeps
  // finding.
  if (!body) {
    throw new Error(
      `Could not find 'export type ApprovalStatus = ...' in ${FRONTEND_TYPES}. ` +
        'If it moved or was renamed, update this test — do not delete it.',
    );
  }
  const members = [...body.matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === 'string');
  if (members.length === 0) {
    throw new Error(`Parsed ApprovalStatus but extracted no members from: ${body}`);
  }
  return members;
}

describe('approval status enum drift', () => {
  test('CONTROL: the parsers actually extract something', () => {
    // If either instrument silently returned nothing, every assertion below
    // would compare two empty sets and pass. Prove they read real values first.
    expect(truth.length).toBeGreaterThanOrEqual(5);
    expect(specEnum().length).toBeGreaterThanOrEqual(5);
    expect(frontendUnion().length).toBeGreaterThanOrEqual(5);
  });

  test('the published OpenAPI Approval.status enum equals APPROVAL_STATUS_FILTERS', () => {
    const spec = [...specEnum()].sort();
    // Both directions, and reported separately so a failure says WHICH way it
    // drifted: a value the spec omits breaks every consumer validating a real
    // response, while a value only the spec has documents a state that cannot
    // occur.
    expect(truth.filter((s) => !spec.includes(s))).toEqual([]); // missing from spec
    expect(spec.filter((s) => !truth.includes(s))).toEqual([]); // extra in spec
    expect(spec).toEqual(truth);
  });

  test('the frontend ApprovalStatus union equals APPROVAL_STATUS_FILTERS', () => {
    const fe = [...frontendUnion()].sort();
    expect(truth.filter((s) => !fe.includes(s))).toEqual([]); // missing from frontend
    expect(fe.filter((s) => !truth.includes(s))).toEqual([]); // extra in frontend
    expect(fe).toEqual(truth);
  });

  test('the decision-input enums stay NARROWER on purpose', () => {
    // Guards the restraint, not just the widening: a future "fix the enums"
    // sweep must not widen the submit path to every state the system reaches.
    const spec = openapiSpec as unknown as {
      paths: Record<
        string,
        {
          put?: {
            requestBody?: {
              content?: Record<
                string,
                { schema?: { properties?: { status?: { enum?: string[] } } } }
              >;
            };
          };
        }
      >;
    };
    const put =
      spec.paths['/api/approvals/{approvalId}']?.put?.requestBody?.content?.[
        'application/json'
      ]?.schema?.properties?.status?.enum;
    // Same rule as the other extractors: absence is a FAILURE, not a pass.
    if (!Array.isArray(put)) {
      throw new Error(
        'PUT /api/approvals/{approvalId} request-body status enum is missing from the spec.',
      );
    }
    expect(put).toEqual(['approved', 'rejected']);
    expect(put.length).toBeLessThan(truth.length);
  });
});
