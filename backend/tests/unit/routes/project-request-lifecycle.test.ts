// tests/unit/routes/project-request-lifecycle.test.ts
//
// The two-stage request lifecycle: the event sources, outline versioning,
// what a decided outline approval does, and the audit-trail discipline.
//
// ⚠️ SCOPE. Like tests/unit/routes/tenant/members.test.ts, this suite has no
// database and runs with AUTH_BYPASS, so it does NOT drive the handlers — a
// handler-level assertion here would be testing the no-local-Postgres failure
// while LOOKING like lifecycle coverage. The state machine is expressed as pure
// helpers precisely so it can be tested here; end-to-end belongs in the
// integration suite.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REQUEST_STATUSES,
  eventSources,
  nextOutlineVersion,
  outlineDecisionEffect,
  OUTLINE_APPROVAL_KIND,
  collectRequestRepoUrls,
  repoAccessBlockers,
  READABLE_ACCESS_STATES,
  toOutlineListItem,
} from '../../../src/routes/project-request-lifecycle';
import { FR_REPO_SENTINEL } from '../../../src/routes/project-requests';

const SOURCE = readFileSync(
  join(import.meta.dir, '../../../src/routes/project-request-lifecycle.ts'),
  'utf8',
);

describe('lifecycle event sources', () => {
  test('submit is allowed only from draft or failed', () => {
    expect(eventSources('submit').sort()).toEqual(['draft', 'failed']);
  });

  test('an outline can arrive while submitted, analysing, or replacing a live outline', () => {
    expect(eventSources('outline').sort()).toEqual([
      'analysing',
      'outline_proposed',
      'submitted',
    ]);
  });

  test('only a proposed outline can be decided', () => {
    expect(eventSources('outline_decided')).toEqual(['outline_proposed']);
  });

  test('every status in the table is one the DB CHECK constraint permits', () => {
    const migration = readFileSync(
      join(import.meta.dir, '../../../migrations/123_project_request_lifecycle.sql'),
      'utf8',
    );
    for (const s of REQUEST_STATUSES) {
      expect(migration).toContain(`'${s}'`);
    }
  });
});

describe('nextOutlineVersion', () => {
  test('first outline is v1', () => {
    expect(nextOutlineVersion([])).toBe(1);
  });
  test('max + 1, independent of order', () => {
    expect(nextOutlineVersion([2, 1, 3])).toBe(4);
  });
  test('gaps are never reused', () => {
    expect(nextOutlineVersion([1, 5])).toBe(6);
  });
  test('non-integer garbage is ignored', () => {
    expect(nextOutlineVersion([Number.NaN, 2.5, 1])).toBe(2);
  });
});

describe('outlineDecisionEffect', () => {
  test('approved -> outline approved, request approved, promote', () => {
    expect(outlineDecisionEffect('approved')).toEqual({
      outlineStatus: 'approved',
      requestStatus: 'approved',
      historyAction: 'outline_approved',
      promote: true,
    });
  });

  test('rejected -> outline rejected, request back to submitted, no promote', () => {
    expect(outlineDecisionEffect('rejected')).toEqual({
      outlineStatus: 'rejected',
      requestStatus: 'submitted',
      historyAction: 'outline_rejected',
      promote: false,
    });
  });

  test('expired / voided change nothing but are still recorded', () => {
    for (const s of ['expired', 'voided']) {
      const e = outlineDecisionEffect(s);
      expect(e.outlineStatus).toBeNull();
      expect(e.requestStatus).toBeNull();
      expect(e.promote).toBe(false);
      expect(e.historyAction).toBe(`outline_decision_${s}`);
    }
  });
});

