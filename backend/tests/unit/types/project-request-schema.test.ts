// tests/unit/types/project-request-schema.test.ts
//
// Stage A (ProjectRequestSchema) + the typed constraint vocabulary.
//
// One of the six defects reported on 2026-09-21 is enforced HERE rather than in
// the form, because a rule that lives only in the frontend is a suggestion:
//
//   * approvers-must-be-UUIDs — the form collected free text, which the backend
//     filtered out and then silently fell back to the project owner, so the
//     sign-off roster the user believed they set never existed.
//
// ⚠️ The multi-repo coherence rule was the second one. It is DELETED as of
// 2026-09-30 — see the tombstone below where its tests were.

import { describe, expect, test } from 'bun:test';
import { ProjectCreateSchema, ProjectRequestSchema, ProjectOutlineSchema } from '../../../src/types/api';
import {
  ProjectConstraintSchema,
  describeConstraint,
  isMachineCheckable,
  renderConstraintsForBrief,
  type ProjectConstraint,
} from '../../../src/types/project-constraints';

const repo = (url: string, is_primary = false) => ({ url, is_primary });

const base = {
  name: 'Payments hardening',
  repositories: [repo('https://github.com/acme/widget', true)],
};

describe('ProjectRequestSchema — the minimum a request is', () => {
  test('a name and one repository are enough', () => {
    const p = ProjectRequestSchema.parse(base);
    expect(p.name).toBe('Payments hardening');
    expect(p.repositories).toHaveLength(1);
    expect(p.shape).toBe('deliverable');
  });

  test('at least one repository is required — a request about nothing is not a request', () => {
    expect(() => ProjectRequestSchema.parse({ name: 'x', repositories: [] })).toThrow();
  });
});

// ⛔ THE MULTI-REPO COHERENCE TESTS WERE HERE AND ARE DELETED (2026-09-30).
// The two refines they pinned — 'multi_repo' requires ≥2 repositories, and >1
// repository requires 'multi_repo' — are gone from types/api.ts (both on
// ProjectRequestSchema and on ProjectCreateSchema, plus the whole
// withRepoScopeCoherence helper and its own test file
// project-create-repo-scope-coherence.test.ts). `scope_level` is a GRANULARITY
// vocabulary, orthogonal to repository count, so the second direction refused the
// ordinary case of two repos at granularity 'module'; scope_level is now DERIVED
// from repo count in routes/projects.ts, not asked. Re-adding either assertion
// re-adds a rule the operator removed on purpose.
describe('ProjectRequestSchema — at most one primary repository', () => {
  test('at most one repository may be primary', () => {
    const r = ProjectRequestSchema.safeParse({
      ...base,
      scope_level: 'multi_repo',
      repositories: [repo('https://github.com/acme/a', true), repo('https://github.com/acme/b', true)],
    });
    expect(r.success).toBe(false);
  });
});

describe('ProjectRequestSchema — approvers must be UUIDs', () => {
  test('a typed human name is REFUSED at the door', () => {
    // Previously this parsed, was filtered out by explicitSignoffIds, logged to
    // a console.warn nobody reads, and fell back to the project owner.
    const r = ProjectRequestSchema.safeParse({ ...base, approvers: ['Jane Doe'] });
    expect(r.success).toBe(false);
  });

  test('a real user id is accepted', () => {
    const r = ProjectRequestSchema.safeParse({
      ...base,
      approvers: ['0195f48b-d000-7000-8000-000000000001'],
    });
    expect(r.success).toBe(true);
  });
});

describe('ProjectRequestSchema — the 21 dead fields are not accepted back in', () => {
  // The whole unit exists to remove write-only fields. If one reappears in this
  // schema, it must be because someone wired a reader — and then this list is
  // where they say so.
  const DEAD = [
    'priority', 'lifecycle_class', 'sponsor', 'delivery_owner', 'operational_owner',
    'stakeholders', 'in_scope', 'out_of_scope', 'key_deliverables',
    'high_level_requirements', 'assumptions', 'access_requirements',
    'env_placeholders', 'data_classification', 'target_environment', 'deadline',
    'milestones', 'effort_estimate', 'resourcing', 'budget', 'notes',
    'secret_ids', 'document_ids', 'repository_id',
  ];

  test('none of them survive a parse', () => {
    const parsed = ProjectRequestSchema.parse({
      ...base,
      ...Object.fromEntries(DEAD.map((k) => [k, 'smuggled'])),
    }) as Record<string, unknown>;
    const survivors = DEAD.filter((k) => parsed[k] !== undefined);
    expect(survivors).toEqual([]);
  });
});

