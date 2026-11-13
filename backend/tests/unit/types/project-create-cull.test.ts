// tests/unit/types/project-create-cull.test.ts
//
// ProjectCreateSchema stopped accepting seven keys on 2026-09-23. This file is
// the regression guard for that cull, and it exists because migration 127's
// header ASSERTS the deletion — a header that outlives the deletion is a lie the
// next reader inherits.
//
// Five of the seven had zero readers: they reached projects.project_data through
// the rest destructure in routes/projects.ts and stopped there. Two —
// `effort_estimate` and `milestones` — are SUPERSEDED rather than dead:
// migration 127 moved them to projects.approved_effort_estimate and the
// project_milestones table, where the agent proposes and a human approves.
//
// ⚠️ WHY A SCHEMA TEST AND NOT A GREP: zod's default is to STRIP unknown keys,
// never to reject them. A caller that still sends `effort_estimate` gets a 200
// and silently loses the value. Nothing in the request path can notice that, so
// the only place the contract can be pinned is here.

import { describe, expect, test } from 'bun:test';
import {
  MilestoneSchema,
  OutlineDeliverableSchema,
  ProjectCreateSchema,
  ProjectOutlineSchema,
} from '../../../src/types/api';

/** The minimum ProjectCreateSchema requires; every case below spreads it. */
const base = {
  name: 'Payments hardening',
  repository_url: 'https://github.com/acme/widget',
};

// key -> a value of the shape the schema USED to accept. A restored key must
// survive the parse, or the mutation test proves nothing.
const CULLED: Record<string, unknown> = {
  env_placeholders: { A: '1' },
  data_classification: 'confidential',
  target_environment: 'production',
  resourcing: ['two engineers'],
  key_deliverables: ['a thing'],
  effort_estimate: 'about three weeks',
  milestones: [{ name: 'M1', target_date: '2026-11-01' }],
};

describe('ProjectCreateSchema — the seven culled keys are not accepted back in', () => {
  // The named case the brief calls for, spelled out rather than only generated,
  // so a rot in the table below cannot take this one with it.
  test('env_placeholders is stripped', () => {
    const parsed = ProjectCreateSchema.parse({
      ...base,
      env_placeholders: { A: '1' },
    }) as Record<string, unknown>;

    expect('env_placeholders' in parsed).toBe(false);
    expect(parsed.env_placeholders).toBeUndefined();
    // positive control: the parse itself worked and kept a LIVE key, so the
    // assertion above is measuring the cull and not a failed parse.
    expect(parsed.name).toBe('Payments hardening');
  });

  // Table-driven so the list cannot rot: restoring ANY ONE key fails here.
  test.each(Object.entries(CULLED))('%s is stripped', (key, value) => {
    const parsed = ProjectCreateSchema.parse({ ...base, [key]: value }) as Record<string, unknown>;
    expect(parsed[key]).toBeUndefined();
  });

  test('all seven at once leave no survivors', () => {
    const parsed = ProjectCreateSchema.parse({ ...base, ...CULLED }) as Record<string, unknown>;
    const survivors = Object.keys(CULLED).filter((k) => parsed[k] !== undefined);
    expect(survivors).toEqual([]);
  });

  test('the keys that DO have readers are untouched by the cull', () => {
    // A cull that took a live key with it would still pass every assertion
    // above. These five have named readers: renderConstraintsForBrief
    // (constraints/dependencies/risks), lib/execution-signoff.ts (fixture),
    // routes/projects.ts:625 (repo.additional).
    const parsed = ProjectCreateSchema.parse({
      ...base,
      constraints: ['legacy free text'],
      dependencies: [{ name: 'payments-api', kind: 'service' }],
      risks: [{ description: 'vendor delay' }],
      fixture: true,
      // ⚠️ `scope_level: 'multi_repo'` is REQUIRED here now, not decoration: two
      // repositories (primary + 1 additional) without it is refused by the
      // repo/scope coherence refine on ProjectCreateSchema. This case is about
      // the culled keys, so it must not fail for an unrelated reason.
      scope_level: 'multi_repo',
      repo: { primary: { url: 'https://github.com/acme/widget' }, additional: [{ url: 'https://github.com/acme/other' }] },
    }) as Record<string, unknown>;

    expect(parsed.constraints).toEqual(['legacy free text']);
    expect(parsed.dependencies).toEqual([{ name: 'payments-api', kind: 'service' }]);
    expect(parsed.risks).toEqual([{ description: 'vendor delay' }]);
    expect(parsed.fixture).toBe(true);
    expect((parsed.repo as { additional: unknown[] }).additional).toHaveLength(1);
    expect(parsed.shape).toBe('deliverable');
  });
});

describe('the cull did not take the outline sub-schemas with it', () => {
  // ProjectCreate.milestones going away does NOT mean MilestoneSchema goes away.
  // promoteProjectRequest (routes/project-requests.ts:705) re-validates the
  // approved outline's milestones jsonb through MilestoneSchema before writing
  // project_milestones, and :694 does the same for deliverables. Deleting either
  // export breaks the promote path, and nothing else in this repo would say so.
  test('MilestoneSchema is still exported and still parses a valid outline milestone', () => {
    expect(typeof MilestoneSchema?.parse).toBe('function');
    expect(MilestoneSchema.parse({ name: 'M1', target_date: '2026-11-01' })).toEqual({
      name: 'M1',
      target_date: '2026-11-01',
    });
    expect(MilestoneSchema.parse({ name: 'M2' })).toEqual({ name: 'M2' });
    expect(MilestoneSchema.safeParse({ target_date: '2026-11-01' }).success).toBe(false);
  });

  test('OutlineDeliverableSchema is still exported and still parses a valid outline deliverable', () => {
    expect(typeof OutlineDeliverableSchema?.parse).toBe('function');
    expect(
      OutlineDeliverableSchema.parse({ kind: 'artifact', title: 'A migration' }),
    ).toEqual({ kind: 'artifact', title: 'A migration', acceptance_criteria: [] });
    expect(OutlineDeliverableSchema.safeParse({ kind: 'artifact' }).success).toBe(false);
  });

  test('the outline still carries the milestones and effort ProjectCreate no longer does', () => {
    // This is where the two superseded keys LIVE now. If this stops passing, the
    // cull removed a capability rather than relocating one.
    const o = ProjectOutlineSchema.parse({
      deliverables: [{ kind: 'artifact', title: 'A migration' }],
      milestones: [{ name: 'Beta', target_date: '2026-12-01' }],
      effort_estimate: { value: 12, unit: 'days', note: 'two engineers' },
    });
    expect(o.milestones).toEqual([{ name: 'Beta', target_date: '2026-12-01' }]);
    expect(o.effort_estimate).toEqual({ value: 12, unit: 'days', note: 'two engineers' });
  });
});