describe('GET /outlines carries the linked approval status (UI review 2026-10-08)', () => {
  const base = { id: 'o-1', approval_id: 'a-1', status: 'proposed', version: 1 } as unknown as Parameters<
    typeof toOutlineListItem
  >[0]['outline'];

  test('the joined approval status rides on the outline', () => {
    expect(toOutlineListItem({ outline: base, approval_status: 'voided' })).toMatchObject({
      id: 'o-1',
      status: 'proposed',
      approval_status: 'voided',
    });
  });

  test('no linked approval ⇒ approval_status null (never undefined)', () => {
    expect(toOutlineListItem({ outline: base, approval_status: null }).approval_status).toBeNull();
  });

  test('fr#1484: a legacy outline has plan_view null; a plan outline carries the server-built view', () => {
    expect(toOutlineListItem({ outline: base, approval_status: null }).plan_view).toBeNull();
    const plan = {
      template_id: 'it.bug_hunt',
      template_hash: 'h',
      phases: ['deep_analysis', 'closure'],
      deliverables: [
        { id: 'd1', phase: 'deep_analysis', card_types: ['code_quality_analysis'], cardinality: 'fixed:1', minter: 'commit' },
        { id: 'd3', phase: 'closure', card_types: ['project_closure'], cardinality: 'at_phase_exit', minter: 'p' },
      ],
    };
    const withPlan = { ...(base as object), phase_plan: plan, phase_plan_hash: 'e'.repeat(64) } as typeof base;
    const item = toOutlineListItem({ outline: withPlan, approval_status: null });
    expect(item.plan_view?.card_count_at_commit).toBe(1);
    expect(item.plan_view?.phases.map((p) => p.phase)).toEqual(['deep_analysis', 'closure']);
    // A stored plan that no longer parses is REPORTED, never an empty plan.
    const broken = { ...(base as object), phase_plan: { phases: [] }, phase_plan_hash: 'e'.repeat(64) } as typeof base;
    const b = toOutlineListItem({ outline: broken, approval_status: null });
    expect(b.plan_view).toBeNull();
    expect(b.plan_view_error).toMatch(/invalid/);
  });

  test('the approvals join is LEFT and fenced to the request tenant', () => {
    // P1b: the route and the agent's `project_requests.list_outlines` share ONE
    // query (`projectRequestOutlineItems`); the route only loads + delegates.
    const route = SOURCE.indexOf('export async function handleListProjectRequestOutlines');
    const routeBody = SOURCE.slice(route, SOURCE.indexOf('\nexport ', route + 10));
    expect(routeBody).toContain('projectRequestOutlineItems(row)');
    const start = SOURCE.indexOf('export async function projectRequestOutlineItems');
    expect(start).toBeGreaterThan(-1);
    const body = SOURCE.slice(start, SOURCE.indexOf('\nexport ', start + 10));
    expect(body).toContain('.leftJoin(');
    expect(body).toContain('eq(approvals.tenant_id, row.tenant_id)');
    expect(body).toContain('rows.map((r) => toOutlineListItem(r, labels))');
  });
});

