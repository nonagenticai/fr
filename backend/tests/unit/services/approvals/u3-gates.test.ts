// U3 — mint + decide gates (src/services/approvals/u3-gates.ts).
//
// Pure arms run everywhere; the report-backed arms use createDbSuite (visible skip
// without Postgres, hard fail in CI, every body must assert).
//
// What this pins:
//   * qa.coverage_signoff is DERIVED (COVERAGE + no_computed_check + prefix), never sent
//   * §6.14 coverage_request: malformed → 422; duplicate criterion_id → 422; a
//     coverage_request_ref → 422; inline request on a non-coverage mint → 422
//   * source (ncn#1969 amendment): absent/'r3' need 40-hex SHAs + artifacts; 'derived' needs
//     absent-or-null SHAs (stored null), absent-or-[] artifacts (stored []), every criterion
//     computed EXACTLY {executed:false, outcome:'not_run'} (no extra key) + all-zero summary;
//     any other source 422; the effective source is persisted as coverage_request_source
//   * assertNoCoverageSignoff: the doors that cannot mint qa.coverage_signoff refuse
//     COVERAGE / coverage_request / coverage_request_ref (422 coverage_signoff_not_mintable_here)
//   * bug-fix gate = the bug_fix_authorization MARKER on any kind (RULING 10-01; the kind
//     execution.bug_fix_approval is dropped): unmarked rows untouched; a marked mint must
//     cite the BUG card's report with that H_r in the tenant, >=1 bug, bug_ids within its bugs;
//     a marked decision is A1 + rejected_bug_ids within bug_ids; an approved generic deblock
//     row authorises fixes only with a proceed action (RETRY)
//   * feature_design mint: scenarios_hash is recomputed (mismatch 422); write_set is
//     required and sealed (full write-set / A6 coverage: u3-a3-write-set.test.ts,
//     u3-a6-question.test.ts)
//   * decide: G-12 structured decision only — free text 422, a code outside the row's
//     closed set 422, unregistered rule_version 422, items must be exactly the report's
//     bugs, status must follow from the items; coverage decisions are NOT gated here
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { db, projectReports, queryClient } from '../../../../src/db/client';
import {
  CONTRACT_MISMATCH_CODES,
  G12_RULES,
  G12_RULE_VERSION_V1,
  G12_RULE_VERSION_V2,
  NOT_REAL_BUG_CODES,
  g12CodesFor,
  g12RuleFor,
} from '../../../../src/services/approvals/g12-rule';
import {
  BUG_FIX_AUTHORIZATION_MARKER,
  BUG_FIX_PROCEED_DEBLOCK_ACTIONS,
  COVERAGE_SIGNOFF_KIND,
  COVERAGE_SIGNOFF_NOT_MINTABLE_HERE,
  FEATURE_DESIGN_APPROVAL_KIND,
  assertNoCoverageSignoff,
  assertU3DecideGates,
  assertU3DedupeCompatible,
  bugFixDecisionAuthorises,
  coverageCriteriaHash,
  deriveCoverageSignoff,
  parseCoverageRequest,
  resolveBugFixAuthorizationMint,
  resolveU3Mint,
} from '../../../../src/services/approvals/u3-gates';
import { DEBLOCK_ACTIONS, isBugFixAuthorizationRow } from '../../../../src/domain/engagement/deblock-actions';
import { AppError } from '../../../../src/utils/errors';
import { createDbSuite } from '../../../integration/helpers/db-suite';
import {
  U3_BUGS,
  bugFixMeta,
  coverageRequest,
  derivedCoverageRequest,
  A3_INPUTS_HASH,
  WRITE_SET,
  designMetadata,
  g12,
  sealedDesignMetadata,
  seedBugReport,
  HUMAN_DECIDER_ID,
  AGENT_DECIDER_ID,
} from './u3-fixtures';

const { itDb } = createDbSuite('u3-gates');
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

