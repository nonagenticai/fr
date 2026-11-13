/**
 * AG-UI pm_catalogue.* registration shape (E-14 read coverage for
 * `integrations/pm-catalogue.ts`). Read-only, and every handler refuses a
 * caller with no resolved tenant instead of sending a frameless RM call.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import type { z } from 'zod';

import { getAction, listActions } from '../../../../src/agui/registry';
import { registerPmCatalogueActions } from '../../../../src/agui/actions/pm_catalogue';
import { RbacDeniedError } from '../../../../src/agui/rbac';
import type { ActionContext } from '../../../../src/agui/types';

const REQUIRED = [
  'pm_catalogue.get',
  'pm_catalogue.list',
  'pm_catalogue.project_type_card_types',
];

beforeAll(() => {
  registerPmCatalogueActions();
});

describe('pm_catalogue.* AG-UI registration', () => {
  test('registers exactly the read catalogue', () => {
    const names = listActions()
      .filter((a) => a.name.startsWith('pm_catalogue.'))
      .map((a) => a.name)
      .sort();
    expect(names).toEqual(REQUIRED);
  });

  test.each(REQUIRED)('%s is an auto-approved read', (name) => {
    const action = getAction(name);
    expect(action).toBeDefined();
    expect(action!.kind).toBe('read');
    expect((action!.approval as { type: string }).type).toBe('auto');
  });

  test('a caller with no resolved tenant is refused before any upstream call', async () => {
    const action = getAction('pm_catalogue.list')!;
    const ctx = { userId: 'u1' } as unknown as ActionContext;
    let caught: unknown = null;
    try {
      await action.handler({ resource: 'card-types' }, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(RbacDeniedError);
  });

  test('list input rejects a resource outside the allowlist', () => {
    const input = getAction('pm_catalogue.list')!.input as z.ZodTypeAny;
    expect(input.safeParse({ resource: 'not-a-resource' }).success).toBe(false);
    expect(input.safeParse({ resource: 'card-types', phase_id: 'p1' }).success).toBe(true);
  });
});
