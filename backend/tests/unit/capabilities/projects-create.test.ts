// tests/unit/capabilities/projects-create.test.ts
//
// fr-agui SPEC §6 — the hermetic half of `projects.create` (the DB half, where
// the route and the channel handler both reach createSingleProject, was the
// projects-create integration suite, deleted 2026-10-29 under the
// no-test-doubles ruling — no longer in the suite):
//   - it is a WRITE that PARKS for an explicit `approve <id>` (no self-approve);
//   - its secret field is declared, and the agent's input schema has no slot for it;
//   - the channel create key is a stable UUIDv5 of (channel, sender, message).

import { describe, expect, test } from 'bun:test';
import type { ZodTypeAny } from 'zod';

import type { ActionContext } from '../../../src/agui/types';
import {
  channelCreateKey,
  createBodyFor,
  projectsCreateAction,
  uuidV5,
} from '../../../src/agui/actions/projects-create';

const ctx: ActionContext = {
  userId: 'u-1',
  projectId: null,
  correlationId: 'cid-1',
  initiator: 'human',
  channel: 'telegram',
  tenantId: '0195f48b-d000-7000-8000-00000000e0e1',
  tenantName: 'Acme',
};

describe('projects.create — declaration', () => {
  test('a write that parks (single-approver: the sender), never self-approved', () => {
    expect(projectsCreateAction.kind).toBe('write');
    expect(projectsCreateAction.approval).toEqual({ type: 'single-approver', approver: 'initiator' });
    expect(projectsCreateAction.autoApproveForInitiator).toBeUndefined();
    expect(projectsCreateAction.parking).toBeUndefined();
    expect(projectsCreateAction.cronSafe).toBe(false);
  });

  test('web: confirm card → POST /api/projects with an Idempotency-Key; no secret field (no per-project GitHub token)', () => {
    expect(projectsCreateAction.confirm).toEqual({
      http: { method: 'POST', path: '/api/projects' },
      card: 'project-create',
      idempotent: true,
    });
  });

  test('the agent input schema has no token slot (an extra key is stripped, not carried)', () => {
    const parsed = (projectsCreateAction.input as ZodTypeAny).parse({
      title: 'x',
      project_type: 'feature',
      github_access_token: 'ghp_x',
    });
    expect(parsed).toEqual({ title: 'x', project_type: 'feature' });
  });

  test('RBAC is the create route rule (custom), not a tenant-role string', () => {
    expect(projectsCreateAction.rbac?.type).toBe('custom');
  });

  test('the create body uses the door field names (title → name)', () => {
    expect(createBodyFor({ title: 'T', project_type: 'it', description: 'd' })).toEqual({
      name: 'T',
      project_type: 'it',
      description: 'd',
    });
  });

  test('a chosen approval_mode reaches the create body; absent stays absent (the engine defaults it)', () => {
    expect(createBodyFor({ title: 'T', project_type: 'it', approval_mode: 'all' })).toEqual({
      name: 'T',
      project_type: 'it',
      approval_mode: 'all',
    });
    expect('approval_mode' in createBodyFor({ title: 'T', project_type: 'it' })).toBe(false);
    expect((projectsCreateAction.input as ZodTypeAny).safeParse({ title: 'T', project_type: 'it', approval_mode: 'never' }).success).toBe(false);
  });

  test('the channel reply names the approval id for approve AND reject, and never suggests yes/no', () => {
    const text = projectsCreateAction.channelPendingText!({ title: 'T', project_type: 'it' }, ctx, 'APPROVAL-ID');
    expect(text).toBe(
      'Create it project "T" in Acme? Reply "approve APPROVAL-ID" to create it or "reject APPROVAL-ID" to cancel.',
    );
    expect(text).not.toMatch(/\byes\b|\bno\b/i);
  });
});

describe('channel create key (SPEC §6.3)', () => {
  test('UUIDv5: stable for the same (channel, sender, message), different otherwise', () => {
    const a = channelCreateKey(ctx);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(channelCreateKey({ ...ctx })).toBe(a);
    expect(channelCreateKey({ ...ctx, correlationId: 'cid-2' })).not.toBe(a);
    expect(channelCreateKey({ ...ctx, userId: 'u-2' })).not.toBe(a);
    expect(channelCreateKey({ ...ctx, channel: 'teams' })).not.toBe(a);
  });

  test('uuidV5 matches the RFC 4122 reference vector (DNS namespace, "www.example.com")', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });
});
