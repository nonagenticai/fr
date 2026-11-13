import { describe, expect, test } from 'bun:test';
import { summarizeApprovalTarget } from '../../../src/routes/dashboard';

// UI review 2026-10-07: Home's "Recent activity" printed raw approval
// descriptions (JSON briefs, block reasons, procedure chains).
describe('summarizeApprovalTarget', () => {
  test('a JSON blob is replaced by the action name or kind, never echoed', () => {
    expect(summarizeApprovalTarget('{"brief":{"goal":"x"}}', 'generic', 'project.start')).toBe('project.start');
    expect(summarizeApprovalTarget('[{"a":1}]', 'execution.ready_signoff', null)).toBe('execution.ready_signoff');
    expect(summarizeApprovalTarget('{"a":1}', 'generic', null)).toBe('approval');
  });

  test('prose keeps its first line, without a [tag] prefix, capped', () => {
    expect(summarizeApprovalTarget('[ready-signoff] card 12: awaiting\nline two', null, null)).toBe(
      'card 12: awaiting',
    );
    const long = 'x'.repeat(200);
    const out = summarizeApprovalTarget(long, null, null);
    expect(out.length).toBe(118);
    expect(out.endsWith('…')).toBe(true);
  });

  test('empty description falls back', () => {
    expect(summarizeApprovalTarget(null, null, null)).toBe('approval');
    expect(summarizeApprovalTarget('   ', 'generic', '  ')).toBe('approval');
  });
});