describe('ProjectRequestSchema — target_packages keeps the shape the backend reads', () => {
  test('bare strings are REFUSED (this is the live 422 the form produces today)', () => {
    const r = ProjectRequestSchema.safeParse({
      ...base,
      project_type: 'it',
      it_flow: 'dependency',
      target_packages: ['fastmcp'],
    });
    expect(r.success).toBe(false);
  });

  test('{name, target_version} is accepted', () => {
    const r = ProjectRequestSchema.safeParse({
      ...base,
      project_type: 'it',
      it_flow: 'dependency',
      target_packages: [{ name: 'fastmcp', target_version: '2.3.0' }],
    });
    expect(r.success).toBe(true);
  });
});

describe('ProjectConstraintSchema — typed, with a labelled escape hatch', () => {
  test('the example that prompted the design parses', () => {
    const c = ProjectConstraintSchema.parse({ kind: 'no_language_version_change' });
    expect(describeConstraint(c)).toMatch(/do not change the language version/i);
  });

  test('a parameterised kind keeps its parameters', () => {
    const c = ProjectConstraintSchema.parse({
      kind: 'pin_language_version', language: 'python', version: '3.11',
    });
    expect(describeConstraint(c)).toContain('python');
    expect(describeConstraint(c)).toContain('3.11');
  });

  test('an unknown kind is REFUSED — that is what a closed vocabulary buys', () => {
    expect(() => ProjectConstraintSchema.parse({ kind: 'invent_something' })).toThrow();
  });

  test('a parameterised kind without its parameters is REFUSED', () => {
    expect(() => ProjectConstraintSchema.parse({ kind: 'pin_language_version' })).toThrow();
    expect(() => ProjectConstraintSchema.parse({ kind: 'no_files_touched', globs: [] })).toThrow();
  });

  test('custom and must_keep_api_compatible are agent-only; the other five are enforced', () => {
    // The distinction the UI must surface: "we will hold you to this" vs
    // "we will pass this along". A user who cannot see which one they picked
    // has not been told the truth about their own request.
    const custom: ProjectConstraint = { kind: 'custom', text: 'be careful' };
    expect(isMachineCheckable(custom)).toBe(false);
    // No diff rule can prove API compatibility, so the landing gate reports it
    // as unchecked — the badge must not promise otherwise.
    expect(isMachineCheckable({ kind: 'must_keep_api_compatible' })).toBe(false);

    for (const c of [
      { kind: 'no_language_version_change' },
      { kind: 'pin_language_version', language: 'go', version: '1.22' },
      { kind: 'no_dependency_upgrades' },
      { kind: 'no_new_dependencies' },
      { kind: 'no_files_touched', globs: ['src/**'] },
    ] as ProjectConstraint[]) {
      expect(isMachineCheckable(c)).toBe(true);
    }
  });

  test('describeConstraint is exhaustive — every kind renders something an agent can act on', () => {
    for (const c of [
      { kind: 'no_language_version_change' },
      { kind: 'pin_language_version', language: 'go', version: '1.22' },
      { kind: 'no_dependency_upgrades' },
      { kind: 'no_new_dependencies' },
      { kind: 'no_files_touched', globs: ['src/**'] },
      { kind: 'must_keep_api_compatible' },
      { kind: 'custom', text: 'do not touch the vendor directory' },
    ] as ProjectConstraint[]) {
      const d = describeConstraint(c);
      expect(d.length).toBeGreaterThan(0);
      expect(d).not.toContain('undefined');
    }
  });
});

