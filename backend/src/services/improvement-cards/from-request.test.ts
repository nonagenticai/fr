import { describe, it, expect } from 'bun:test';
import { valuesFromRequest } from './from-request';
import type { CardGenerationRequestT } from './request-schema';

const baseReq: CardGenerationRequestT = {
  card_type: 'workflow_statistics_analysis',
  project_id: 'proj-1',
  parent_card_id: null,
  target_list: 'TODO',
  requestor: 'detector',
  problem_statement: 'p',
  desired_outcome: 'o',
  success_criteria: ['s1'],
  acceptance_criteria: ['c1', 'c2', 'c3'],
  scope_level: 'app',
};

describe('valuesFromRequest', () => {
  it('populates criterion_1..criterion_5 from acceptance_criteria, padding empty', () => {
    const v = valuesFromRequest(baseReq, {});
    expect(v['Acceptance Criteria'].criterion_1).toBe('c1');
    expect(v['Acceptance Criteria'].criterion_2).toBe('c2');
    expect(v['Acceptance Criteria'].criterion_3).toBe('c3');
    expect(v['Acceptance Criteria'].criterion_4).toBe('');
    expect(v['Acceptance Criteria'].criterion_5).toBe('');
  });

  it('stamps Metadata.keycloak_tenant_id from context (so the n8n router does not fall back to card.projectId)', () => {
    const v = valuesFromRequest(baseReq, { keycloak_tenant_id: '0195f48b-d000-7000-8000-000000000003' });
    expect(v.Metadata.keycloak_tenant_id).toBe('0195f48b-d000-7000-8000-000000000003');
  });

  it('leaves Metadata.keycloak_tenant_id empty when context omits it (writeAllGroupValues skips empty → field unset)', () => {
    const v = valuesFromRequest(baseReq, {});
    expect(v.Metadata.keycloak_tenant_id).toBe('');
  });

  it('caps acceptance_criteria at 5 (extras dropped)', () => {
    const v = valuesFromRequest(
      { ...baseReq, acceptance_criteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      {},
    );
    expect(v['Acceptance Criteria'].criterion_1).toBe('a');
    expect(v['Acceptance Criteria'].criterion_5).toBe('e');
    // No criterion_6 / criterion_7
    expect(Object.keys(v['Acceptance Criteria']).sort()).toEqual([
      'criterion_1',
      'criterion_2',
      'criterion_3',
      'criterion_4',
      'criterion_5',
    ]);
  });

  it('parent_card empty when parent_card_id is null', () => {
    const v = valuesFromRequest(baseReq, {});
    expect(v.Relations.parent_card).toBe('');
  });

  it('parent_card populated when parent_card_id provided', () => {
    const v = valuesFromRequest({ ...baseReq, parent_card_id: 'card-9' }, {});
    expect(v.Relations.parent_card).toBe('card-9');
  });

  it('procedures named per `{card_type}.{phase}.action` (procedures-service regex compat)', () => {
    const v = valuesFromRequest(baseReq, {});
    expect(v.Procedures.readying_procedure).toBe(
      'workflow_statistics_analysis.readying.action',
    );
    expect(v.Procedures.doing_procedure).toBe(
      'workflow_statistics_analysis.doing.action',
    );
    expect(v.Procedures.qa_procedure).toBe(
      'workflow_statistics_analysis.qa.action',
    );
    expect(v.Procedures.done_procedure).toBe(
      'workflow_statistics_analysis.done.action',
    );
  });

  // Inverted 2026-09-27 (vision: time is not a factor; work is pulled on the WIP
  // limit). These two used to assert the stamp EXISTED ('' when unset, '7200'
  // when configured). `stopwatch_policy` is gone from the request schema and
  // nothing stamps `Metadata.stopwatch_timeout` any more, so the assertion is
  // now that the key is ABSENT from the bag — writeAllGroupValues iterates the
  // bag, so an absent key means the Planka field is never PATCHed at all.
  it('does not stamp Metadata.stopwatch_timeout — the clock-driven deadline is retired', () => {
    const v = valuesFromRequest(baseReq, {});
    expect(Object.keys(v.Metadata)).not.toContain('stopwatch_timeout');
    // Control: the sibling Metadata slots this function DOES emit are present,
    // so the absence above is not an empty bag.
    expect(Object.keys(v.Metadata)).toContain('creator_role');
    expect(Object.keys(v.Metadata)).toContain('priority');
  });

  it('ignores a legacy stopwatch_policy on the request object rather than stamping it', () => {
    const v = valuesFromRequest(
      {
        ...baseReq,
        // Cast: no longer part of CardGenerationRequestT. A stale n8n caller can
        // still put it on the wire, where zod strips it; this proves that even if
        // it reached this mapper it would produce no Metadata write.
        ...({ stopwatch_policy: { enabled: true, timeout_seconds: 7200 } } as object),
      } as typeof baseReq,
      {},
    );
    expect(Object.keys(v.Metadata)).not.toContain('stopwatch_timeout');
    expect(JSON.stringify(v)).not.toContain('7200');
  });

  it('Metadata.constraints is JSON.stringify of array (or "[]" when missing)', () => {
    const noConstraints = valuesFromRequest(baseReq, {});
    expect(noConstraints.Metadata.constraints).toBe('[]');

    const withConstraints = valuesFromRequest(
      { ...baseReq, constraints: ['x', 'y'] },
      {},
    );
    expect(withConstraints.Metadata.constraints).toBe('["x","y"]');
  });

  it('Relations.requires is JSON.stringify of dependencies (or "[]")', () => {
    const noDeps = valuesFromRequest(baseReq, {});
    expect(noDeps.Relations.requires).toBe('[]');

    const withDeps = valuesFromRequest(
      { ...baseReq, dependencies: ['card-1', 'card-2'] },
      {},
    );
    expect(withDeps.Relations.requires).toBe('["card-1","card-2"]');
  });

  it('context overrides body for stream_id/stream_slug/asset_id/asset_kind', () => {
    const v = valuesFromRequest(
      {
        ...baseReq,
        stream_id: 'body-stream',
        stream_slug: 'body-slug',
        asset_id: 'body-asset',
        asset_kind: 'body-kind',
      },
      {
        stream_id: 'ctx-stream',
        stream_slug: 'ctx-slug',
        asset_id: 'ctx-asset',
        asset_kind: 'ctx-kind',
        card_group: 'continuous_improvement',
      },
    );
    expect(v.Metadata.stream_id).toBe('ctx-stream');
    expect(v.Metadata.stream_slug).toBe('ctx-slug');
    expect(v.Metadata.asset_id).toBe('ctx-asset');
    expect(v.Metadata.asset_kind).toBe('ctx-kind');
    expect(v.Metadata.card_group).toBe('continuous_improvement');
  });

  it('Metadata.worker_name maps from req.worker_name (empty string when absent)', () => {
    const noWorker = valuesFromRequest(baseReq, {});
    expect(noWorker.Metadata.worker_name).toBe('');

    const withWorker = valuesFromRequest(
      { ...baseReq, worker_name: 'arch_description_quality' },
      {},
    );
    expect(withWorker.Metadata.worker_name).toBe('arch_description_quality');
  });

  it('falls back to body values when context omits stream/asset binding', () => {
    const v = valuesFromRequest(
      {
        ...baseReq,
        stream_slug: 'body-slug',
        asset_id: 'body-asset',
      },
      {},
    );
    expect(v.Metadata.stream_slug).toBe('body-slug');
    expect(v.Metadata.asset_id).toBe('body-asset');
    expect(v.Metadata.stream_id).toBe('');
    expect(v.Metadata.asset_kind).toBe('');
    expect(v.Metadata.card_group).toBe('');
  });

  it('produces all 8 groups, all with non-empty key sets', () => {
    const v = valuesFromRequest(baseReq, {});
    const groups = Object.keys(v).sort();
    expect(groups).toEqual(
      [
        'Acceptance Criteria',
        'Decisions',
        'Metadata',
        'Principles',
        'Procedures',
        'Relations',
        'Requirements',
        'Validation',
      ].sort(),
    );
    for (const g of groups as Array<keyof typeof v>) {
      expect(Object.keys(v[g]).length).toBeGreaterThan(0);
    }
  });

  it('Requirements/Principles/Decisions are empty-string slots 1..5', () => {
    const v = valuesFromRequest(baseReq, {});
    for (const g of ['Requirements', 'Principles', 'Decisions'] as const) {
      const keys = Object.keys(v[g]);
      expect(keys.length).toBe(5);
      for (const k of keys) expect(v[g][k]).toBe('');
    }
  });

  it('writes detector_severity into Metadata; manual_trigger=false writes empty string', () => {
    const v = valuesFromRequest(
      { ...baseReq, detector_severity: 'high', manual_trigger: false },
      {},
    );
    expect(v.Metadata.detector_severity).toBe('high');
    expect(v.Metadata.manual_trigger).toBe('');
  });

  it('manual_trigger=true writes literal "true" string; missing detector_severity writes empty string', () => {
    const v = valuesFromRequest(
      { ...baseReq, manual_trigger: true },
      {},
    );
    expect(v.Metadata.manual_trigger).toBe('true');
    expect(v.Metadata.detector_severity).toBe('');
  });

  it('Metadata mirrors required req fields verbatim', () => {
    const v = valuesFromRequest(
      { ...baseReq, priority: 'P0' },
      { card_group: 'cg' },
    );
    expect(v.Metadata.work_type).toBe('workflow_statistics_analysis');
    expect(v.Metadata.card_type).toBe('workflow_statistics_analysis');
    expect(v.Metadata.scope_level).toBe('app');
    expect(v.Metadata.requestor).toBe('detector');
    expect(v.Metadata.priority).toBe('P0');
    expect(v.Metadata.project_id).toBe('proj-1');
    expect(v.Metadata.creator_role).toBe('');
  });
});