afterAll(async () => {
  try {
    await queryClient`DELETE FROM project_reports WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
  } catch {
    /* no database — the DB arms already skipped visibly */
  }
}, 30_000); // explicit: bun gives hooks a fixed ~5s budget (fr#950)

/** Run `fn`, return the AppError it throws (status + code), or fail. */
async function refusal(fn: () => unknown): Promise<{ status: number; code?: string }> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return { status: (err as AppError).statusCode, code: (err as AppError).code };
  }
  throw new Error('expected a refusal, got none');
}

const COVERAGE_SIGNALS = {
  deblock_action: 'COVERAGE',
  block_reason_class: 'no_computed_check',
  block_reason: 'no_computed_check:development_feature_new:ac-1,ac-2,ac-3',
};

describe('coverage derivation', () => {
  test('COVERAGE + no_computed_check + prefix derives the coverage kind', () => {
    expect(deriveCoverageSignoff(COVERAGE_SIGNALS)).toBe(true);
    // prefix falls back to change_summary (blocked-escalate puts reason_raw there today)
    expect(
      deriveCoverageSignoff({ ...COVERAGE_SIGNALS, block_reason: undefined, change_summary: 'no_computed_check:x:ac-1' }),
    ).toBe(true);
  });

  // ncn blocked-escalate's Call FR sends change_summary = reason_raw, which Merge Procedure Hint
  // wraps as `block reason: <field>` (ncn@7b013764 §2e real body). The field wrapper is stripped;
  // a COMMENT-sourced prefix derives nothing (ncn §5 contract).
  test('the `block reason: ` field wrapper is stripped; a `comment reason: ` prefix is not', async () => {
    const sig = { deblock_action: 'COVERAGE', block_reason_class: 'no_computed_check' };
    expect(deriveCoverageSignoff({ ...sig, change_summary: 'block reason: no_computed_check:development_bug_fix:crit_a1,crit_b2' })).toBe(true);
    expect(deriveCoverageSignoff({ ...sig, change_summary: '  BLOCK REASON:   no_computed_check:x:crit_a1' })).toBe(true);
    for (const change_summary of ['comment reason: no_computed_check:x:crit_a1', 'block reason: block reason: no_computed_check:x', 'block reason: qa_fail:x']) {
      expect(await refusal(() => deriveCoverageSignoff({ ...sig, change_summary }))).toEqual({
        status: 422,
        code: 'coverage_derivation_incomplete',
      });
    }
  });

  test('a non-COVERAGE action is not the coverage kind', () => {
    expect(deriveCoverageSignoff({ ...COVERAGE_SIGNALS, deblock_action: 'SPLIT' })).toBe(false);
    expect(deriveCoverageSignoff({})).toBe(false);
  });

  test('COVERAGE without the class or the prefix is refused, never minted generic', async () => {
    expect(await refusal(() => deriveCoverageSignoff({ ...COVERAGE_SIGNALS, block_reason_class: 'infrastructure' }))).toEqual({
      status: 422,
      code: 'coverage_derivation_incomplete',
    });
    expect(await refusal(() => deriveCoverageSignoff({ ...COVERAGE_SIGNALS, block_reason: 'qa failed' }))).toEqual({
      status: 422,
      code: 'coverage_derivation_incomplete',
    });
  });

  test('resolveU3Mint derives qa.coverage_signoff and persists ONLY the validated request', async () => {
    const res = await resolveU3Mint({
      rawBody: { ...COVERAGE_SIGNALS, metadata: { coverage_request: coverageRequest('card-1') } },
      cardId: 'card-1',
      tenantId: TENANT_A,
    });
    expect(res?.kind).toBe(COVERAGE_SIGNOFF_KIND);
    expect(Object.keys(res!.metadata)).toEqual(['coverage_request', 'coverage_request_source']);
    expect(res!.metadata.coverage_request_source).toBe('r3');
    const cr = res!.metadata.coverage_request as { criteria: Array<{ scenario_id: string | null }> };
    expect(cr.criteria.map((c) => c.scenario_id)).toEqual(['scn-1', null, 'scn-3']);
  });

  test('sending kind qa.coverage_signoff is refused (derived, never sent)', async () => {
    expect(
      await refusal(() => resolveU3Mint({ rawBody: { kind: COVERAGE_SIGNOFF_KIND }, cardId: 'c', tenantId: TENANT_A })),
    ).toEqual({ status: 422, code: 'u3_kind_not_sendable' });
  });

  test('a body with no U3 signal is untouched (null)', async () => {
    expect(await resolveU3Mint({ rawBody: { reason: 'x', metadata: { other: 1 } }, cardId: 'c', tenantId: TENANT_A })).toBeNull();
  });

  test('a coverage_request on a non-coverage mint is refused', async () => {
    expect(
      await refusal(() =>
        resolveU3Mint({ rawBody: { metadata: { coverage_request: coverageRequest('c') } }, cardId: 'c', tenantId: TENANT_A }),
      ),
    ).toEqual({ status: 422, code: 'coverage_request_without_coverage_kind' });
  });
});

describe('§6.14 coverage_request validation', () => {
  const r = (over: Record<string, unknown>) => ({ coverage_request: coverageRequest('card-1', over) });

  test('a valid request parses', () => {
    expect(parseCoverageRequest(r({}), 'card-1').criteria).toHaveLength(3);
  });

  test('malformed: qa_head_sha not 40 lowercase hex, empty criteria, bad artifact kind, missing test_summary', async () => {
    for (const bad of [
      { qa_head_sha: 'A'.repeat(40) },
      { qa_head_sha: 'abc' },
      { criteria: [] },
      { artifacts: [{ kind: 'video', ref: 'x' }] },
      { test_summary: undefined },
      { test_summary: { passed: -1, failed: 0, skipped: 0 } },
      { unexpected: true },
    ]) {
      expect(await refusal(() => parseCoverageRequest(r(bad), 'card-1'))).toEqual({
        status: 422,
        code: 'coverage_request_invalid',
      });
    }
  });

  test('duplicate criterion_id is refused', async () => {
    const dup = coverageRequest('card-1');
    const criteria = dup.criteria as Array<Record<string, unknown>>;
    criteria[1] = { ...criteria[1], criterion_id: 'ac-1' };
    expect(await refusal(() => parseCoverageRequest({ coverage_request: dup }, 'card-1'))).toEqual({
      status: 422,
      code: 'coverage_request_invalid',
    });
  });

  test('a coverage_request_ref is refused (inline only), even beside an inline request', async () => {
    expect(await refusal(() => parseCoverageRequest({ coverage_request_ref: 'artifacts://x' }, 'card-1'))).toEqual({
      status: 422,
      code: 'coverage_request_ref_refused',
    });
    expect(
      await refusal(() => parseCoverageRequest({ ...r({}), coverage_request_ref: 'artifacts://x' }, 'card-1')),
    ).toEqual({ status: 422, code: 'coverage_request_ref_refused' });
  });

  test('missing request, and a request for another card, are refused', async () => {
    expect(await refusal(() => parseCoverageRequest({}, 'card-1'))).toEqual({
      status: 422,
      code: 'coverage_request_required',
    });
    expect(await refusal(() => parseCoverageRequest(r({}), 'card-2'))).toEqual({
      status: 422,
      code: 'coverage_request_card_mismatch',
    });
  });
});

describe('coverage_request source: r3 | derived (ncn#1969 amendment)', () => {
  const d = (over: Record<string, unknown> = {}) => ({ coverage_request: derivedCoverageRequest('card-1', over) });
  const notRun = { executed: false, outcome: 'not_run' };
  const withCriterion0 = (patch: Record<string, unknown>) => {
    const req = derivedCoverageRequest('card-1');
    const criteria = req.criteria as Array<Record<string, unknown>>;
    criteria[0] = { ...criteria[0], ...patch };
    return { coverage_request: req };
  };

  test('a derived request (null SHAs, [] artifacts, zero summary, not_run criteria) is minted', async () => {
    const res = await resolveU3Mint({
      rawBody: { ...COVERAGE_SIGNALS, metadata: d() },
      cardId: 'card-1',
      tenantId: TENANT_A,
    });
    expect(res?.kind).toBe(COVERAGE_SIGNOFF_KIND);
    expect(res!.metadata.coverage_request_source).toBe('derived');
    const cr = res!.metadata.coverage_request as Record<string, unknown>;
    expect(cr.source).toBe('derived');
    expect(cr.qa_head_sha).toBeNull();
    expect(cr.commit_sha).toBeNull();
    expect((cr.criteria as Array<{ scenario_id: unknown }>).map((c) => c.scenario_id)).toEqual([null, null, 'scn-3']);
  });

  test('derived with ABSENT SHAs is accepted too', () => {
    const req = derivedCoverageRequest('card-1');
    delete req.qa_head_sha;
    delete req.commit_sha;
    expect(parseCoverageRequest({ coverage_request: req }, 'card-1').source).toBe('derived');
  });

  test('derived pr_url: null and ABSENT are accepted and stored as null; a non-url string is 422', async () => {
    expect(parseCoverageRequest(d({ pr_url: null }), 'card-1').pr_url).toBeNull();
    const req = derivedCoverageRequest('card-1');
    delete req.pr_url;
    const stored = parseCoverageRequest({ coverage_request: req }, 'card-1');
    expect('pr_url' in stored).toBe(true);
    expect(stored.pr_url).toBeNull();
    expect(parseCoverageRequest(d(), 'card-1').pr_url).toBe('https://github.com/nonagenticai/ems/pull/1');
    for (const bad of ['not a url', 'x'.repeat(10), `https://github.com/${'a'.repeat(2048)}`]) {
      expect(await refusal(() => parseCoverageRequest(d({ pr_url: bad }), 'card-1'))).toEqual({
        status: 422,
        code: 'coverage_request_invalid',
      });
    }
  });

  test('r3 / absent source still REQUIRES pr_url: null or absent is 422 coverage_request_invalid', async () => {
    for (const over of [{ pr_url: null }, { source: 'r3', pr_url: null }]) {
      expect(await refusal(() => parseCoverageRequest({ coverage_request: coverageRequest('card-1', over) }, 'card-1'))).toEqual({
        status: 422,
        code: 'coverage_request_invalid',
      });
    }
    const absent = coverageRequest('card-1');
    delete absent.pr_url;
    expect(await refusal(() => parseCoverageRequest({ coverage_request: absent }, 'card-1'))).toEqual({
      status: 422,
      code: 'coverage_request_invalid',
    });
  });

  test('derived with a non-null sha is 422 derived_request_has_sha', async () => {
    for (const over of [{ qa_head_sha: 'a'.repeat(40) }, { commit_sha: 'b'.repeat(40) }]) {
      expect(await refusal(() => parseCoverageRequest(d(over), 'card-1'))).toEqual({
        status: 422,
        code: 'derived_request_has_sha',
      });
    }
  });

  test('derived claiming computation is 422 derived_request_claims_computed', async () => {
    for (const body of [
      withCriterion0({ computed: { executed: true, outcome: 'not_run' } }),
      withCriterion0({ computed: { executed: false, outcome: 'pass' } }),
      withCriterion0({ computed: { executed: true, outcome: 'pass' } }),
      withCriterion0({ computed: { outcome: 'not_run' } }),
      withCriterion0({ computed: null }),
      withCriterion0({ computed: undefined }),
      d({ test_summary: { passed: 1, failed: 0, skipped: 0 } }),
    ]) {
      expect(await refusal(() => parseCoverageRequest(body, 'card-1'))).toEqual({
        status: 422,
        code: 'derived_request_claims_computed',
      });
    }
    // Control: the same body with criterion 0 restored to not_run parses.
    expect(parseCoverageRequest(withCriterion0({ computed: notRun }), 'card-1').criteria).toHaveLength(3);
  });

  // A-1. `computed` is an open record: a two-field peek would accept a not_run marker that ALSO
  // claims a pass. Key-set equality refuses every extra key, including ones that say nothing.
  test('derived computed must be EXACTLY {executed:false, outcome:not_run} — any extra key is 422', async () => {
    for (const extra of [
      { result: 'pass', passed: true },
      { result: 'pass' },
      { passed: true },
      { check_kind: 'test' },
      { note: null },
    ]) {
      expect(await refusal(() => parseCoverageRequest(withCriterion0({ computed: { ...notRun, ...extra } }), 'card-1'))).toEqual({
        status: 422,
        code: 'derived_request_claims_computed',
      });
    }
    // A non-record `computed` never reaches the cross-field rule: the schema refuses it.
    expect(await refusal(() => parseCoverageRequest(withCriterion0({ computed: [] }), 'card-1'))).toEqual({
      status: 422,
      code: 'coverage_request_invalid',
    });
    // Control: key order does not matter, only the key SET and values.
    expect(parseCoverageRequest(withCriterion0({ computed: { outcome: 'not_run', executed: false } }), 'card-1').criteria).toHaveLength(3);
  });

  // A-2. The decider UI renders `artifacts` as evidence; a derived request has produced none.
  test('derived artifacts must be absent or [] — any entry is 422 derived_request_claims_computed', async () => {
    const pr = { kind: 'pr', ref: 'https://github.com/nonagenticai/ems/pull/1' };
    for (const artifacts of [[pr], [{ kind: 'test_report', ref: 'x', sha: 'a'.repeat(40) }], [pr, pr]]) {
      expect(await refusal(() => parseCoverageRequest(d({ artifacts }), 'card-1'))).toEqual({
        status: 422,
        code: 'derived_request_claims_computed',
      });
    }
    // Absent is accepted and stored as [] (one stored form).
    const req = derivedCoverageRequest('card-1');
    delete req.artifacts;
    expect(parseCoverageRequest({ coverage_request: req }, 'card-1').artifacts).toEqual([]);
    expect(parseCoverageRequest(d({ artifacts: [] }), 'card-1').artifacts).toEqual([]);
    // r3 still REQUIRES the list (absent → coverage_request_invalid, as before the amendment).
    const r3 = coverageRequest('card-1');
    delete r3.artifacts;
    expect(await refusal(() => parseCoverageRequest({ coverage_request: r3 }, 'card-1'))).toEqual({
      status: 422,
      code: 'coverage_request_invalid',
    });
  });

  // A-3. Absent and null SHAs are the SAME on a derived request: same stored form, and so the
  // same dedupe identity (u3Identity compares with ===).
  test('derived absent SHAs and null SHAs store identically and dedupe as the same artefact', async () => {
    const absent = derivedCoverageRequest('card-1');
    delete absent.qa_head_sha;
    delete absent.commit_sha;
    const fromAbsent = parseCoverageRequest({ coverage_request: absent }, 'card-1');
    const fromNull = parseCoverageRequest(d(), 'card-1');
    expect(fromAbsent.qa_head_sha).toBeNull();
    expect(fromAbsent.commit_sha).toBeNull();
    expect(fromAbsent).toEqual(fromNull);
    // mixed: one absent, one null
    const mixed = derivedCoverageRequest('card-1');
    delete mixed.commit_sha;
    expect(parseCoverageRequest({ coverage_request: mixed }, 'card-1')).toEqual(fromNull);
    const mintAbsent = await resolveU3Mint({ rawBody: { ...COVERAGE_SIGNALS, metadata: { coverage_request: absent } }, cardId: 'card-1', tenantId: TENANT_A });
    const mintNull = await resolveU3Mint({ rawBody: { ...COVERAGE_SIGNALS, metadata: d() }, cardId: 'card-1', tenantId: TENANT_A });
    expect(() =>
      assertU3DedupeCompatible(mintAbsent, { id: 'existing', kind: COVERAGE_SIGNOFF_KIND, metadata: mintNull!.metadata }),
    ).not.toThrow();
  });

  test('r3 / absent source with a null or missing sha is 422 coverage_request_invalid, as before', async () => {
    for (const src of [{ source: 'r3' }, {}]) {
      for (const over of [{ qa_head_sha: null }, { commit_sha: null }, { qa_head_sha: undefined }, { commit_sha: undefined }]) {
        expect(await refusal(() => parseCoverageRequest({ coverage_request: coverageRequest('card-1', { ...src, ...over }) }, 'card-1'))).toEqual({
          status: 422,
          code: 'coverage_request_invalid',
        });
      }
    }
    expect(parseCoverageRequest({ coverage_request: coverageRequest('card-1', { source: 'r3' }) }, 'card-1').source).toBe('r3');
  });

  test('an unknown source is 422 coverage_request_source_invalid', async () => {
    for (const source of ['R3', 'computed', '', null, 1]) {
      expect(await refusal(() => parseCoverageRequest({ coverage_request: coverageRequest('card-1', { source }) }, 'card-1'))).toEqual({
        status: 422,
        code: 'coverage_request_source_invalid',
      });
    }
  });

  test('criteria stay non-empty and unique for a derived request', async () => {
    expect(await refusal(() => parseCoverageRequest(d({ criteria: [] }), 'card-1'))).toEqual({
      status: 422,
      code: 'coverage_request_invalid',
    });
    const dup = derivedCoverageRequest('card-1');
    const criteria = dup.criteria as Array<Record<string, unknown>>;
    criteria[1] = { ...criteria[1], criterion_id: 'ac-1' };
    expect(await refusal(() => parseCoverageRequest({ coverage_request: dup }, 'card-1'))).toEqual({
      status: 422,
      code: 'coverage_request_invalid',
    });
  });
});