describe('ProjectOutlineSchema — Stage B', () => {
  test('an empty outline is valid and defaults to empty lists', () => {
    const o = ProjectOutlineSchema.parse({});
    expect(o.deliverables).toEqual([]);
    expect(o.intermediate_deliverables).toEqual([]);
    expect(o.milestones).toEqual([]);
  });

  test('it carries what the REQUEST form used to ask a user to invent', () => {
    const o = ProjectOutlineSchema.parse({
      deliverables: [{ kind: 'code_change', title: 'API v2', acceptance_criteria: ['returns 200'] }],
      milestones: [{ name: 'M1', target_date: '2026-11-01' }],
      effort_estimate: { value: 3, unit: 'weeks' },
      cost_estimate: { currency: 'EUR', amount: 12000 },
    });
    expect(o.deliverables[0]!.title).toBe('API v2');
    expect(o.deliverables[0]!.acceptance_criteria).toEqual(['returns 200']);
    expect(o.effort_estimate?.unit).toBe('weeks');
    expect(o.cost_estimate?.amount).toBe(12000);
  });

  test('a bare-name deliverable (the pre-contract shape) is refused', () => {
    expect(() => ProjectOutlineSchema.parse({ deliverables: [{ name: 'API v2' }] })).toThrow();
    expect(() => ProjectOutlineSchema.parse({ deliverables: ['API v2'] })).toThrow();
  });

  test('acceptance_criteria defaults to an empty list', () => {
    const o = ProjectOutlineSchema.parse({ deliverables: [{ kind: 'document', title: 'ADR' }] });
    expect(o.deliverables[0]!.acceptance_criteria).toEqual([]);
  });

  test('a negative effort is refused', () => {
    expect(() =>
      ProjectOutlineSchema.parse({ effort_estimate: { value: -1, unit: 'days' } }),
    ).toThrow();
  });

  // ── REPO ATTRIBUTION SURVIVES THE SCHEMA ─────────────────────────────────
  // MUTATION: delete `repos` (or `repos_source`) from OutlineDeliverableSchema
  // in src/types/api.ts -> zod's DEFAULT STRIP removes it and this test is RED
  // (`toEqual([...])` sees `undefined`), while the outline webhook still answers
  // 201. That is exactly the silent strip this pair of lines closes.
  test('repos / repos_source on a deliverable survive the parse (zod strips unnamed keys)', () => {
    const o = ProjectOutlineSchema.parse({
      deliverables: [
        {
          kind: 'code_change',
          title: 'Bump the adapter',
          acceptance_criteria: ['tests green'],
          repos: ['https://github.com/acme/api', 'git@github.com:acme/worker.git'],
          repos_source: 'default_primary',
        },
      ],
      intermediate_deliverables: [
        { kind: 'analysis', title: 'Survey', repos: ['https://github.com/acme/api'] },
      ],
    });
    expect(o.deliverables[0]!.repos).toEqual([
      'https://github.com/acme/api',
      // NOT `.url()`: an scp-style remote is a legitimate spelling and refusing
      // it would 422 the whole outline delivery.
      'git@github.com:acme/worker.git',
    ]);
    expect(o.deliverables[0]!.repos_source).toBe('default_primary');
    expect(o.intermediate_deliverables[0]!.repos).toEqual(['https://github.com/acme/api']);
  });

  test('an unattributed deliverable keeps ABSENT distinct from EMPTY (no default)', () => {
    const o = ProjectOutlineSchema.parse({
      deliverables: [{ kind: 'document', title: 'ADR' }],
    });
    // Not `[]`: "not attributed" and "attributed to no repository" are
    // different findings, so `repos` carries no `.default([])`.
    expect(o.deliverables[0]!.repos).toBeUndefined();
    expect('repos' in o.deliverables[0]!).toBe(false);
    expect(o.deliverables[0]!.repos_source).toBeUndefined();
  });

  test('the fields are NAMED, not passthrough — an unknown key is still stripped', () => {
    // MUTATION CONTROL for the two tests above: if someone "fixes" this by
    // reaching for `.passthrough()`, those tests go green either way and this
    // one goes RED. It is what distinguishes "we named two fields" from "we
    // accept everything on a machine-authenticated webhook body".
    const o = ProjectOutlineSchema.parse({
      deliverables: [
        { kind: 'code_change', title: 'T', repos: ['r'], invented_by_the_model: 'x' },
      ],
    });
    expect('invented_by_the_model' in o.deliverables[0]!).toBe(false);
  });

  test('repos entries must be non-empty strings, and repos_source is bounded', () => {
    expect(
      ProjectOutlineSchema.safeParse({
        deliverables: [{ kind: 'code_change', title: 'T', repos: [''] }],
      }).success,
    ).toBe(false);
    expect(
      ProjectOutlineSchema.safeParse({
        deliverables: [{ kind: 'code_change', title: 'T', repos: 'not-an-array' }],
      }).success,
    ).toBe(false);
    expect(
      ProjectOutlineSchema.safeParse({
        deliverables: [{ kind: 'code_change', title: 'T', repos_source: 'x'.repeat(65) }],
      }).success,
    ).toBe(false);
    // ⚠️ A marker the producer does not emit TODAY is still accepted: this is a
    // plain string, not an enum, because an enum would 422 the whole outline.
    expect(
      ProjectOutlineSchema.safeParse({
        deliverables: [{ kind: 'code_change', title: 'T', repos_source: 'stated' }],
      }).success,
    ).toBe(true);
  });
});

