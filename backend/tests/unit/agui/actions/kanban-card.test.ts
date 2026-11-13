import { test, expect, describe } from 'bun:test';
import type { ZodTypeAny } from 'zod';

import {
  createCardAction,
  pickIntakeListId,
} from '../../../../src/agui/actions/kanban-card';
import {
  registerAction,
  InvalidActionApprovalError,
} from '../../../../src/agui/registry';
import type { AgentCallableAction } from '../../../../src/agui/types';

describe('kanban.create_card (action shape)', () => {
  test('registers under name "kanban.create_card"', () => {
    expect(createCardAction.name).toBe('kanban.create_card');
  });

  test('input schema requires non-empty title', () => {
    const r = (createCardAction.input as ZodTypeAny).safeParse({
      project_ref: 'p',
      title: '',
    });
    expect(r.success).toBe(false);
  });

  test('input schema requires non-empty project_ref', () => {
    const r = (createCardAction.input as ZodTypeAny).safeParse({
      project_ref: '',
      title: 'x',
    });
    expect(r.success).toBe(false);
  });

  // The handler calls `plankaClient.cards.create` — it MUTATES. `kind` is what
  // decides whether registry.ts applies the approval gate at all, so a `read`
  // label here is not a naming preference, it is the gate being skipped. These
  // tests previously asserted `kind === 'read'` / `approval.type === 'auto'`,
  // i.e. they pinned the defect as the spec.
  test('action kind is write (the handler creates a Planka card)', () => {
    expect(createCardAction.kind).toBe('write');
  });

  test('approval is single-approver/initiator, not auto', () => {
    expect(createCardAction.approval).toEqual({
      type: 'single-approver',
      approver: 'initiator',
    });
  });

  test('opts into autoApproveForInitiator so a human invoke queues no row', () => {
    expect(createCardAction.autoApproveForInitiator).toBe(true);
  });

  // `approver: 'project-owner'` would throw ProjectOwnerRequiredError here:
  // channels/index.ts builds its ActionContext with `projectId: null`.
  test('does not depend on a projectId the channel dispatcher never sets', () => {
    expect(createCardAction.approval).not.toEqual({
      type: 'single-approver',
      approver: 'project-owner',
    });
  });
});

describe('kanban.create_card — the registry write-gate actually applies', () => {
  test('registerAction rejects this action if its policy is downgraded to auto', () => {
    // The same action with `approval: {type:'auto'}` must be REFUSED.
    // That refusal only happens on the `kind === 'write'` branch of
    // registerAction, so this goes green only while the label is `write`.
    expect(() =>
      registerAction({
        ...createCardAction,
        name: 'kanban.create_card_autoprobe',
        approval: { type: 'auto' },
      } as AgentCallableAction<unknown, unknown>),
    ).toThrow(InvalidActionApprovalError);
  });

});

describe('pickIntakeListId', () => {
  test('returns the lowest-position list id', () => {
    expect(
      pickIntakeListId([
        { id: 'mid', name: 'DOING', position: 65535 },
        { id: 'first', name: 'TODO', position: 0 },
        { id: 'last', name: 'DONE', position: 999999 },
      ]),
    ).toBe('first');
  });

  test('treats missing position as +Infinity', () => {
    expect(
      pickIntakeListId([
        { id: 'a', name: 'TODO', position: undefined },
        { id: 'b', name: 'DOING', position: 0 },
      ]),
    ).toBe('b');
  });

  test('skips lists without an id', () => {
    expect(
      pickIntakeListId([
        { name: 'TODO', position: 0 },
        { id: 'b', name: 'DOING', position: 1 },
      ]),
    ).toBe('b');
  });

  test('returns null for empty list array', () => {
    expect(pickIntakeListId([])).toBeNull();
  });
});
