import { describe, expect, test } from 'vitest';
import { deliveredPrsFromApprovals, firstLine } from './delivered-prs';

describe('deliveredPrsFromApprovals', () => {
  test('one entry per distinct pr_url, first approval wins, first line of description', () => {
    const prs = deliveredPrsFromApprovals([
      { id: 'a1', description: '\n  Ship login\nmore detail', metadata: { pr_url: 'https://github.com/o/r/pull/1' } },
      { id: 'a2', description: 'Second gate on same PR', metadata: { pr_url: 'https://github.com/o/r/pull/1 ' } },
      { id: 'a3', description: 'Other', metadata: { pr_url: 'https://github.com/o/r/pull/2' } },
    ]);
    expect(prs).toEqual([
      { url: 'https://github.com/o/r/pull/1', summary: 'Ship login', approvalId: 'a1' },
      { url: 'https://github.com/o/r/pull/2', summary: 'Other', approvalId: 'a3' },
    ]);
  });

  test('ignores missing, non-string and non-http pr_url values', () => {
    expect(
      deliveredPrsFromApprovals([
        { id: 'a', description: 'x', metadata: null },
        { id: 'b', description: 'x', metadata: { pr_url: 42 } },
        { id: 'c', description: 'x', metadata: { pr_url: 'javascript:alert(1)' } },
        { id: 'd', description: 'x' },
      ]),
    ).toEqual([]);
  });

  test('firstLine of empty / null is empty', () => {
    expect(firstLine(null)).toBe('');
    expect(firstLine('  \n \n')).toBe('');
  });
});
