// tests/unit/services/catalogue/rm-project-authority.test.ts
//
// R345 + R351 (6): RM `pm_projects` is the authority for an fr project's RM id
// and its board. fr resolves the row by origin_project_id (RM holds at most one
// per tenant: UNIQUE(tenant_id, origin_project_id)), stores no RM id, and keeps
// `projects.planka_board_id` only as a cache written from RM's answer.
//
// Pure logic over RM-shaped rows (domain input, not a replaced transport), plus
// the create's board link refusing BEFORE any network call. No test doubles.
import { describe, expect, test } from 'bun:test';

import type { PmProjectRow } from '../../../../src/integrations/pm';
import {
  boardCacheUpdate,
  isRmProjectMissing,
  pmProjectOf,
  RM_PROJECT_MISSING,
} from '../../../../src/services/catalogue/project-state';
import { linkBoardInRm } from '../../../../src/services/rm-board-link';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FR = '22222222-2222-4222-8222-222222222222';
const OTHER_FR = '33333333-3333-4333-8333-333333333333';

const row = (id: string, origin: string | null, extra: Partial<PmProjectRow> = {}): PmProjectRow =>
  ({ id, title: 't', origin_kind: 'project', origin_project_id: origin, ...extra }) as PmProjectRow;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('pmProjectOf: THE row is the one RM holds for the fr project id', () => {
  test('picks the row whose origin_project_id is the fr project id, among the tenant list', () => {
    const rows = [row('rm-other', OTHER_FR), row('rm-own', FR), row('rm-none', null)];
    expect(pmProjectOf({ id: FR }, TENANT, rows).id).toBe('rm-own');
  });

  test('a stale project_data.rm_pm_project_id is NOT read: RM answers', () => {
    const project = { id: FR, project_data: { keycloak_tenant_id: TENANT, rm_pm_project_id: 'rm-stale' } };
    expect(pmProjectOf(project, TENANT, [row('rm-stale', OTHER_FR), row('rm-own', FR)]).id).toBe('rm-own');
  });

  test('no row of that origin ⇒ 409 rm_project_missing (and isRmProjectMissing says so)', () => {
    const err = thrown(() => pmProjectOf({ id: FR }, TENANT, [row('rm-other', OTHER_FR)]));
    expect((err as { statusCode?: number }).statusCode).toBe(409);
    expect((err as { code?: string }).code).toBe(RM_PROJECT_MISSING);
    expect(isRmProjectMissing(err)).toBe(true);
  });

  test('CONTROL: isRmProjectMissing is false for any other error', () => {
    expect(isRmProjectMissing(new Error('rm down'))).toBe(false);
    expect(isRmProjectMissing(Object.assign(new Error('x'), { code: 'UPSTREAM_UNREACHABLE' }))).toBe(false);
  });
});

describe("boardCacheUpdate: the board-id cache follows RM's answer only", () => {
  test('cache NULL, RM holds a board ⇒ write RM board + Planka project', () => {
    expect(boardCacheUpdate({ id: FR, planka_board_id: null }, { planka_board_id: 'b-rm', planka_project_id: 'p-rm' })).toEqual({
      planka_board_id: 'b-rm',
      planka_project_id: 'p-rm',
    });
  });

  test('cache differs from RM ⇒ RM wins', () => {
    expect(boardCacheUpdate({ id: FR, planka_board_id: 'b-old' }, { planka_board_id: 'b-rm', planka_project_id: null })).toEqual({
      planka_board_id: 'b-rm',
    });
  });

  test('cache already equals RM ⇒ no write', () => {
    expect(boardCacheUpdate({ id: FR, planka_board_id: 'b-rm' }, { planka_board_id: 'b-rm', planka_project_id: 'p' })).toBeNull();
  });

  test('RM holds no board ⇒ the cache is never cleared or invented', () => {
    expect(boardCacheUpdate({ id: FR, planka_board_id: 'b-fr' }, { planka_board_id: null, planka_project_id: null })).toBeNull();
  });

  test('the caller passed no cached value ⇒ nothing to compare, no write', () => {
    expect(boardCacheUpdate({ id: FR }, { planka_board_id: 'b-rm', planka_project_id: null })).toBeNull();
  });
});

describe("the create's in-transaction board link fails loudly (never log-and-continue)", () => {
  const lists = { TODO: 'l1', READY: 'l2', DOING: 'l3', QA: 'l4', DONE: 'l5', BLOCKED: 'l6' };
  const target = { tenantId: TENANT, rmPmProjectId: 'rm-own', plankaProjectId: 'p', plankaBoardId: 'b' };

  test('a board missing a conveyor list throws before anything is sent', async () => {
    const { BLOCKED: _b, ...five } = lists;
    await expect(linkBoardInRm({ ...target, listIds: five })).rejects.toThrow('has no BLOCKED list(s)');
  });

  test('RM unreachable ⇒ the link THROWS (the create rolls back), it is not swallowed', async () => {
    let err: unknown;
    try {
      await linkBoardInRm({ ...target, listIds: lists });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toMatch(/^UPSTREAM_/);
  });
});