describe('assertNoCoverageSignoff — the doors that cannot mint qa.coverage_signoff', () => {
  test('COVERAGE action, coverage_request, coverage_request_ref are each 422 coverage_signoff_not_mintable_here', async () => {
    for (const metadata of [
      { deblock_action: 'COVERAGE' },
      { coverage_request: derivedCoverageRequest('c') },
      { coverage_request: { garbage: true } },
      { coverage_request_ref: 'artifacts://x' },
      { deblock_action: 'COVERAGE', coverage_request: coverageRequest('c') },
    ]) {
      expect(await refusal(() => assertNoCoverageSignoff(metadata, 'door'))).toEqual({
        status: 422,
        code: COVERAGE_SIGNOFF_NOT_MINTABLE_HERE,
      });
    }
  });

  test('controls: no coverage signal, another deblock_action, non-objects pass', () => {
    for (const metadata of [undefined, null, {}, { deblock_action: 'QUESTION' }, { deblock_action: 'RETRY', boardId: 'b' }, [], 'x']) {
      expect(() => assertNoCoverageSignoff(metadata, 'door')).not.toThrow();
    }
  });
});

describe('feature_design mint', () => {
  test('valid metadata mints with the recomputed scenarios_hash', async () => {
    const res = await resolveU3Mint({
      rawBody: { kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: designMetadata() },
      cardId: 'c',
      tenantId: TENANT_A,
    });
    expect(res?.kind).toBe(FEATURE_DESIGN_APPROVAL_KIND);
    expect(res!.metadata.scenarios_hash).toBe(designMetadata().scenarios_hash);
    // the write set is stored as sent, sealed, and the seal folded into a3_inputs_hash
    expect(res!.metadata.write_set).toEqual(WRITE_SET);
    expect(res!.metadata.write_set_seal).toBe(sealedDesignMetadata().write_set_seal);
    expect(res!.metadata.a3_inputs_hash).toBe(A3_INPUTS_HASH);
  });

  test('a wrong scenarios_hash is 422; missing design fields are 422', async () => {
    expect(
      await refusal(() =>
        resolveU3Mint({
          rawBody: { kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: designMetadata({ scenarios_hash: 'e'.repeat(64) }) },
          cardId: 'c',
          tenantId: TENANT_A,
        }),
      ),
    ).toEqual({ status: 422, code: 'scenarios_hash_mismatch' });
    expect(
      await refusal(() =>
        resolveU3Mint({
          rawBody: { kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: designMetadata({ contract_hash: undefined }) },
          cardId: 'c',
          tenantId: TENANT_A,
        }),
      ),
    ).toEqual({ status: 422, code: 'design_metadata_invalid' });
  });
});

