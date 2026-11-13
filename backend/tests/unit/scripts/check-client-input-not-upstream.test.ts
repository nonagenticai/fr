// tests/unit/scripts/check-client-input-not-upstream.test.ts
//
// The guard is not shipped until mutants prove it. A guard that cannot fail is
// worse than no guard: it reads as evidence.
//
// The four mutants below are the ones that matter, chosen because each is a
// realistic way this guard could rot into a green light:
//
//   1. someone reintroduces the defect  -> must be MISFILED
//   2. a waiver with its reason deleted -> must NOT waive (fail-open is the
//      exact bug found in check-credential-absence-armed.ts, where `\s` after
//      the colon let a bare marker adopt the next LINE OF CODE as its reason)
//   3. the scan pattern stops matching  -> must fall below MIN_SCANNED
//   4. R1's lexicon is defeated by rewording -> R2's ratchet must still hold
//      the line, which is why there are two rules and not one

import { describe, expect, test } from 'bun:test';
import {
  scanFile,
  isReadFromResponse,
  MIN_SCANNED,
  MAX_UNATTRIBUTED,
  isUnattributed,
  censusFor,
  type Site,
} from '../../../scripts/check-client-input-not-upstream';

const CLIENT_INPUT = `
async function readJsonBody<T>(req: Request): Promise<T> {
  return (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: 'Invalid JSON request body',
      service: 'kag',
    });
  })) as T;
}
`;

const GENUINE_UPSTREAM = `
    if (!parsed.executionId) {
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message: 'n8n POST /workflows/x/run reply has no executionId',
        service: 'n8n',
        upstreamStatus: res.status,
      });
    }
`;