describe('renderConstraintsForBrief — delivery, which is the whole point', () => {
  test('null when there is nothing to say (distinguishable from a render failure)', () => {
    expect(renderConstraintsForBrief(undefined)).toBeNull();
    expect(renderConstraintsForBrief([])).toBeNull();
    expect(renderConstraintsForBrief('not an array')).toBeNull();
  });

  test('renders the typed vocabulary as instructions an agent can act on', () => {
    const out = renderConstraintsForBrief([
      { kind: 'no_language_version_change' },
      { kind: 'no_files_touched', globs: ['vendor/**'] },
    ]);
    expect(out).toContain('Do NOT change the language version');
    expect(out).toContain('vendor/**');
    expect(out!.split('\n')).toHaveLength(2);
  });

  test('LEGACY string[] rows still render — they are not migrated', () => {
    // Every project created before the vocabulary carries string[], because
    // ProjectCreateSchema declared z.array(z.string()). Reading "do not
    // upgrade python" into {kind:'pin_language_version'} would manufacture a
    // machine-checkable promise the user never made, so legacy strings are
    // delivered verbatim and treated like `custom`.
    expect(renderConstraintsForBrief(['do not upgrade python'])).toBe(
      'do not upgrade python',
    );
  });

  test('a mixed column renders both shapes', () => {
    const out = renderConstraintsForBrief([
      'legacy text',
      { kind: 'no_new_dependencies' },
    ]);
    expect(out).toContain('legacy text');
    expect(out).toContain('Do NOT add any new dependency');
  });

  test('an unrecognised shape is REPORTED, never silently dropped', () => {
    // A constraint the user set and the agent never sees is the exact defect
    // being fixed. Dropping it here would reproduce it one layer further in.
    const out = renderConstraintsForBrief([{ kind: 'from_the_future', x: 1 }]);
    expect(out).toContain('unrecognised constraint');
    expect(out).toContain('from_the_future');
  });

  test('one bad entry does not take the rest of the brief down', () => {
    const out = renderConstraintsForBrief([
      { kind: 'no_dependency_upgrades' },
      { kind: 'nonsense' },
      'legacy',
    ]);
    expect(out!.split('\n')).toHaveLength(3);
    expect(out).toContain('Do NOT upgrade any existing dependency');
    expect(out).toContain('legacy');
  });

  test('blank legacy strings are skipped rather than emitting empty lines', () => {
    expect(renderConstraintsForBrief(['  ', 'real'])).toBe('real');
  });
});

describe('ProjectCreateSchema — the engine accepts BOTH constraint shapes', () => {
  // The engine contract is re-parsed on direct create AND on request approval.
  // Accepting only one shape would 422 either every legacy request or every
  // request from the redesigned form.
  const base = { name: 'p', repository_url: 'https://github.com/acme/a' };

  test('legacy string[] constraints and dependencies still parse', () => {
    const r = ProjectCreateSchema.safeParse({
      ...base,
      constraints: ['do not upgrade python'],
      dependencies: ['payments-api'],
    });
    expect(r.success).toBe(true);
  });

  test('typed constraints and dependencies from the redesigned form parse', () => {
    const r = ProjectCreateSchema.safeParse({
      ...base,
      constraints: [{ kind: 'no_language_version_change' }, { kind: 'custom', text: 'x' }],
      dependencies: [{ name: 'payments-api', kind: 'service' }],
    });
    expect(r.success).toBe(true);
  });

  test('a malformed typed constraint is still refused', () => {
    const r = ProjectCreateSchema.safeParse({
      ...base,
      constraints: [{ kind: 'pin_language_version' }],
    });
    expect(r.success).toBe(false);
  });
});