describe('source invariants', () => {
  test('the outline approval kind is a value of the approval_kind enum', () => {
    const schema = readFileSync(join(import.meta.dir, '../../../src/db/schema.ts'), 'utf8');
    expect(schema).toContain(`'${OUTLINE_APPROVAL_KIND}'`);
  });

  test('every history write goes through appendHistorySql (no read-modify-write)', () => {
    const writes = [...SOURCE.matchAll(/\bhistory\s*:/g)];
    // Non-vacuity: the file must actually carry history writes for the loop to
    // mean anything. No count — it moves with every history write added.
    expect(writes.length).toBeGreaterThan(0);
    for (const m of writes) {
      const after = SOURCE.slice(m.index! + m[0].length).trimStart();
      expect(after.startsWith('appendHistorySql(')).toBe(true);
    }
    expect(SOURCE).not.toMatch(/\.\.\.\s*\w*\.?history\b/);
  });

  test('the outline approval names its approver and refuses before minting', () => {
    const refusal = SOURCE.indexOf('if (approvers.length === 0)');
    const mint = SOURCE.indexOf('.insert(approvals)');
    expect(refusal).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(refusal);
    expect(SOURCE).toContain('approver_user_id: approvers[0]');
  });

  test('the outline approval writes its required_approvers roster in the SAME transaction', () => {
    // #1153 regression: approver_user_id alone authorizes nobody —
    // handleUpdateApproval reads only required_approvers. The roster insert must
    // be on `tx`, after the approval mint, before the transaction closes.
    const mint = SOURCE.indexOf('.insert(approvals)');
    const roster = SOURCE.indexOf('tx.insert(requiredApprovers)');
    const txEnd = SOURCE.indexOf('supersededApprovalId: live?.approval_id');
    expect(mint).toBeGreaterThan(-1);
    expect(roster).toBeGreaterThan(mint);
    expect(txEnd).toBeGreaterThan(roster);
    expect(SOURCE).toContain('resolveSignoffStakeholderIds(');
  });

  test('onOutlineDecided never rethrows out of its outer catch', () => {
    // ⚠️ THE END BOUNDARY IS THE NEXT EXPORT, NOT A NAMED FUNCTION FURTHER DOWN.
    // It used to be `indexOf('export async function handleListProjectRequestOutlines')`
    // — a positional slice that silently widened to cover EVERY function
    // declared between the two names. Adding `handleWithdrawProjectRequest`
    // (which throws TransitionConflict, correctly and by design, inside its own
    // transaction) between them turned this red while `onOutlineDecided` was
    // byte-for-byte unchanged. A false red here is cheap; the expensive version
    // is the inverse, and this boundary is what stops either.
    const start = SOURCE.indexOf('export async function onOutlineDecided');
    expect(start).toBeGreaterThan(-1);
    const rest = SOURCE.slice(start + 'export async function onOutlineDecided'.length);
    const nextExport = rest.indexOf('\nexport ');
    expect(nextExport).toBeGreaterThan(-1);
    const body = rest.slice(0, nextExport);
    // Positive control: the slice really is onOutlineDecided's body and nothing
    // else — if this ever stops matching, the slice has drifted and the
    // `throw`-free assertion below would be vacuous.
    expect(body).toContain('promoteProjectRequest({');
    expect(body).toContain("return { handled: true, action: 'error', error: message };");
    expect(body).not.toContain('handleWithdrawProjectRequest');
    expect(body).not.toMatch(/\bthrow\b/);
  });
});

