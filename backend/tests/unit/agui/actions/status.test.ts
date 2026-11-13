// Unit tests for status.summary + help.list_commands AG-UI actions.
//
// Focused on the parts that don't need the DB or planka stubbed: the
// slug cleaner (the gnarly free-text → token path) and the help text
// shape. The DB-and-kanban happy path is covered by a follow-up
// integration test that exercises a seeded project + getBoard mock —
// out of scope for this PR.

import { test, expect, describe } from 'bun:test';

import { cleanSlug, helpAction } from '../../../../src/agui/actions/status';
import type { ActionContext } from '../../../../src/agui/types';

describe('cleanSlug', () => {
  test('preserves a clean slug', () => {
    expect(cleanSlug('fr-test-verification')).toBe('fr-test-verification');
  });

  test('strips leading "of"', () => {
    expect(cleanSlug('of fr-test-verification')).toBe('fr-test-verification');
  });

  test('strips other natural-language stopwords', () => {
    expect(cleanSlug('the project for fr-test')).toBe('fr-test');
    expect(cleanSlug('about my fr-test thing')).toBe('my fr-test thing');
  });

  test('lowercases input', () => {
    expect(cleanSlug('FR-Test-Verification')).toBe('fr-test-verification');
  });

  test('collapses multi-token slugs', () => {
    expect(cleanSlug('  the  fr-test    project  ')).toBe('fr-test');
  });

  test('returns empty when only stopwords', () => {
    expect(cleanSlug('the of for project')).toBe('');
    expect(cleanSlug('    ')).toBe('');
  });
});

describe('help.list_commands', () => {
  test('registers under name "help.list_commands"', () => {
    expect(helpAction.name).toBe('help.list_commands');
  });

  test('returns text listing the chat verbs', async () => {
    const ctx = {
      userId: 'test-user',
      projectId: null,
      correlationId: 'cid-test',
      initiator: 'agent' as const,
      channel: 'telegram',
      tenantRoles: [],
    } satisfies ActionContext;
    const out = await helpAction.handler({}, ctx);
    expect(out.text).toContain('status');
    expect(out.text).toContain('approve');
    expect(out.text).toContain('reject');
    expect(out.text).toContain('yes');
    expect(out.text).toContain('no');
    expect(out.text).toContain('help');
    // A bare yes/no no longer decides anything (command-grammar refuses it): /help must not
    // promise it approves "your most recent pending request".
    expect(out.text).not.toContain('most recent pending');
    expect(out.text).toMatch(/yes \/ no\s+— not accepted on their own/);
    // fr-agui P0a: `start <type> <title>` is restored (it parks; `approve <id>` creates
    // through the one create door), and approve/reject name the APPROVAL id.
    expect(out.text).toContain('start <type> <title>');
    expect(out.text).toContain('approve <id>');
    expect(out.text).toContain('reject <id>');
    // The start line must not suggest a bare yes/no confirms it.
    const startLine = out.text.split('\n').find((l) => l.includes('start <type> <title>')) ?? '';
    expect(startLine).not.toMatch(/\byes\b|\bno\b/i);
  });
});
