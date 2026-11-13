// Comment folding + PR-link parsing for the project page's conveyor history.
// Fixtures follow the shapes the conveyor flows WRITE (fenceJson in ct.*.json / sub.card_action.json),
// not live rows — see the provenance note in src/services/conveyor-history/comment-parse.ts.
import { describe, expect, test } from 'bun:test';
import {
  branchFromBlocks,
  extractPullRequestUrls,
  headShaFromBlocks,
  parseConveyorComment,
  tidyConveyorProse,
} from '../../../../src/services/conveyor-history/comment-parse';

const fence = (v: unknown) => '```json\n' + JSON.stringify(v, null, 2) + '\n```';

describe('parseConveyorComment', () => {
  test('a flow hand-off: kind + list from the block, the prose kept, the JSON folded', () => {
    const text = 'Hand-off from DOING, written by the flow.\n\n' + fence({ list: 'DOING', kind: 'handoff', commit_sha: 'a'.repeat(40) });
    const p = parseConveyorComment(text);
    expect(p.kind).toBe('handoff');
    expect(p.list).toBe('DOING');
    expect(p.text).toBe('Hand-off from DOING, written by the flow.');
    expect(p.text).not.toContain('```');
    expect(JSON.parse(p.data!)).toEqual({ list: 'DOING', kind: 'handoff', commit_sha: 'a'.repeat(40) });
    expect(p.summary).toBeNull();
  });

  test.each(['signoff', 'question', 'rework', 'stall', 'unblock_proposal'])('kind %s is recognised', (k) => {
    expect(parseConveyorComment(`x\n\n${fence({ kind: k, list: 'QA' })}`).kind).toBe(k as never);
  });

  test('a block-only comment gets a summary from its prose field', () => {
    const p = parseConveyorComment(fence({ kind: 'rework', list: 'QA', to_list: 'DOING', answer: 'Use the report artifact.' }));
    expect(p.text).toBe('');
    expect(p.summary).toBe('Use the report artifact.');
  });

  test('a block without a known kind is a record; no block is a plain comment', () => {
    expect(parseConveyorComment(fence({ list: 'QA', kind: 'qa_suite', passed: 6 })).kind).toBe('record');
    expect(parseConveyorComment(fence({ some: 'agent json' })).kind).toBe('record');
    const plain = parseConveyorComment('DOING finished.');
    expect(plain.kind).toBe('comment');
    expect(plain.data).toBeNull();
    expect(plain.text).toBe('DOING finished.');
  });

  test('malformed or unterminated JSON never throws and never leaks into the prose', () => {
    const bad = parseConveyorComment('Before.\n```json\n{ not json }\n```');
    expect(bad.kind).toBe('comment');
    expect(bad.text).toBe('Before.');
    const cut = parseConveyorComment('Before.\n```json\n{"kind":"handoff"');
    expect(cut.text).toBe('Before.');
    expect(parseConveyorComment(null).kind).toBe('comment');
  });
});

describe('extractPullRequestUrls', () => {
  test('finds the PR in prose and in JSON, de-duplicated', () => {
    const url = 'https://github.com/conveyor-coding/aa-feature-capstone-fixture/pull/2';
    const text = `Opened ${url}.\n\n` + fence({ kind: 'handoff', list: 'QA', pr_url: url, pr_number: 2 });
    const prs = extractPullRequestUrls(text);
    expect(prs).toEqual([{ url, owner: 'conveyor-coding', repo: 'aa-feature-capstone-fixture', number: 2 }]);
  });

  test('does not read /pull/23 as /pull/2, ignores non-PR GitHub links', () => {
    const prs = extractPullRequestUrls(
      'https://github.com/o/r/pull/23 https://github.com/o/r/issues/2 https://github.com/o/r/pull/2/files',
    );
    expect(prs.map((p) => p.number)).toEqual([23, 2]);
  });

  test('nothing to find → []', () => {
    expect(extractPullRequestUrls('no links here')).toEqual([]);
    expect(extractPullRequestUrls(undefined)).toEqual([]);
  });
});

describe('branch / head from blocks', () => {
  test('the latest block wins; a non-sha head is refused', () => {
    const blocks = [{ branch: 'old' }, { head_sha: 'abc1234', branch: 'feat/f4' }];
    expect(branchFromBlocks(blocks)).toBe('feat/f4');
    expect(headShaFromBlocks(blocks)).toBe('abc1234');
    expect(headShaFromBlocks([{ head_sha: 'not a sha' }])).toBeNull();
    expect(branchFromBlocks([])).toBeNull();
  });
});

describe('tidyConveyorProse (phrases taken from the live board 1893477746286265428)', () => {
  test.each([
    ['QA suite run, measured by the flow (merge evidence, R195).', 'QA suite run, measured by the flow.'],
    ['a bug fix needs bug_analysis first (R300)', 'a bug fix needs bug_analysis first'],
    [
      'capability plan (analysis before development per R300), and the approved sign-off 19a6a546-3f34-4a6b-9f06-bbac11c15057 cleared it.',
      'capability plan (analysis before development), and the approved sign-off cleared it.',
    ],
    ['the hand-off report (f6b675dc-b751-5525-7d59-51f7261d97aa) says', 'the hand-off report says'],
    [
      'The card 1893522441217508776 was delivered on branch conveyor/1893522441217508776.',
      'The card was delivered on branch conveyor/1893522441217508776.',
    ],
  ])('%s', (input, want) => {
    expect(tidyConveyorProse(input)).toBe(want);
  });

  test('parseConveyorComment shows tidied prose but keeps the raw record in data', () => {
    const p = parseConveyorComment('Saved as artifact 8aebd8fb-330d-620b-4b1b-40964ecedc12 (R213).\n\n' + fence({ kind: 'handoff', list: 'QA', artifact: '8aebd8fb-330d-620b-4b1b-40964ecedc12' }));
    expect(p.text).toBe('Saved as artifact.');
    expect(p.data).toContain('8aebd8fb-330d-620b-4b1b-40964ecedc12');
  });
});