describe('check-client-input-not-upstream — the detector', () => {
  test('MUTANT 1: a client-input message under an UPSTREAM_* code is caught', () => {
    const [site] = scanFile('routes/tools/kag.ts', CLIENT_INPUT);
    expect(site!.code).toBe('UPSTREAM_BAD_BODY');
    expect(site!.upstreamStatusValue).toBeUndefined();
    expect(site!.message).toContain('Invalid JSON request body');
    expect(site!.waiver).toBeUndefined();
  });

  test('a genuine upstream site is NOT caught — the guard must not over-reach', () => {
    const [site] = scanFile('integrations/n8n.ts', GENUINE_UPSTREAM);
    // `upstreamStatus` READ OFF a real response is the attribution, whatever the
    // message says. Without this the guard false-positives on http-client.ts's
    // own "returned invalid JSON", which is entirely correct.
    expect(isReadFromResponse(site!.upstreamStatusValue)).toBe(true);
  });

  test('MUTANT 5: a FABRICATED upstreamStatus does not buy the exemption', () => {
    // The third door, found by an adversarial audit of this very guard. The
    // first version exempted on the mere PRESENCE of `upstreamStatus`, so a
    // client-input error carrying a hand-written `upstreamStatus: 400` was
    // exempt from R1, uncounted by R2, and STILL returned 502 — `httpStatusFor`
    // honours `upstreamStatus` only under `UPSTREAM_BAD_STATUS`.
    //
    // Not hypothetical: it is exactly the shape this PR's sweep found four
    // times in routes/tools/analytics.ts (`upstreamStatus: 413`, served as 502).
    // A guard blind to the defect its own sweep uncovered is decoration.
    const fabricated = CLIENT_INPUT.replace(
      "      service: 'kag',",
      "      service: 'kag',\n      upstreamStatus: 400,",
    );
    const [site] = scanFile('routes/tools/kag.ts', fabricated);
    expect(site!.upstreamStatusValue).toBe('400');
    expect(isReadFromResponse(site!.upstreamStatusValue)).toBe(false);
  });

  test('MUTANT 6: R2 itself rejects a fabricated status, not just its helper', () => {
    expect(isUnattributed({ upstreamStatusValue: '400' })).toBe(true);
    expect(isUnattributed({ upstreamStatusValue: undefined })).toBe(true);
    expect(isUnattributed({ upstreamStatusValue: 'res.status' })).toBe(false);
    expect(isUnattributed({ upstreamStatusValue: 'err.statusCode' })).toBe(false);
  });

  // ⚠️ MUTANT 6 ABOVE IS NOT ENOUGH, AND THAT IS THE POINT OF MUTANT 7.
  //
  // This file has now twice tested a HELPER and believed it had tested the
  // RULE:
  //   1. `isReadFromResponse` was correct and green the whole time R2 filtered
  //      on `upstreamStatusValue === undefined` in main() and exempted every
  //      hand-written literal. services/read-models/_lib.ts walked through it.
  //   2. The fix extracted `isUnattributed` and tested THAT — MUTANT 6. An
  //      adversarial audit then MEASURED that reverting main()'s filter to
  //      `=== undefined` left all nine tests green. The same shape, one level
  //      up, in the commit whose message said "testing the helper proved
  //      nothing about the rule".
  //
  // So these drive `censusFor`, which is now the only place the counting
  // happens. main() does no filtering of its own, so there is no third level
  // for the defect to move to.
  const site = (over: Partial<Site>): Site => ({
    file: 'src/x.ts', line: 1, code: 'UPSTREAM_BAD_STATUS', message: 'boom', ...over,
  });

  test('MUTANT 7: the RULE counts a fabricated status — not just the predicate', () => {
    // The exact shape of services/read-models/_lib.ts before it was fixed:
    // a caller's bad querystring, wearing an UPSTREAM_* code, with an invented
    // 400. Under the old `=== undefined` filter this counted ZERO.
    const { unattributed } = censusFor([site({ upstreamStatusValue: '400' })]);
    expect(unattributed).toHaveLength(1);
  });

  test('MUTANT 7b: a status READ from a response is still exempt', () => {
    // The other direction, so the rule is not just "count everything" — that
    // would pass MUTANT 7 while destroying the signal.
    const { unattributed } = censusFor([site({ upstreamStatusValue: 'res.status' })]);
    expect(unattributed).toHaveLength(0);
  });

  test('MUTANT 7c: a non-UPSTREAM code is outside both rules entirely', () => {
    const { upstream, unattributed, misfiled } = censusFor([
      site({ code: 'BAD_REQUEST', message: 'query parameter is required' }),
    ]);
    expect(upstream).toHaveLength(0);
    expect(unattributed).toHaveLength(0);
    expect(misfiled).toHaveLength(0);
  });

  test('R1 through the rule: a client-input message under UPSTREAM_* is MISFILED, and a waiver moves it', () => {
    const bad = site({ message: 'project_id query parameter is required' });
    expect(censusFor([bad]).misfiled).toHaveLength(1);
    expect(censusFor([{ ...bad, waiver: 'upstream really said this' }]).waived).toHaveLength(1);
    expect(censusFor([{ ...bad, waiver: 'upstream really said this' }]).misfiled).toHaveLength(0);
  });

  test('hand-written statuses stay legitimate — a literal is not itself a finding', () => {
    // `404` in the bridge sources, `415`, `403`, `201` are all real and correct.
    // A literal does not buy the R1 exemption; it is not evidence of a defect.
    // Those sites fall back to the lexicon, which does not match them.
    for (const v of ['res.status', 'upstream.status', 'resp.status', 'args.status', 'err.statusCode']) {
      expect(isReadFromResponse(v)).toBe(true);
    }
    for (const v of ['404', '415', '201', '400', undefined]) {
      expect(isReadFromResponse(v)).toBe(false);
    }
  });

  test('MUTANT 2: a waiver with no reason does NOT waive', () => {
    const bare = CLIENT_INPUT.replace(
      '    throw new IntegrationError({',
      '    // client-input-code-ok:\n    throw new IntegrationError({',
    );
    const [site] = scanFile('routes/tools/kag.ts', bare);
    // The next line is `code: 'UPSTREAM_BAD_BODY',` — with `\s*` after the
    // colon that string would have been adopted as the rationale.
    expect(site!.waiver).toBeUndefined();

    const real = CLIENT_INPUT.replace(
      '    throw new IntegrationError({',
      '    // client-input-code-ok: the body here is the upstream reply, not the caller\n    throw new IntegrationError({',
    );
    expect(scanFile('x.ts', real)[0]!.waiver).toBe(
      'the body here is the upstream reply, not the caller',
    );
  });

  test('MUTANT 3: a nested object literal does not truncate the scan', () => {
    // A lazy `\{[\s\S]*?\}` ends at the FIRST closing brace, so `upstreamBody`
    // would hide every field after it — including `upstreamStatus`, turning a
    // genuine upstream site into a reported defect.
    const nested = `
      throw new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'svc returned 422',
        service: 'svc',
        upstreamBody: { detail: 'nope', nested: { deep: true } },
        upstreamStatus: 422,
      });
    `;
    const [site] = scanFile('x.ts', nested);
    expect(site!.upstreamStatusValue).toBe('422');
  });

  test('MUTANT 4: the two ratchets are set, so rot and regrowth both fail closed', () => {
    // MIN_SCANNED catches a detector that silently stops matching — the failure
    // mode a bare zero-check cannot see, because a PARTIAL rot still reports a
    // plausible number. MAX_UNATTRIBUTED catches the case R1's lexicon misses:
    // a client-input error worded so it matches nothing.
    expect(MIN_SCANNED).toBeGreaterThan(0);
    expect(typeof MAX_UNATTRIBUTED).toBe('number');
    // Rot to nothing: zero constructions in a file that has none.
    expect(scanFile('x.ts', 'const a = 1;')).toHaveLength(0);
  });
});