describe('bug_fix_authorization MARKER mint (RULING 10-01: any kind, keyed on metadata.approval_kind)', () => {
  const mint = (metadata: unknown, tenantId = TENANT_A) => resolveBugFixAuthorizationMint({ metadata, tenantId });

  test('the predicate: marker on any kind; anything else is unmarked', () => {
    expect(isBugFixAuthorizationRow({ metadata: { approval_kind: BUG_FIX_AUTHORIZATION_MARKER } })).toBe(true);
    for (const metadata of [null, {}, [], { approval_kind: 'decomposition' }, { approval_kind: ['bug_fix_authorization'] }, 'bug_fix_authorization']) {
      expect(isBugFixAuthorizationRow({ metadata })).toBe(false);
    }
  });

  test('an UNMARKED row is untouched (null, no DB read) — even one carrying report fields', async () => {
    expect(await mint({ doingListId: 'd', boardId: 'b', report_id: 'not-even-a-uuid' })).toBeNull();
    expect(await mint(undefined)).toBeNull();
  });

  itDb('a marked row citing the bug card\'s report mints with exactly the typed fields', async () => {
    const rep = await seedBugReport(TENANT_A);
    const out = await mint({ ...bugFixMeta(rep, { bug_ids: [U3_BUGS[0]!.id, U3_BUGS[2]!.id] }), junk: 1 });
    expect(out).toEqual({
      approval_kind: BUG_FIX_AUTHORIZATION_MARKER,
      report_id: rep.id,
      report_hash: rep.hash,
      bug_ids: [U3_BUGS[0]!.id, U3_BUGS[2]!.id],
      bug_card_id: rep.cardId,
    });
  });

  itDb('missing report fields are 422 bug_fix_authorization_metadata_invalid (report_id, report_hash, bug_ids, bug_card_id)', async () => {
    const rep = await seedBugReport(TENANT_A);
    for (const drop of ['report_id', 'report_hash', 'bug_ids', 'bug_card_id']) {
      const m = bugFixMeta(rep);
      delete m[drop];
      expect(await refusal(() => mint(m))).toEqual({ status: 422, code: 'bug_fix_authorization_metadata_invalid' });
    }
    expect(await refusal(() => mint(bugFixMeta(rep, { bug_ids: [] })))).toEqual({
      status: 422,
      code: 'bug_fix_authorization_metadata_invalid',
    });
    expect(await refusal(() => mint(bugFixMeta(rep, { bug_ids: [U3_BUGS[0]!.id, U3_BUGS[0]!.id] })))).toEqual({
      status: 422,
      code: 'bug_fix_authorization_metadata_invalid',
    });
  });

  itDb('a wrong hash is 409 report_hash_mismatch; another tenant\'s report is 409 report_not_found', async () => {
    const rep = await seedBugReport(TENANT_A);
    expect(await refusal(() => mint(bugFixMeta(rep, { report_hash: 'f'.repeat(64) })))).toEqual({
      status: 409,
      code: 'report_hash_mismatch',
    });
    const repB = await seedBugReport(TENANT_B);
    expect(await refusal(() => mint(bugFixMeta(repB)))).toEqual({ status: 409, code: 'report_not_found' });
  });

  itDb('wrong card: the report must be about bug_card_id → 409 report_card_mismatch', async () => {
    const rep = await seedBugReport(TENANT_A);
    expect(await refusal(() => mint(bugFixMeta(rep, { bug_card_id: `decision-card-${randomUUID()}` })))).toEqual({
      status: 409,
      code: 'report_card_mismatch',
    });
  });

  itDb('a non-bug report (even one carrying a content_hash) is 422 report_not_bug_report', async () => {
    const cardId = `u3-card-${randomUUID()}`;
    const hash = randomUUID().replace(/-/g, '').repeat(2);
    const [row] = await db
      .insert(projectReports)
      .values({ tenant_id: TENANT_A, card_id: cardId, report_type: 'quality', title: 'q', summary: 'q', content_hash: hash })
      .returning({ id: projectReports.id });
    expect(
      await refusal(() => mint(bugFixMeta({ id: row!.id, hash, cardId }, { bug_ids: ['x'] }))),
    ).toEqual({ status: 422, code: 'report_not_bug_report' });
  });

  itDb('ZERO-BUG RULING: bugs: [] and a missing bugs array are both 422 report_has_no_bugs', async () => {
    const rep = await seedBugReport(TENANT_A, []);
    expect(await refusal(() => mint(bugFixMeta(rep, { bug_ids: ['anything'] })))).toEqual({
      status: 422,
      code: 'report_has_no_bugs',
    });
    const cardId = `u3-card-${randomUUID()}`;
    const hash = randomUUID().replace(/-/g, '').repeat(2);
    const [row] = await db
      .insert(projectReports)
      .values({ tenant_id: TENANT_A, card_id: cardId, report_type: 'bug_report', title: 'b', summary: 'b', content_hash: hash })
      .returning({ id: projectReports.id });
    expect(await refusal(() => mint(bugFixMeta({ id: row!.id, hash, cardId }, { bug_ids: ['anything'] })))).toEqual({
      status: 422,
      code: 'report_has_no_bugs',
    });
  });

  itDb('bug_ids not ⊆ the report\'s bugs → 422 bug_ids_not_in_report (control: a true subset mints)', async () => {
    const rep = await seedBugReport(TENANT_A);
    expect(await refusal(() => mint(bugFixMeta(rep, { bug_ids: [U3_BUGS[0]!.id, 'f'.repeat(64)] })))).toEqual({
      status: 422,
      code: 'bug_ids_not_in_report',
    });
    expect((await mint(bugFixMeta(rep, { bug_ids: [U3_BUGS[1]!.id] })))?.bug_ids).toEqual([U3_BUGS[1]!.id]);
  });

  test('a U3 kind cannot carry the marker (422 u3_kind_conflict)', async () => {
    expect(
      await refusal(() =>
        resolveU3Mint({
          rawBody: { kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: { ...designMetadata(), approval_kind: BUG_FIX_AUTHORIZATION_MARKER } },
          cardId: 'c',
          tenantId: TENANT_A,
        }),
      ),
    ).toEqual({ status: 422, code: 'u3_kind_conflict' });
  });

  test('the dropped kind execution.bug_fix_approval is no longer sendable', async () => {
    expect(
      await refusal(() => resolveU3Mint({ rawBody: { kind: 'execution.bug_fix_approval' }, cardId: 'c', tenantId: TENANT_A })),
    ).toEqual({ status: 422, code: 'u3_kind_not_sendable' });
  });
});

describe('RULING a (10-01): only an approved marked execution.ready_signoff row authorises fixes', () => {
  test('BUG_FIX_PROCEED_DEBLOCK_ACTIONS is empty — no generic deblock action proceeds', () => {
    expect([...BUG_FIX_PROCEED_DEBLOCK_ACTIONS]).toEqual([]);
  });

  test('a marked GENERIC row approved with ANY DEBLOCK_ACTION (RETRY included) or none authorises nothing', () => {
    expect(DEBLOCK_ACTIONS).toContain('RETRY');
    for (const action of [...DEBLOCK_ACTIONS, undefined, null, '', 'retry', 'PROCEED']) {
      expect([action, bugFixDecisionAuthorises({ kind: 'generic', status: 'approved', deblockAction: action })]).toEqual([
        action,
        false,
      ]);
    }
  });

  test('approved ready_signoff authorises (status-only); a rejection or any other kind never does', () => {
    expect(bugFixDecisionAuthorises({ kind: 'execution.ready_signoff', status: 'approved', deblockAction: undefined })).toBe(true);
    expect(bugFixDecisionAuthorises({ kind: 'execution.ready_signoff', status: 'approved', deblockAction: 'RETRY' })).toBe(true);
    expect(bugFixDecisionAuthorises({ kind: 'execution.ready_signoff', status: 'rejected', deblockAction: undefined })).toBe(false);
    expect(bugFixDecisionAuthorises({ kind: 'generic', status: 'rejected', deblockAction: 'RETRY' })).toBe(false);
    expect(bugFixDecisionAuthorises({ kind: 'execution.feature_design_approval', status: 'approved', deblockAction: undefined })).toBe(false);
    expect(bugFixDecisionAuthorises({ kind: 'execution.bug_fix_approval', status: 'approved', deblockAction: undefined })).toBe(false);
  });
});

