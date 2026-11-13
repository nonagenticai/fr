import { describe, expect, it } from 'vitest';
import { hasData, panelSentence, sourceWords } from './panel';

describe('cockpit Panel envelope — plain words, never codes', () => {
  it('ok with data says nothing', () => {
    expect(panelSentence({ data: [1], as_of: 'x', health: 'ok' })).toBeNull();
    expect(hasData({ data: [1], as_of: 'x', health: 'ok' })).toBe(true);
  });
  it('down names the source in words and keeps the code out of the sentence', () => {
    const s = panelSentence({ data: null, as_of: null, health: 'down', detail_code: 'planka_upstream_unreachable' }, 'The board')!;
    expect(s).toContain("couldn't be loaded");
    expect(s).toContain('the board is not answering');
    expect(s).not.toMatch(/planka|UPSTREAM|upstream_unreachable/);
  });
  it('degraded with down_since says it is showing the last known value', () => {
    const s = panelSentence({ data: [1], as_of: '2026-10-25T10:00:00Z', health: 'degraded', down_since: '2026-10-25T10:05:00Z', detail_code: 'rm_timeout' })!;
    expect(s).toMatch(/^Showing what was known/);
    expect(s).toContain('requirements has not answered');
  });
  it('known codes have their own sentence; not-applicable is quiet', () => {
    expect(panelSentence({ data: { runs: [] }, as_of: 'x', health: 'degraded', detail_code: 'flow_data_not_connected' })).toBe('Flow data not connected yet.');
    const na = { data: null, as_of: 'x', health: 'ok' as const, detail_code: 'planka_no_board' };
    expect(panelSentence(na)).toBe('This project has no board.');
  });
  it('source words', () => {
    expect(sourceWords('conveyor_history_timeout')).toBe('the conveyor history');
    expect(sourceWords('fr_db_error')).toBe('the project database');
    expect(sourceWords(undefined)).toBeNull();
  });
});
