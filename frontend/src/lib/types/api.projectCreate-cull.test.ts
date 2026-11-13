// src/lib/types/api.projectCreate-cull.test.ts
//
// The FRONTEND half of the 2026-09-23 ProjectCreate cull. Its backend twin is
// backend/tests/unit/types/project-create-cull.test.ts, and the two must move
// together: a key deleted in one mirror and not the other is the two-emitter
// defect this repo keeps hitting, and it is invisible at runtime because zod
// STRIPS unknown keys instead of rejecting them — the frontend would keep
// sending a field the backend silently drops, and every test would stay green.
//
// ⚠️ THE REAL GATE FOR THIS FILE IS `npm run check` (svelte-check), NOT vitest.
// A TypeScript interface is erased before vitest ever sees it, so the assertions
// that matter below are type-level. Restoring any culled property to
// ProjectCreate turns each `Culled<'key'>` line into a TS2322 and each
// `@ts-expect-error` into an unused-directive TS2578. Both are hard errors.

import { describe, expect, it } from 'vitest';
import type { ProjectCreate, ProjectMilestone } from './api';

/** `true` only while K is absent from ProjectCreate. */
type Culled<K extends string> = K extends keyof ProjectCreate ? false : true;

// ── the seven culled keys ────────────────────────────────────────────────────
// Each line is an independent assertion; restoring ONE key reddens ONE line, so
// the failure names the key rather than the file.
const _envPlaceholders: Culled<'env_placeholders'> = true;
const _dataClassification: Culled<'data_classification'> = true;
const _targetEnvironment: Culled<'target_environment'> = true;
const _resourcing: Culled<'resourcing'> = true;
const _keyDeliverables: Culled<'key_deliverables'> = true;
const _effortEstimate: Culled<'effort_estimate'> = true;
const _milestones: Culled<'milestones'> = true;

// ── the same seven, in the @ts-expect-error form ─────────────────────────────
// Belt and braces: the directives above fail on assignability, these fail as
// UNUSED directives. The two mechanisms are independent, so a change to how
// `Culled` resolves cannot quietly disarm both.
// ⚠️ These are INDEXED ACCESS TYPES, not property reads. An earlier draft wrote
// them as `p.env_placeholders` against a `declare const p`, which type-checks
// identically but is erased to a read of `undefined` and throws at import time.
// A type-level assertion must have no runtime residue at all.
// @ts-expect-error env_placeholders was culled 2026-09-23 (zero readers)
type _EnvPlaceholders = ProjectCreate['env_placeholders'];
// @ts-expect-error data_classification was culled 2026-09-23 (zero readers)
type _DataClassification = ProjectCreate['data_classification'];
// @ts-expect-error target_environment was culled 2026-09-23 (zero readers)
type _TargetEnvironment = ProjectCreate['target_environment'];
// @ts-expect-error resourcing was culled 2026-09-23 (zero readers)
type _Resourcing = ProjectCreate['resourcing'];
// @ts-expect-error key_deliverables was culled 2026-09-23 (zero readers)
type _KeyDeliverables = ProjectCreate['key_deliverables'];
// @ts-expect-error effort_estimate moved to Stage B (projects.approved_effort_estimate, migration 127)
type _EffortEstimate = ProjectCreate['effort_estimate'];
// @ts-expect-error milestones moved to Stage B (project_milestones, migration 127)
type _Milestones = ProjectCreate['milestones'];

// ── the negative control ─────────────────────────────────────────────────────
// Without this, `Culled` resolving to `true` for EVERYTHING would pass every
// line above and prove nothing. These keys are live and must still be present.
const _nameLives: Culled<'name'> = false;
const _constraintsLive: Culled<'constraints'> = false;
const _riskskLive: Culled<'risks'> = false;
const _repoLives: Culled<'repo'> = false;
const _budgetLives: Culled<'budget'> = false;

// ProjectMilestone is still exported — ProjectForm.svelte imports it, and the
// backend's MilestoneSchema (its contract) is still used by the promote path.
// Only ProjectCreate.milestones went away.
const _milestoneShape: ProjectMilestone = { name: 'M1' };

describe('ProjectCreate — the seven culled keys', () => {
  it('is pinned at type level; this run only proves the module compiles and loads', () => {
    // The type assertions above are the test. Keeping a runtime expect here
    // means `vitest run` reports this file rather than skipping it silently.
    expect([
      _envPlaceholders, _dataClassification, _targetEnvironment,
      _resourcing, _keyDeliverables, _effortEstimate, _milestones,
    ]).toEqual([true, true, true, true, true, true, true]);
    expect([_nameLives, _constraintsLive, _riskskLive, _repoLives, _budgetLives])
      .toEqual([false, false, false, false, false]);
    expect(_milestoneShape.name).toBe('M1');
  });
});