describe('decide gates on a MARKED row (G-12 A1 + rejected_bug_ids)', () => {
  const [B0, B1, B2] = U3_BUGS.map((b) => b.id) as [string, string, string];

  async function marked(kind = 'execution.ready_signoff', extra: Record<string, unknown> = {}) {
    const rep = await seedBugReport(TENANT_A);
    return {
      rep,
      approval: { id: randomUUID(), tenant_id: TENANT_A, kind, metadata: { ...bugFixMeta(rep), ...extra } },
    };
  }
  const a1 = (rep: { hash: string }, extra: Record<string, unknown> = {}) => ({
    rule_version: G12_RULE_VERSION_V2,
    rule_row: 'A1',
    inputs_hash: rep.hash,
    ...extra,
  });

  itDb('2 of 3: rejected_bug_ids [B2] + its code → item_decisions with 2 approved, 1 rejected', async () => {
    const { rep, approval } = await marked();
    const out = await assertU3DecideGates({
      approval,
      rawBody: { rejected_bug_ids: [B2], g12_decision: a1(rep, { reject_reason_code: 'not_real_bug:(ii)' }) },
      status: 'approved',
      deciderId: HUMAN_DECIDER_ID,
    });
    expect(out?.rule_row).toBe('A1');
    expect(out?.rejected_bug_ids).toEqual([B2]);
    expect(out?.items).toEqual([
      { item_id: B0, decision: 'approve', reason_code: 'real_bug_ok' },
      { item_id: B1, decision: 'approve', reason_code: 'real_bug_ok' },
      { item_id: B2, decision: 'reject', reason_code: 'not_real_bug:(ii)' },
    ]);
  });

  itDb('omitted on approve ⇒ all approved; omitted on reject ⇒ all rejected (and a reject code is required)', async () => {
    const { rep, approval } = await marked();
    const yes = await assertU3DecideGates({ approval, rawBody: { g12_decision: a1(rep) }, status: 'approved', deciderId: HUMAN_DECIDER_ID });
    expect(yes?.items.map((i) => i.decision)).toEqual(['approve', 'approve', 'approve']);
    const no = await assertU3DecideGates({
      approval,
      rawBody: { g12_decision: a1(rep, { reject_reason_code: 'prechosen_reject' }) },
      status: 'rejected',
      deciderId: HUMAN_DECIDER_ID,
    });
    expect(no?.rejected_bug_ids).toEqual([B0, B1, B2]);
    expect(no?.items.every((i) => i.decision === 'reject' && i.reason_code === 'prechosen_reject')).toBe(true);
    expect(await refusal(() => assertU3DecideGates({ approval, rawBody: { g12_decision: a1(rep) }, status: 'rejected', deciderId: HUMAN_DECIDER_ID }))).toEqual({
      status: 422,
      code: 'reject_reason_code_required',
    });
  });

  itDb('free text → 422: as a reason_code, as reason, as comment (control: a code as reason passes)', async () => {
    const { rep, approval } = await marked();
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval,
          rawBody: { rejected_bug_ids: [B2], g12_decision: a1(rep, { reject_reason_code: 'not a real bug imo' }) },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 422, code: 'reason_code_not_in_rule' });
    for (const field of ['reason', 'comment']) {
      expect(
        await refusal(() =>
          assertU3DecideGates({ approval, rawBody: { [field]: 'please also refactor X', g12_decision: a1(rep) }, status: 'approved', deciderId: HUMAN_DECIDER_ID }),
        ),
      ).toEqual({ status: 422, code: 'free_text_refused' });
    }
    expect(
      await assertU3DecideGates({ approval, rawBody: { reason: 'real_bug_ok', g12_decision: a1(rep) }, status: 'approved', deciderId: HUMAN_DECIDER_ID }),
    ).not.toBeNull();
  });

  itDb('an explicit item with the wrong polarity, or for a bug outside bug_ids, is refused', async () => {
    const { rep, approval } = await marked();
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval,
          rawBody: { g12_decision: a1(rep, { items: [{ item_id: B0, decision: 'approve', reason_code: 'prechosen_reject' }] }) },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 422, code: 'reason_code_not_in_rule' });
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval,
          rawBody: { g12_decision: a1(rep, { items: [{ item_id: B0, decision: 'reject', reason_code: 'not_real_bug:(i)' }] }) },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 422, code: 'decision_items_inconsistent' });
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval,
          rawBody: { g12_decision: a1(rep, { items: [{ item_id: 'f'.repeat(64), decision: 'approve', reason_code: 'real_bug_ok' }] }) },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 422, code: 'items_mismatch' });
  });

  itDb('rejected_bug_ids ⊄ bug_ids → 422 rejected_bug_ids_not_subset (control: a bug of the REPORT not minted counts too)', async () => {
    const rep = await seedBugReport(TENANT_A);
    // Minted over B0+B1 only: B2 is a real bug of the report, but not of THIS gate.
    const approval = { id: randomUUID(), tenant_id: TENANT_A, kind: 'execution.ready_signoff', metadata: bugFixMeta(rep, { bug_ids: [B0, B1] }) };
    for (const ids of [['f'.repeat(64)], [B2]]) {
      expect(
        await refusal(() =>
          assertU3DecideGates({
            approval,
            rawBody: { rejected_bug_ids: ids, g12_decision: a1(rep, { reject_reason_code: 'prechosen_reject' }) },
            status: 'approved',
            deciderId: HUMAN_DECIDER_ID,
          }),
        ),
      ).toEqual({ status: 422, code: 'rejected_bug_ids_not_subset' });
    }
    expect(
      await refusal(() =>
        assertU3DecideGates({ approval, rawBody: { rejected_bug_ids: 'B0', g12_decision: a1(rep) }, status: 'approved', deciderId: HUMAN_DECIDER_ID }),
      ),
    ).toEqual({ status: 422, code: 'rejected_bug_ids_invalid' });
  });

  itDb('status must follow from the per-bug outcome', async () => {
    const { rep, approval } = await marked();
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval,
          rawBody: { rejected_bug_ids: [B0, B1, B2], g12_decision: a1(rep, { reject_reason_code: 'prechosen_reject' }) },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 422, code: 'decision_items_inconsistent' });
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval,
          rawBody: { rejected_bug_ids: [B0], g12_decision: a1(rep, { reject_reason_code: 'prechosen_reject' }) },
          status: 'rejected',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 422, code: 'decision_items_inconsistent' });
  });

  itDb('generic deblock row (RULING a): approved + DROP and approved + RETRY both authorise nothing (all rejected)', async () => {
    const drop = await marked('generic', { deblock_action: 'DROP' });
    const out = await assertU3DecideGates({
      approval: drop.approval,
      rawBody: { reason: 'not_real_bug:(i)', g12_decision: a1(drop.rep, { reject_reason_code: 'not_real_bug:(i)' }) },
      status: 'approved',
      deciderId: HUMAN_DECIDER_ID,
    });
    expect(out?.items.every((i) => i.decision === 'reject')).toBe(true);
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval: drop.approval,
          rawBody: { rejected_bug_ids: [B0], g12_decision: a1(drop.rep, { reject_reason_code: 'not_real_bug:(i)' }) },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 422, code: 'decision_items_inconsistent' });
    // The decider's override wins over the stored proposal: RETRY stored, DROP supplied.
    const over = await marked('generic', { deblock_action: 'RETRY' });
    const overOut = await assertU3DecideGates({
      approval: over.approval,
      rawBody: { deblock_action: 'DROP', g12_decision: a1(over.rep, { reject_reason_code: 'prechosen_reject' }) },
      status: 'approved',
      deciderId: HUMAN_DECIDER_ID,
    });
    expect(overOut?.items.every((i) => i.decision === 'reject')).toBe(true);
    // RULING a: RETRY authorises nothing either — an approve-every-bug decision is refused,
    // and the only consistent decision rejects every bug.
    const retry = await marked('generic', { deblock_action: 'RETRY' });
    expect(
      await refusal(() => assertU3DecideGates({ approval: retry.approval, rawBody: { g12_decision: a1(retry.rep) }, status: 'approved', deciderId: HUMAN_DECIDER_ID })),
    ).toEqual({ status: 422, code: 'reject_reason_code_required' });
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval: retry.approval,
          rawBody: { rejected_bug_ids: [B0], g12_decision: a1(retry.rep, { reject_reason_code: 'not_real_bug:(i)' }) },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 422, code: 'decision_items_inconsistent' });
    const retryOut = await assertU3DecideGates({
      approval: retry.approval,
      rawBody: { g12_decision: a1(retry.rep, { reject_reason_code: 'not_real_bug:(i)' }) },
      status: 'approved',
      deciderId: HUMAN_DECIDER_ID,
    });
    expect(retryOut?.items.every((i) => i.decision === 'reject')).toBe(true);
  });

  itDb('no structured decision, an unregistered rule_version, or the wrong row are 422', async () => {
    const { rep, approval } = await marked();
    expect(await refusal(() => assertU3DecideGates({ approval, rawBody: { reason: 'real_bug_ok' }, status: 'approved', deciderId: HUMAN_DECIDER_ID }))).toEqual({
      status: 422,
      code: 'g12_decision_required',
    });
    expect(
      await refusal(() =>
        assertU3DecideGates({ approval, rawBody: { g12_decision: a1(rep, { rule_version: '0'.repeat(64) }) }, status: 'approved', deciderId: HUMAN_DECIDER_ID }),
      ),
    ).toEqual({ status: 422, code: 'g12_rule_version_unregistered' });
    expect(
      await refusal(() => assertU3DecideGates({ approval, rawBody: { g12_decision: a1(rep, { rule_row: 'A3' }) }, status: 'approved', deciderId: HUMAN_DECIDER_ID })),
    ).toEqual({ status: 422, code: 'g12_rule_row_mismatch' });
  });

  itDb('the report hash is re-checked at decide', async () => {
    const { approval } = await marked();
    expect(
      await refusal(() =>
        assertU3DecideGates({ approval, rawBody: { g12_decision: a1({ hash: 'f'.repeat(64) }) }, status: 'approved', deciderId: HUMAN_DECIDER_ID }),
      ),
    ).toEqual({ status: 409, code: 'inputs_hash_mismatch' });
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval: { ...approval, metadata: { ...approval.metadata, report_hash: 'f'.repeat(64) } },
          rawBody: { g12_decision: a1({ hash: 'f'.repeat(64) }) },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 409, code: 'report_hash_mismatch' });
  });

  itDb('not_real_bug takes parentheses: (iv) passes, iv is refused', async () => {
    const { rep, approval } = await marked();
    const decide = (code: string) =>
      assertU3DecideGates({
        approval,
        rawBody: { rejected_bug_ids: [B0], g12_decision: a1(rep, { reject_reason_code: code }) },
        status: 'approved',
        deciderId: HUMAN_DECIDER_ID,
      });
    expect((await decide('not_real_bug:(iv)'))?.items[0]?.reason_code).toBe('not_real_bug:(iv)');
    expect(await refusal(() => decide('not_real_bug:iv'))).toEqual({ status: 422, code: 'reason_code_not_in_rule' });
  });

  test('unmarked generic / ready_signoff rows and coverage are NOT gated here', async () => {
    for (const [kind, metadata] of [
      ['generic', { deblock_action: 'RETRY' }],
      ['execution.ready_signoff', { approval_kind: 'decomposition' }],
      [COVERAGE_SIGNOFF_KIND, {}],
    ] as const) {
      expect(
        await assertU3DecideGates({
          approval: { id: randomUUID(), tenant_id: TENANT_A, kind, metadata },
          rawBody: { comment: 'free text is fine here' },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ).toBeNull();
    }
  });
});

