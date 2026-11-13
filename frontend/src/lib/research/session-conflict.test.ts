import { describe, expect, it } from 'vitest';
import { AssetError } from '$lib/api/assets';
import {
  corpusConflictNotice,
  sessionIdFromCorpusConflict,
} from './session-conflict';

const SESSION_ID = '019ffca5-38d3-7000-8000-000000000001';

const FULL_CONTEXT = {
  session_id: SESSION_ID,
  paper_count: 93,
  query_count: 43,
};

/**
 * The body discovery-engine actually returns (DE #66), kept whole.
 *
 * `null` means "the engine sent no `context` at all" — deliberately NOT
 * `undefined`, which a default parameter would silently replace with
 * `FULL_CONTEXT`. It did exactly that on the first run of this file, so the
 * older-engine case passed while testing the newest one.
 */
function deConflict(
  context: Record<string, unknown> | null = FULL_CONTEXT,
): AssetError {
  return new AssetError('upstream conflict', 409, 'UPSTREAM_CONFLICT', {
    error: {
      code: 'HTTP_409',
      message:
        `a session named 'tocilizumab covid-19 randomised' already exists ` +
        `(${SESSION_ID}) and holds 93 papers and 43 search queries. It was NOT ` +
        'created or emptied by this request. GET it if you meant to continue ' +
        'that corpus, or choose another name.',
      status: 409,
      ...(context === null ? {} : { context }),
    },
  });
}

describe('sessionIdFromCorpusConflict', () => {
  it('recovers the session the engine refused to create over', () => {
    expect(sessionIdFromCorpusConflict(deConflict())).toBe(SESSION_ID);
  });

  it('returns null when the engine sent no context, so the caller keeps degrading honestly', () => {
    // An older discovery-engine, before the refusal carried fields. The id is
    // still in the prose; we deliberately do not go looking for it there.
    expect(sessionIdFromCorpusConflict(deConflict(null))).toBeNull();
  });

  // NEGATIVE CONTROLS. Adopting a session is a WRITE to the user's working set,
  // so each of these must refuse rather than guess.

  it('refuses a non-409 that happens to carry a session_id', () => {
    const err = new AssetError('boom', 500, 'UPSTREAM_BAD_STATUS', {
      error: { context: { session_id: SESSION_ID } },
    });
    expect(sessionIdFromCorpusConflict(err)).toBeNull();
  });

  it('refuses a 409 from a route that is not this one', () => {
    // fr's own tenant_context_conflict is a 409 with no upstream body at all.
    const err = new AssetError('tenant mismatch', 409, 'tenant_context_conflict');
    expect(sessionIdFromCorpusConflict(err)).toBeNull();
  });

  it('refuses a blank or non-string session_id', () => {
    expect(sessionIdFromCorpusConflict(deConflict({ session_id: '' }))).toBeNull();
    expect(sessionIdFromCorpusConflict(deConflict({ session_id: '   ' }))).toBeNull();
    expect(sessionIdFromCorpusConflict(deConflict({ session_id: 42 }))).toBeNull();
  });

  it('refuses anything that is not an AssetError', () => {
    expect(sessionIdFromCorpusConflict(new Error('offline'))).toBeNull();
    expect(sessionIdFromCorpusConflict(null)).toBeNull();
    expect(sessionIdFromCorpusConflict(undefined)).toBeNull();
  });
});

describe('corpusConflictNotice', () => {
  it('tells the user what happened to their corpus, with its size', () => {
    const notice = corpusConflictNotice(deConflict());
    expect(notice).toContain('Continuing the discovery session');
    expect(notice).toContain('93 papers');
    expect(notice).toContain('43 searches');
    // It must not read as a failure — the search is about to succeed.
    expect(notice.toLowerCase()).not.toContain('error');
    expect(notice.toLowerCase()).not.toContain('failed');
  });

  it('singularises, because "1 papers" is how a reader learns the copy is generated', () => {
    const notice = corpusConflictNotice(
      deConflict({ session_id: SESSION_ID, paper_count: 1, query_count: 1 }),
    );
    expect(notice).toContain('1 paper from 1 search');
    expect(notice).not.toContain('1 papers');
  });

  it('states no size rather than a wrong one when the counts are missing', () => {
    const notice = corpusConflictNotice(
      deConflict({ session_id: SESSION_ID }),
    );
    expect(notice).toContain('Continuing the discovery session');
    expect(notice).not.toContain('It already holds');
    expect(notice).not.toContain('undefined');
    expect(notice).not.toContain('null');
  });

  it('rejects a stringified count rather than rendering an unchecked type', () => {
    const notice = corpusConflictNotice(
      deConflict({ session_id: SESSION_ID, paper_count: '93', query_count: 43 }),
    );
    expect(notice).not.toContain('93');
    expect(notice).toContain('43 searches');
  });

  it('is empty for an error it does not recognise, so nothing is rendered', () => {
    expect(corpusConflictNotice(new Error('offline'))).toBe('');
  });
});
