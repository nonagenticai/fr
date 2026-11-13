// tests/unit/kag-reviews-methods.test.ts
//
// A CONSISTENCY PIN, not a bug fix — and worth saying so plainly, because this
// file passes on `main` too.
//
// `kag-reviews.ts` used to branch on `req.method === 'HEAD'` when deciding
// whether to read a request body. That branch was unreachable from both
// directions: the route table registers the handler for five verbs (registry rows since P4d-2e) and HEAD is not
// one of them, and the kag gateway registers the same five
// (`kag/src/routers/reviews.py:165`), so a HEAD wired up on the fr side alone
// would have bought a 405 from the next hop. The branch was deleted rather than
// the verb registered.
//
// What this pins is the AGREEMENT. The failure mode it guards is one side
// growing a verb the other does not serve, which produces a route that exists in
// fr and 405s downstream — the kind of thing that is only noticed from a browser.
import { describe, expect, test } from 'bun:test';

/** The verbs the kag gateway serves on its reviews prefix. */
const GATEWAY_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

describe('the reviews prefix is registered for exactly the verbs the gateway serves', () => {
  test('the route table registers the same five verbs, and no HEAD', async () => {
    // P4d-2e: the rows are the capability registry's (capabilities/kag/reviews-passthrough.ts), not a
    // `for (const method of [...]) router.add(...)` loop in server.ts — read the registry's route rows,
    // which ARE the boot table (deriveRouter registers exactly capabilityRouteRows()).
    const { capabilityRouteRows } = await import('../../src/capabilities/derive-router');
    const registered = capabilityRouteRows()
      .filter((r) => r.path === '/api/assets/kag/reviews(.*)')
      .map((r) => r.method);
    expect(registered).toEqual([...GATEWAY_METHODS]);
    expect(registered).not.toContain('HEAD');
    // …and server.ts registers nothing of its own any more (no second, unreviewed list).
    const source = await Bun.file(new URL('../../src/server.ts', import.meta.url).pathname).text();
    expect(source).not.toContain("'/api/assets/kag/reviews(.*)'");
  });

  test('the handler carries no HEAD branch', async () => {
    const source = await Bun.file(
      new URL('../../src/routes/assets/kag-reviews.ts', import.meta.url).pathname,
    ).text();

    // Only the executable half of the file — the doc comments explain WHY there
    // is no HEAD arm, and must stay free to say the word.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // `HEAD` as an HTTP verb, not as the prefix of `HEADER` / `HEADERS` — the
    // file legitimately names `HEADER_BUDGET_MS` and `FORWARDED_*_HEADERS`.
    const verb = code.match(/HEAD(?!ER)/g);
    expect(verb, `kag-reviews.ts branches on HEAD: ${verb?.join(', ')}`).toBeNull();
  });
});