describe('decide gates: feature_design (A3)', () => {
  test('design decide: one item = the design; hash must be the minted a3_inputs_hash', async () => {
    const approval = {
      id: randomUUID(),
      tenant_id: TENANT_A,
      kind: FEATURE_DESIGN_APPROVAL_KIND,
      metadata: sealedDesignMetadata(),
    };
    const ok = await assertU3DecideGates({
      approval,
      rawBody: {
        g12_decision: g12({
          rule_row: 'A3',
          inputs_hash: A3_INPUTS_HASH,
          items: [{ item_id: 'design-1', decision: 'reject', reason_code: 'contract_mismatch:args' }],
        }),
      },
      status: 'rejected',
      deciderId: HUMAN_DECIDER_ID,
    });
    expect(ok?.items[0]?.reason_code).toBe('contract_mismatch:args');
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval,
          rawBody: {
            g12_decision: g12({
              rule_row: 'A3',
              inputs_hash: 'e'.repeat(64),
              items: [{ item_id: 'design-1', decision: 'approve', reason_code: 'design_ok' }],
            }),
          },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 409, code: 'inputs_hash_mismatch' });
    // the bare design_hash (the pre-seal inputs_hash) is now WRONG
    expect(
      await refusal(() =>
        assertU3DecideGates({
          approval,
          rawBody: {
            g12_decision: g12({
              rule_row: 'A3',
              inputs_hash: 'd'.repeat(64),
              items: [{ item_id: 'design-1', decision: 'approve', reason_code: 'design_ok' }],
            }),
          },
          status: 'approved',
          deciderId: HUMAN_DECIDER_ID,
        }),
      ),
    ).toEqual({ status: 409, code: 'inputs_hash_mismatch' });
  });
});

  // George 2026-10-31: telegram/web/mcp are equivalent — the responder is the responder, human
  // or agent. No decider class is refused; decider_kind records WHO, honestly.
  test('an agent member decides an A3: admitted, decider_kind agent; a human: decider_kind human', async () => {
    const approval = { id: randomUUID(), tenant_id: TENANT_A, kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: sealedDesignMetadata() };
    const rawBody = {
      g12_decision: g12({
        rule_row: 'A3',
        inputs_hash: A3_INPUTS_HASH,
        items: [{ item_id: 'design-1', decision: 'approve', reason_code: 'design_ok' }],
      }),
    };
    const byAgent = await assertU3DecideGates({ approval, rawBody, status: 'approved', deciderId: AGENT_DECIDER_ID });
    expect(byAgent?.decider_kind).toBe('agent');
    expect(byAgent?.items[0]?.decision).toBe('approve');
    const byHuman = await assertU3DecideGates({ approval, rawBody, status: 'approved', deciderId: HUMAN_DECIDER_ID });
    expect(byHuman?.decider_kind).toBe('human');
  });

describe('coverage dedupe identity: SHAs + card_type + a hash of the criteria', () => {
  const cov = (overrides: Record<string, unknown> = {}) => ({
    kind: COVERAGE_SIGNOFF_KIND,
    metadata: { coverage_request: coverageRequest('card-cov', overrides) },
  });
  const open = (overrides: Record<string, unknown> = {}) => ({ id: 'open-1', ...cov(overrides) });
  const crit = coverageRequest('card-cov').criteria as Array<Record<string, unknown>>;

  test('same SHAs + same criteria (in any order) dedupe', () => {
    expect(() => assertU3DedupeCompatible(cov(), open())).not.toThrow();
    expect(() => assertU3DedupeCompatible(cov({ criteria: [...crit].reverse() }), open())).not.toThrow();
    // text / reason changes are not part of the identity (only ids are)
    expect(() =>
      assertU3DedupeCompatible(cov({ criteria: crit.map((c) => ({ ...c, text: `${c.text}!` })) }), open()),
    ).not.toThrow();
  });

  test('same SHAs but a DIFFERENT criteria set is 409 open_gate_conflict, never a dedupe', async () => {
    // an AC dropped
    expect(await refusal(() => assertU3DedupeCompatible(cov({ criteria: crit.slice(0, 2) }), open()))).toEqual({
      status: 409,
      code: 'open_gate_conflict',
    });
    // an AC added
    const added = [...crit, { criterion_id: 'ac-4', text: 'new', scenario_id: null, reason_not_computed: 'x' }];
    expect(await refusal(() => assertU3DedupeCompatible(cov({ criteria: added }), open()))).toEqual({
      status: 409,
      code: 'open_gate_conflict',
    });
    // same ids, one AC re-bound to another scenario
    const rebound = crit.map((c) => (c.criterion_id === 'ac-2' ? { ...c, scenario_id: 'scn-9' } : c));
    expect(await refusal(() => assertU3DedupeCompatible(cov({ criteria: rebound }), open()))).toEqual({
      status: 409,
      code: 'open_gate_conflict',
    });
  });

  test('a different card_type at the same SHAs and criteria is 409', async () => {
    expect(await refusal(() => assertU3DedupeCompatible(cov({ card_type: 'bug_fix' }), open()))).toEqual({
      status: 409,
      code: 'open_gate_conflict',
    });
  });

  test('coverageCriteriaHash: order-independent, id-sensitive, null-normalised scenario_id', () => {
    const h = coverageCriteriaHash(crit);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(coverageCriteriaHash([...crit].reverse())).toBe(h);
    expect(coverageCriteriaHash(crit.slice(1))).not.toBe(h);
    const noScn = crit.map((c) => (c.criterion_id === 'ac-2' ? { ...c, scenario_id: undefined } : c));
    expect(coverageCriteriaHash(noScn)).toBe(h); // ac-2 is null in the fixture; undefined ≡ null
    expect(coverageCriteriaHash(undefined)).toBeUndefined();
  });
});

