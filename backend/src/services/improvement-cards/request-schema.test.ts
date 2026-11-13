import { describe, it, expect } from 'bun:test';
import { CardGenerationRequest } from './request-schema';

const happyPath = {
  card_type: 'workflow_statistics_analysis',
  project_id: 'proj-1',
  parent_card_id: null,
  target_list: 'TODO' as const,
  requestor: 'workflow-detector',
  problem_statement: 'Latency creeping >2s on hot path',
  desired_outcome: 'Bring p95 back under 1.5s',
  success_criteria: ['p95 < 1500ms over 24h'],
  acceptance_criteria: ['scenario passes in eval-set'],
  // ⚠️ This was `'workflow' as never as 'app'` — a deliberate type-lie that
  // type-checked and parsed FALSE at runtime. `workflow` is not one of the 8
  // SCOPE_LEVELS (see types/scope-level.ts, whose own header records that three
  // rival vocabularies for this field once made ~78% of projects unable to mint
  // a card, silently). Every existing case happened to override `scope_level`,
  // so the lie was shadowed and nothing was vacuous — but anyone copying
  // `happyPath` into a new case without overriding got a body that can never
  // validate. Pinned below by `happyPath alone is a valid body`.
  scope_level: 'app' as const,
};

describe('CardGenerationRequest', () => {
  it('rejects empty {}', () => {
    const r = CardGenerationRequest.safeParse({});
    expect(r.success).toBe(false);
  });

  // Guards the fixture itself. Before the scope_level fix above this FAILED,
  // which is the whole point: the trap was invisible because every other case
  // overrode the bad field. Deleting this test re-opens the trap.
  it('happyPath alone is a valid body (the fixture must not need patching)', () => {
    const r = CardGenerationRequest.safeParse({ ...happyPath });
    expect(r.success).toBe(true);
    expect(happyPath.scope_level).toBe('app');
  });

  it('accepts a fully-qualified happy-path body', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      priority: 'P1',
      in_scope: ['module-a'],
      out_of_scope: ['module-b'],
      dependencies: ['card-99'],
      constraints: ['no public API change'],
      deadline: '2026-12-31T23:59:59Z',
      artifacts: [
        {
          name: 'baseline-trace',
          uri: 's3://bucket/trace.json',
          type: 'trace',
          description: 'baseline run',
        },
      ],
      secret_ids: ['sec-1'],
      additional_context: 'opened by detector run #42',
      stream_id: '00000000-0000-4000-8000-000000000001',
      stream_slug: '__system_workflow__',
      asset_id: 'asset-1',
      asset_kind: 'workflow',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a structured object additional_context (decomposition payload)', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      additional_context: {
        approval_kind: 'decomposition',
        analysis_payload: [
          { card_type: 'architecture_epic', title: 'Epic A', acceptance_criteria: ['x'] },
        ],
      },
    });
    expect(r.success).toBe(true);
  });

  it('still accepts a plain string additional_context', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      additional_context: 'opened by detector run #7',
    });
    expect(r.success).toBe(true);
  });

  // Inverted 2026-09-27 (vision: time is not a factor; work is pulled on the WIP
  // limit). These two used to assert the `.refine` cross-field rule — that
  // `stopwatch_policy.enabled=true` REQUIRED `timeout_seconds`. The whole field
  // is gone from the schema, so the contract to assert is that it is no longer a
  // contract: the key is stripped, never rejected, and never reaches the parsed
  // output where from-request could stamp it.
  it('strips a legacy stopwatch_policy instead of rejecting or keeping it', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      // Previously a 400: enabled with no timeout_seconds.
      stopwatch_policy: { enabled: true },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(Object.keys(r.data)).not.toContain('stopwatch_policy');
    }
  });

  it('strips stopwatch_policy even when fully populated', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      stopwatch_policy: { enabled: true, timeout_seconds: 7200 },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(Object.keys(r.data)).not.toContain('stopwatch_policy');
      expect(JSON.stringify(r.data)).not.toContain('7200');
    }
  });

  it('no schema issue ever mentions timeout_seconds again', () => {
    // Non-vacuity: this body IS rejected (empty success_criteria), so there are
    // issues to search — the assertion is about their content, not their absence.
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      success_criteria: [],
      stopwatch_policy: { enabled: true },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.length).toBeGreaterThan(0);
      const msg = JSON.stringify(r.error.issues);
      expect(msg).not.toContain('timeout_seconds');
      expect(msg).not.toContain('stopwatch');
    }
  });

  it('rejects empty success_criteria array', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      success_criteria: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty acceptance_criteria array', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      acceptance_criteria: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects success_criteria with empty-string entries', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      success_criteria: [''],
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown target_list', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      target_list: 'NOT_A_LIST',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown scope_level', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'system',
    });
    expect(r.success).toBe(false);
  });

  it('rejects missing required field (e.g. requestor omitted)', () => {
    const { requestor: _omit, ...rest } = happyPath;
    void _omit;
    const r = CardGenerationRequest.safeParse({ ...rest, scope_level: 'app' });
    expect(r.success).toBe(false);
  });

  it('rejects parent_card_id of wrong type (must be string|null)', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      parent_card_id: 123,
    });
    expect(r.success).toBe(false);
  });

  it('accepts parent_card_id as a string', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      parent_card_id: 'card-parent-1',
    });
    expect(r.success).toBe(true);
  });

  it('rejects malformed deadline (not ISO datetime)', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      deadline: 'tomorrow',
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-uuid stream_id', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      stream_id: 'not-a-uuid',
    });
    expect(r.success).toBe(false);
  });

  it('accepts detector_severity and manual_trigger optional fields', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      detector_severity: 'high',
      manual_trigger: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.detector_severity).toBe('high');
      expect(r.data.manual_trigger).toBe(true);
    }
  });

  it('rejects detector_severity outside the enum', () => {
    const r = CardGenerationRequest.safeParse({
      ...happyPath,
      scope_level: 'app',
      detector_severity: 'urgent',
    });
    expect(r.success).toBe(false);
  });
});