describe('the outline constraint scan is WIRED into the outline webhook', () => {
  // ⚠️ SCOPE, stated so nobody reads more into these than they prove. This
  // suite has no database (see the file header), so these are WIRING PINS: they
  // catch the scan being deleted, reordered out of the mint, or made fatal.
  // They CANNOT catch a logic change inside the scan — that belongs to
  // tests/unit/services/outline-constraint-scan.test.ts, which drives the real
  // function and is where the neuter-mutation is proved to redden.

  test('the scan runs on the request payload + the delivered outline', () => {
    expect(SOURCE).toContain("from '../services/outline-constraint-scan'");
    expect(SOURCE).toContain('scanOutlineForContradictions(requestPayload.constraints, body)');
    expect(SOURCE).toContain('renderContradictionsForApproval(scan)');
  });

  test('the findings reach the approval card through change_summary', () => {
    // change_summary is the field with FIVE live frontend readers (⚠️ corrected
    // 2026-09-24 — this said four; projects/[id]/approve/[approvalId]/+page.svelte
    // renders it twice, at :107 and :215, and was missed); a finding that does not
    // land here is a field nothing reads.
    expect(SOURCE).toContain('change_summary: changeSummary,');
    // Positive control: the OLD wiring must be gone, or this test passes on a
    // file where the notice is computed and then thrown away.
    expect(SOURCE).not.toContain('change_summary: body.summary ?? null');
  });

  test('a clean outline appends NOTHING — an empty scan is never rendered as a pass', () => {
    expect(SOURCE).toContain('constraintNotice === null');
    expect(SOURCE).toContain('? (body.summary ?? null)');
  });

  test('the scan cannot fail the outline delivery', () => {
    // A machine-authenticated webhook on the conveyor's critical path: an
    // advisory scan that throws must not lose the outline.
    const start = SOURCE.indexOf('let constraintNotice: string | null = null;');
    expect(start).toBeGreaterThan(-1);
    const region = SOURCE.slice(start, start + 900);
    expect(region).toContain('try {');
    expect(region).toContain('} catch (err) {');
    expect(region).toContain('console.warn(');
    // Positive control: the region really does contain the scan call, so the
    // try/catch assertions above are about THIS code and not some other block.
    expect(region).toContain('scanOutlineForContradictions(');
    expect(region).not.toMatch(/\bthrow\b/);
  });

  test('the scan is advisory: it does not gate the mint or change the outline status', () => {
    const scan = SOURCE.indexOf('scanOutlineForContradictions(');
    const mint = SOURCE.indexOf('.insert(approvals)');
    expect(scan).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(scan);
    // ⛔ No refusal, no status change, no roster change may be conditioned on it.
    expect(SOURCE).not.toMatch(/contradictionCount\s*>\s*0\s*\)\s*\{[^}]*return/);
    expect(SOURCE).not.toMatch(/constraintNotice[^\n]*\?[^\n]*'rejected'/);
    // The only status it may influence: none. `outline_proposed` is unconditional.
    expect(SOURCE).toContain("status: 'outline_proposed',");
  });

  test('the count is recorded on the audit trail (reader: routes/project-request-history.ts)', () => {
    expect(SOURCE).toContain('constraint contradiction(s) reported on the approval');
  });
});

describe('repo-access gate at submit (decision 2026-09-22)', () => {
  test('collects primary + repo.additional + repositories[] + table rows, deduped, primary first', () => {
    const urls = collectRequestRepoUrls(
      {
        repository_url: 'https://github.com/a/api',
        repo: {
          primary: { url: 'https://github.com/a/api' },
          additional: [{ url: 'https://github.com/a/web' }, { url: '  ' }],
        },
        repositories: [{ url: 'https://github.com/a/docs' }],
      },
      [
        { url: 'https://github.com/a/infra', is_primary: false, position: 2 },
        { url: 'https://github.com/a/web', is_primary: false, position: 1 },
      ],
    );
    expect(urls).toEqual([
      'https://github.com/a/api',
      'https://github.com/a/web',
      'https://github.com/a/docs',
      'https://github.com/a/infra',
    ]);
  });

  test('the CP sentinel is never sent to GitHub (its own 422 handles it)', () => {
    expect(collectRequestRepoUrls({ repository_url: FR_REPO_SENTINEL })).toEqual([]);
  });

  test('only public and private_granted pass; unknown/error/private_ungranted block', () => {
    expect([...READABLE_ACCESS_STATES]).toEqual(['public', 'private_granted']);
    const items = (
      ['public', 'private_granted', 'private_ungranted', 'error', 'unknown'] as const
    ).map((access_state) => ({ url: access_state, access_state, detail: '' }));
    expect(repoAccessBlockers(items).map((i) => i.access_state)).toEqual([
      'private_ungranted',
      'error',
      'unknown',
    ]);
  });

  test('the gate refuses BEFORE the submit write', () => {
    // The gate itself lives in project-request-repo-gate.ts (shared with approve);
    // the handler must consult it and return its refusal before writing.
    const start = SOURCE.indexOf('export async function handleSubmitProjectRequest');
    const gate = SOURCE.indexOf('repoAccessGateResponse(', start);
    const refuse = SOURCE.indexOf('if (denied) return denied;', gate);
    const write = SOURCE.indexOf("status: 'submitted',", start);
    expect(gate).toBeGreaterThan(start);
    expect(refuse).toBeGreaterThan(gate);
    expect(write).toBeGreaterThan(refuse);
  });
});