describe('dedupe: a U3 mint never rides an open gate asking a different question', () => {
  const design = { kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: sealedDesignMetadata() } as const;

  test('a different kind is 409 open_gate_conflict', async () => {
    expect(await refusal(() => assertU3DedupeCompatible(design, { id: 'x', kind: 'generic', metadata: {} }))).toEqual({
      status: 409,
      code: 'open_gate_conflict',
    });
    expect(
      await refusal(() =>
        assertU3DedupeCompatible(design, { id: 'x', kind: COVERAGE_SIGNOFF_KIND, metadata: { coverage_request: coverageRequest('c') } }),
      ),
    ).toEqual({ status: 409, code: 'open_gate_conflict' });
  });

  test('the same kind with a different design hash is 409', async () => {
    expect(
      await refusal(() =>
        assertU3DedupeCompatible(design, {
          id: 'x',
          kind: FEATURE_DESIGN_APPROVAL_KIND,
          metadata: sealedDesignMetadata({ design_hash: 'e'.repeat(64) }),
        }),
      ),
    ).toEqual({ status: 409, code: 'open_gate_conflict' });
  });

  test('the same design with a DIFFERENT write set is 409 (the seal is part of the identity)', async () => {
    expect(
      await refusal(() =>
        assertU3DedupeCompatible(design, {
          id: 'x',
          kind: FEATURE_DESIGN_APPROVAL_KIND,
          metadata: sealedDesignMetadata({ write_set: ['src/design.ts'] }),
        }),
      ),
    ).toEqual({ status: 409, code: 'open_gate_conflict' });
  });

  test('the same kind and the same hash may dedupe; a non-U3 mint onto a non-G-12 gate is untouched', () => {
    expect(() =>
      assertU3DedupeCompatible(design, { id: 'x', kind: FEATURE_DESIGN_APPROVAL_KIND, metadata: { ...design.metadata, extra: 1 } }),
    ).not.toThrow();
    expect(() => assertU3DedupeCompatible(null, { id: 'x', kind: 'generic', metadata: {} })).not.toThrow();
    expect(() => assertU3DedupeCompatible(null, { id: 'x', kind: 'execution.ready_signoff', metadata: {} })).not.toThrow();
  });

  // movies-f1 finding (2026-10-03): the non-U3 direction returned early, so a kind-less mint was
  // handed an open G-12 gate as its own.
  test('a non-U3 mint onto ANY open G-12 gate kind ⇒ 409 open_gate_conflict', () => {
    for (const kind of [FEATURE_DESIGN_APPROVAL_KIND, 'qa.coverage_signoff', 'execution.question']) {
      expect(() => assertU3DedupeCompatible(null, { id: 'x', kind, metadata: {} })).toThrow(
        expect.objectContaining({ code: 'open_gate_conflict' }),
      );
    }
  });
});

describe('G-12 codes keyed by (rule_version, rule_row) — G-12-approval-rule-v1.md + v2.md (§7.3)', () => {
  // The closed sets, verbatim from the signed v2 table (A1 / A3 rows) + §7 spellings.
  const A1_APPROVE = ['real_bug_ok'];
  const A1_REJECT = ['not_real_bug:(i)', 'not_real_bug:(ii)', 'not_real_bug:(iii)', 'not_real_bug:(iv)', 'prechosen_reject'];
  const A3_APPROVE = ['design_ok'];
  const A3_REJECT = [
    'contract_mismatch:tool',
    'contract_mismatch:args',
    'contract_mismatch:semantics',
    'contract_mismatch:result',
    'contract_mismatch:errors',
    'ac_without_scenario',
    'test_plan_not_executable',
    'scope_creep',
  ];
  // v1's sets, from the signed v1 table with its `<which clause>` / `<field>` templates
  // expanded per v2 §7.2 ("no change of meaning; this was already v1's plain reading").
  // The ONLY difference from v2: v1's A3 has no code for predicate (iii).
  const V1_A3_REJECT = A3_REJECT.filter((c) => c !== 'test_plan_not_executable');
  // A6, from §3: approve `answered:<Q-id>` for the seven answerable rows; Q8 / uncovered
  // questions have the single reject code. No `answered:Q8`.
  const A6_APPROVE = ['answered:Q1', 'answered:Q2', 'answered:Q3', 'answered:Q4', 'answered:Q5', 'answered:Q6', 'answered:Q7'];
  const A6_REJECT = ['no_registered_answer'];

  test('both signed sha256s are registered, and nothing else (v2 §7.3)', () => {
    expect(G12_RULE_VERSION_V1).toBe('3f705295e150007b2412e12ba67bedda900856e616b8c636e2afa3c56ec26654');
    expect(G12_RULE_VERSION_V2).toBe('6cb9ebaea51e6f4acdca31b262c8e487277a85df5dcc05d0ee7fea5e162f0cd7');
    expect(G12_RULES.map((r) => r.rule_version).sort()).toEqual([G12_RULE_VERSION_V1, G12_RULE_VERSION_V2].sort());
    expect(g12RuleFor('e'.repeat(64))).toBeUndefined();
    expect(g12CodesFor('e'.repeat(64), 'A1')).toBeUndefined();
  });

  test('v1 A1/A3 code sets are exactly v1\'s closed sets (v2 minus test_plan_not_executable)', () => {
    expect(g12CodesFor(G12_RULE_VERSION_V1, 'A1')).toEqual({ approve: A1_APPROVE, reject: A1_REJECT });
    expect(g12CodesFor(G12_RULE_VERSION_V1, 'A3')).toEqual({ approve: A3_APPROVE, reject: V1_A3_REJECT });
    expect(V1_A3_REJECT).toHaveLength(A3_REJECT.length - 1);
    // A6 (execution.question) is identical in v1 and v2 (G-12 §3 is unchanged).
    expect(Object.keys(g12RuleFor(G12_RULE_VERSION_V1)!.rows).sort()).toEqual(['A1', 'A3', 'A6']);
    expect(g12CodesFor(G12_RULE_VERSION_V1, 'A6')).toEqual({ approve: A6_APPROVE, reject: A6_REJECT });
  });

  test('v2 A1/A3 code sets are exactly the closed sets (nothing added, nothing missing)', () => {
    expect(g12CodesFor(G12_RULE_VERSION_V2, 'A1')).toEqual({ approve: A1_APPROVE, reject: A1_REJECT });
    expect(g12CodesFor(G12_RULE_VERSION_V2, 'A3')).toEqual({ approve: A3_APPROVE, reject: A3_REJECT });
    expect<string[]>([...NOT_REAL_BUG_CODES]).toEqual(A1_REJECT.slice(0, 4));
    expect<string[]>([...CONTRACT_MISMATCH_CODES]).toEqual(A3_REJECT.slice(0, 5));
    // Only the gated rows are registered; A4 (coverage) is fr#1333's, not listed here.
    expect(Object.keys(g12RuleFor(G12_RULE_VERSION_V2)!.rows).sort()).toEqual(['A1', 'A3', 'A6']);
    expect(g12CodesFor(G12_RULE_VERSION_V2, 'A6')).toEqual({ approve: A6_APPROVE, reject: A6_REJECT });
    expect(g12RuleFor(G12_RULE_VERSION_V2)!.rows.A6!.governs).toBe('execution.question');
  });

  const designApproval = () => ({
    id: randomUUID(),
    tenant_id: TENANT_A,
    kind: FEATURE_DESIGN_APPROVAL_KIND,
    metadata: sealedDesignMetadata(),
  });
  const decideDesign = (item: Record<string, unknown>, version?: string) =>
    assertU3DecideGates({
      approval: designApproval(),
      rawBody: {
        g12_decision: g12({ rule_row: 'A3', inputs_hash: A3_INPUTS_HASH, items: [{ item_id: 'design-1', ...item }] }, version),
      },
      status: item.decision === 'approve' ? 'approved' : 'rejected',
      deciderId: HUMAN_DECIDER_ID,
    });

  test('every v2 A3 code is accepted on its own side', async () => {
    for (const reason_code of A3_APPROVE) {
      const out = await decideDesign({ decision: 'approve', reason_code });
      expect(out?.rule_version).toBe(G12_RULE_VERSION_V2);
      expect(out?.items[0]?.reason_code).toBe(reason_code);
    }
    for (const reason_code of A3_REJECT) {
      const out = await decideDesign({ decision: 'reject', reason_code });
      expect(out?.items[0]).toEqual({ item_id: 'design-1', decision: 'reject', reason_code });
    }
  });

  test('an A3 code on the wrong side, an unknown code, or an old / nested / unparenthesised spelling is refused', async () => {
    expect(await refusal(() => decideDesign({ decision: 'approve', reason_code: 'scope_creep' }))).toEqual({
      status: 422,
      code: 'reason_code_not_in_rule',
    });
    for (const reason_code of [
      'not_a_code',
      'contract_mismatch:tool_name',
      'contract_mismatch:result_shape',
      'contract_mismatch:args.limit',
      'contract_mismatch:out_of_scope',
      'test_plan_not_executable (iii)',
      'real_bug_ok',
    ]) {
      expect(await refusal(() => decideDesign({ decision: 'reject', reason_code }))).toEqual({
        status: 422,
        code: 'reason_code_not_in_rule',
      });
    }
  });

  test('v1-stamped A3: validated against v1\'s OWN set (v2 §7.3)', async () => {
    // test_plan_not_executable is v2-only: refused under v1, accepted under v2.
    expect(
      await refusal(() => decideDesign({ decision: 'reject', reason_code: 'test_plan_not_executable' }, G12_RULE_VERSION_V1)),
    ).toEqual({ status: 422, code: 'reason_code_not_in_rule' });
    const v2 = await decideDesign({ decision: 'reject', reason_code: 'test_plan_not_executable' }, G12_RULE_VERSION_V2);
    expect(v2?.rule_version).toBe(G12_RULE_VERSION_V2);
    expect(v2?.items[0]?.reason_code).toBe('test_plan_not_executable');
    // Every v1 code is accepted under v1, on its own side, and stamped v1 (not upgraded).
    const ok = await decideDesign({ decision: 'approve', reason_code: 'design_ok' }, G12_RULE_VERSION_V1);
    expect(ok?.rule_version).toBe(G12_RULE_VERSION_V1);
    expect(ok?.items[0]?.reason_code).toBe('design_ok');
    for (const reason_code of V1_A3_REJECT) {
      const out = await decideDesign({ decision: 'reject', reason_code }, G12_RULE_VERSION_V1);
      expect(out?.rule_version).toBe(G12_RULE_VERSION_V1);
      expect(out?.items[0]).toEqual({ item_id: 'design-1', decision: 'reject', reason_code });
    }
  });

  test('an unregistered rule_version is refused', async () => {
    expect(await refusal(() => decideDesign({ decision: 'approve', reason_code: 'design_ok' }, 'e'.repeat(64)))).toEqual({
      status: 422,
      code: 'g12_rule_version_unregistered',
    });
  });

  // A1 on a marked row: the item codes are checked in parseG12Decision, BEFORE the report
  // lookup, so these arms need no database.
  const markedA1 = (items: unknown[], status: 'approved' | 'rejected', version?: string) =>
    assertU3DecideGates({
      approval: {
        id: randomUUID(),
        tenant_id: TENANT_A,
        kind: 'execution.ready_signoff',
        metadata: { approval_kind: BUG_FIX_AUTHORIZATION_MARKER, report_id: randomUUID(), report_hash: 'a'.repeat(64), bug_ids: ['bug-1'] },
      },
      rawBody: { g12_decision: g12({ rule_row: 'A1', inputs_hash: 'a'.repeat(64), items }, version) },
      status,
      deciderId: HUMAN_DECIDER_ID,
    });

  test('codes are keyed by row: every A3 code under rule_row A1 is refused', async () => {
    for (const reason_code of A3_REJECT) {
      expect(await refusal(() => markedA1([{ item_id: 'bug-1', decision: 'reject', reason_code }], 'rejected'))).toEqual({
        status: 422,
        code: 'reason_code_not_in_rule',
      });
    }
    expect(
      await refusal(() => markedA1([{ item_id: 'bug-1', decision: 'approve', reason_code: 'design_ok' }], 'approved')),
    ).toEqual({ status: 422, code: 'reason_code_not_in_rule' });
    expect(
      await refusal(() => markedA1([{ item_id: 'bug-1', decision: 'reject', reason_code: 'not_real_bug:ii' }], 'rejected')),
    ).toEqual({ status: 422, code: 'reason_code_not_in_rule' });
    expect(
      await refusal(() => markedA1([{ item_id: 'bug-1', decision: 'approve', reason_code: 'real_bug_ok' }], 'approved', 'e'.repeat(64))),
    ).toEqual({ status: 422, code: 'g12_rule_version_unregistered' });
  });

  itDb('every v2 A1 code is accepted on its own side (report-backed)', async () => {
    const rep = await seedBugReport(TENANT_A);
    const [B0] = U3_BUGS.map((b) => b.id) as [string];
    const decide = (items: unknown[], status: 'approved' | 'rejected', rejected: string[]) =>
      assertU3DecideGates({
        approval: { id: randomUUID(), tenant_id: TENANT_A, kind: 'execution.ready_signoff', metadata: bugFixMeta(rep) },
        rawBody: { rejected_bug_ids: rejected, g12_decision: g12({ rule_row: 'A1', inputs_hash: rep.hash, items }) },
        status,
        deciderId: HUMAN_DECIDER_ID,
      });
    const approved = await decide([{ item_id: B0, decision: 'approve', reason_code: 'real_bug_ok' }], 'approved', []);
    expect(approved?.rule_version).toBe(G12_RULE_VERSION_V2);
    expect(approved?.items.find((i) => i.item_id === B0)?.reason_code).toBe('real_bug_ok');
    for (const reason_code of A1_REJECT) {
      const out = await decide([{ item_id: B0, decision: 'reject', reason_code }], 'approved', [B0]);
      expect(out?.items.find((i) => i.item_id === B0)).toEqual({ item_id: B0, decision: 'reject', reason_code });
    }
  });

  test('a nested location rides predicate_inputs.mismatch_path, only on a contract_mismatch code', async () => {
    const out = await decideDesign({
      decision: 'reject',
      reason_code: 'contract_mismatch:args',
      predicate_inputs: { mismatch_path: 'args.limit.type' },
    });
    expect(out?.items[0]).toEqual({
      item_id: 'design-1',
      decision: 'reject',
      reason_code: 'contract_mismatch:args',
      predicate_inputs: { mismatch_path: 'args.limit.type' },
    });
    expect(
      await refusal(() =>
        decideDesign({ decision: 'reject', reason_code: 'scope_creep', predicate_inputs: { mismatch_path: 'x' } }),
      ),
    ).toEqual({ status: 422, code: 'predicate_inputs_unexpected' });
  });
});
