// tests/integration/bridge-list-drafts.integration.test.ts
//
// GET /api/tools/bridge/drafts — the listing that makes `/bridge` survive a
// refresh, and the scope that keeps it from becoming an enumeration hole.
//
// WHAT WAS BROKEN. There was no list route at all. `/bridge` is a bulk-review
// surface and its only source of rows was an in-memory selection store, so a
// page refresh set `drafts = []` and silently destroyed in-progress work, and
// the detail page's "← All drafts" link led into the same dead end.
//
// WHY THE SCOPE IS NARROWER THAN `handleGetDraft`. The point-read scopes by
// `project_id` alone. Nothing in `buildBridgeCtx` checks project MEMBERSHIP —
// it authenticates the caller and validates the id's shape, nothing more. For
// a point read of a uuid the caller already holds that is defensible; for a
// LISTING it would turn "can name a project" into "can enumerate that
// project's drafts". So the listing takes BOTH identity keys from the
// authenticated context, exactly as `scopedFilters`
// (domain/bridge/caller-scope.ts) does for the outputs listing — the file's
// other LIST route, and the one this route's gating is copied from.
//
// ⛔ Uses `createDbSuite` / `itDb`. A hand-rolled `if (!reachable) return;`
// probe reports `N pass, 0 expect()` when Postgres is missing, which is the
// exact defect fr#1006 existed to kill.

import { describe, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { sql as drizzleSql } from 'drizzle-orm';

import { db, projects, queryClient } from '../../src/db/client';
import { cardDrafts } from '../../src/db/schema';
import { handleListDrafts } from '../../src/routes/tools/bridge';
import { handleError } from '../../src/utils/errors';

import { createDbSuite } from './helpers/db-suite';

const sql = queryClient;

process.env.AUTH_BYPASS = 'true';

const BASE = 'http://test';

// The AUTH_BYPASS identity — this is who the route believes is calling.
const SELF_ID = '00000000-0000-0000-0000-000000000000';
// A DIFFERENT user, drafting inside the SAME project. The row that proves the
// scope is (project, drafter) and not project alone.
const OTHER_USER_ID = '00000000-0000-4000-8000-bccc0000c002';

const PROJECT_A = '00000000-0000-4000-8000-bccc0000e001';
const PROJECT_B = '00000000-0000-4000-8000-bccc0000e002';
const ALL_TEST_PROJECTS = [PROJECT_A, PROJECT_B];
const OWNER_ID = SELF_ID;

let reachable = false;

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM card_drafts LIMIT 1`;
    await sql`SELECT 1 FROM projects LIMIT 1`;
    reachable = true;
  } catch {
    return;
  }
  for (const id of ALL_TEST_PROJECTS) {
    await db.execute(drizzleSql`DELETE FROM projects WHERE id = ${id}`);
    await db.insert(projects).values({
      id,
      owner_id: OWNER_ID,
      name: `bridge-list-drafts-${id.slice(-4)}`,
      repository_url: 'https://example.invalid/test.git',
      // H5: bridge routes load the project tenant-scoped (by this tag).
      project_data: { keycloak_tenant_id: SELF_ID },
    });
  }
});

afterAll(async () => {
  if (!reachable) return;
  for (const id of ALL_TEST_PROJECTS) {
    await db.execute(
      drizzleSql`DELETE FROM card_drafts WHERE project_id = ${id}`,
    );
    await db.execute(drizzleSql`DELETE FROM projects WHERE id = ${id}`);
  }
});

beforeEach(async () => {
  if (!reachable) return;
  for (const id of ALL_TEST_PROJECTS) {
    await db.execute(
      drizzleSql`DELETE FROM card_drafts WHERE project_id = ${id}`,
    );
  }
});

interface SeedOpts {
  id: string;
  project_id: string;
  drafter_id?: string;
  status?: string;
  created_at?: Date;
}

async function seedDraft(o: SeedOpts): Promise<void> {
  await db.insert(cardDrafts).values({
    id: o.id,
    project_id: o.project_id,
    drafter_id: o.drafter_id ?? SELF_ID,
    initiator: 'user',
    producer: 'coding',
    run_id: 'run-test',
    output_id: `out-${o.id.slice(-4)}`,
    stable_id: `stable-${o.id.slice(-4)}`,
    content_digest: `digest-${o.id.slice(-4)}`,
    title: `title-${o.id.slice(-4)}`,
    body_md: 'seed-body',
    labels: [],
    status: o.status ?? 'editing',
    metadata: {},
    ...(o.created_at ? { created_at: o.created_at } : {}),
  });
}

/**
 * The wire body. `{ items }` — the sanctioned UNPAGINATED-LIST envelope.
 *
 * ⚠️ NOT `{ data, meta }` (what this route first shipped) and NOT
 * `{ items, total }`. fr's response-envelope convention
 * sanctions only `data` / `items+total` / `items` / `array` for a NEW route,
 * and of those only `{ items }` can be honest here: the handler runs no COUNT
 * query, so a `total` could only ever be `items.length` — the PAGE SIZE
 * reported as the match count, which is the defect being removed from ~10
 * other routes. The truncation signal therefore rides in RESPONSE HEADERS,
 * exactly as `src/routes/assets/_lib/page-cap.ts` already does.
 *
 * `data` and `meta` are declared here so the assertions below can prove they
 * are ABSENT — a body that still carried them would re-break the ratchet.
 */
interface ListEnvelope {
  items?: { id: string }[];
  data?: unknown;
  meta?: unknown;
  error?: { code?: string };
}

function draftId(n: number): string {
  return `00000000-0000-4000-8000-bccc0000f0${String(n).padStart(2, '0')}`;
}

async function listDrafts(query: string): Promise<{
  status: number;
  body: ListEnvelope;
  headers: Headers;
}> {
  // Asserted THROUGH `handleError`, never by catching a throw. The guards that
  // run BEFORE `handle()` (project_id presence/shape, `limit` parsing) throw
  // rather than return, exactly as every sibling route in this file does — the
  // router is what converts them. Reproducing that conversion here is the only
  // way the assertion describes what a CLIENT receives.
  let res: Response;
  try {
    res = await handleListDrafts(
      new Request(`${BASE}/api/tools/bridge/drafts?${query}`),
    );
  } catch (err) {
    res = handleError(err);
  }
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : {},
    // The page-cap signal lives here, not in the body. `handleError` builds a
    // FRESH Response, so a failed read carries none of these — which is what
    // makes "no rows" and "no answer" distinguishable from the headers alone.
    headers: res.headers,
  };
}

/**
 * Every `fr.bridge.drafts.listed` span line written while `fn` runs.
 *
 * `emitSpan` (src/telemetry/spans.ts) writes one JSON line per lifecycle event
 * to stdout — `start` and `ok` to console.log, a >=400 finish to console.error.
 * Capturing them is the only way to assert what TEMPO will show, short of
 * standing up a collector, and the attributes are the thing under test.
 */
async function captureSpans<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; lines: Record<string, unknown>[] }> {
  const origLog = console.log;
  const origErr = console.error;
  const lines: Record<string, unknown>[] = [];
  const sink = (entry: unknown) => {
    if (typeof entry !== 'string' || !entry.startsWith('{')) return;
    try {
      const parsed = JSON.parse(entry) as Record<string, unknown>;
      if (parsed.telemetry === 'span') lines.push(parsed);
    } catch {
      // Not a span line; the route logs other things too.
    }
  };
  console.log = sink;
  console.error = sink;
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

const { itDb } = createDbSuite('bridge-list-drafts');

describe('GET /api/tools/bridge/drafts — scope', () => {
  itDb('a user sees their OWN drafts in their OWN project', async () => {
    await seedDraft({ id: draftId(1), project_id: PROJECT_A });
    await seedDraft({ id: draftId(2), project_id: PROJECT_A });

    const { status, body, headers } = await listDrafts(
      `project_id=${PROJECT_A}`,
    );

    expect(status).toBe(200);
    const ids = (body.items ?? []).map((d) => d.id).sort();
    expect(ids).toEqual([draftId(1), draftId(2)]);
    expect(body.items).toHaveLength(2);
    // ⭐ THE ENVELOPE ITSELF, pinned from the client's side: this reads the
    // BYTES, so a body that grew a `meta` back reds here.
    expect(Object.keys(body).sort()).toEqual(['items']);
    expect(headers.get('X-Count-State')).toBe('exact');
  });

  itDb('a user does NOT see another PROJECT’s drafts', async () => {
    await seedDraft({ id: draftId(3), project_id: PROJECT_A });
    // Same user, different project. Must not leak into project A's listing.
    await seedDraft({ id: draftId(4), project_id: PROJECT_B });

    const { body } = await listDrafts(`project_id=${PROJECT_A}`);

    const ids = (body.items ?? []).map((d) => d.id);
    expect(ids).toEqual([draftId(3)]);
    expect(ids).not.toContain(draftId(4));
  });

  itDb(
    'a user does NOT see another USER’s drafts in the SAME project',
    async () => {
      // ⭐ THE MUTATION THIS KILLS: dropping the `drafter_id` predicate — i.e.
      // copying `handleGetDraft`'s project-only scope into the listing —
      // leaves this row visible and only this test notices.
      await seedDraft({ id: draftId(5), project_id: PROJECT_A });
      await seedDraft({
        id: draftId(6),
        project_id: PROJECT_A,
        drafter_id: OTHER_USER_ID,
      });

      const { body } = await listDrafts(`project_id=${PROJECT_A}`);

      const ids = (body.items ?? []).map((d) => d.id);
      expect(ids).toContain(draftId(5));
      expect(ids).not.toContain(draftId(6));
      expect(ids).toHaveLength(1);
    },
  );

  itDb(
    'identity in the QUERY STRING is IGNORED — it comes from the authenticated ctx',
    async () => {
      // ⭐ THE GUARD THE DESIGN ARGUES HARDEST FOR, AND IT WAS UNPINNED. Every
      // test above proves the two PREDICATES are applied; none of them proved
      // where the VALUES come from, because they all call the route with no
      // identity in the query at all. An auditor added ONE line to
      // `handleListDrafts` —
      //     user_id: url.searchParams.get('drafter_id') ?? ctx.user_id
      // — turning `?drafter_id=<Bob>` into "read Bob's unsubmitted drafts", and
      // this suite stayed 8 pass / 25 expect(), fully green. The scope comment
      // in `domain/bridge/drafts.ts :: list` says "both taken from the
      // authenticated BridgeCtx by the caller, never from the request"; this is
      // the test that makes that sentence falsifiable.
      //
      // The titles are the payload that matters: these are UNSUBMITTED drafts,
      // so a leak here is somebody's half-written work, not a bare id.
      await seedDraft({ id: draftId(14), project_id: PROJECT_A });
      await seedDraft({
        id: draftId(15),
        project_id: PROJECT_A,
        drafter_id: OTHER_USER_ID,
      });

      // Both spellings, because a mutant could read either key. `user_id` is the
      // one `scopedFilters` (domain/bridge/caller-scope.ts) exists to override
      // on the OUTPUTS listing after the same hole was found there.
      const spoofed = await listDrafts(
        `project_id=${PROJECT_A}&drafter_id=${OTHER_USER_ID}&user_id=${OTHER_USER_ID}`,
      );

      // A 200, not a 400 — the point is that the parameter is INERT, not that
      // it is rejected. A route that 400s on an unknown key would pass a
      // "did not leak" assertion while telling us nothing about identity source.
      expect(spoofed.status).toBe(200);
      const spoofedIds = (spoofed.body.items ?? []).map((d) => d.id);
      expect(spoofedIds).toEqual([draftId(14)]);
      expect(spoofedIds).not.toContain(draftId(15));
      // Nothing of the other user's row may appear ANYWHERE in the bytes —
      // stronger than checking `items`, and it survives an envelope change.
      expect(JSON.stringify(spoofed.body)).not.toContain(`title-${draftId(15).slice(-4)}`);
      expect(JSON.stringify(spoofed.body)).not.toContain(OTHER_USER_ID);

      // Control: the SAME request with no override returns the SAME single row.
      // Without this, a mutation that makes the listing return nothing at all
      // would satisfy every assertion above.
      const plain = await listDrafts(`project_id=${PROJECT_A}`);
      expect((plain.body.items ?? []).map((d) => d.id)).toEqual([draftId(14)]);
    },
  );

  itDb('the `status` filter narrows without widening the scope', async () => {
    await seedDraft({ id: draftId(7), project_id: PROJECT_A, status: 'editing' });
    await seedDraft({
      id: draftId(8),
      project_id: PROJECT_A,
      status: 'committed',
    });
    // Another user's *editing* draft must stay invisible even when the filter
    // is the one that matches it.
    await seedDraft({
      id: draftId(9),
      project_id: PROJECT_A,
      status: 'editing',
      drafter_id: OTHER_USER_ID,
    });

    const { body } = await listDrafts(`project_id=${PROJECT_A}&status=editing`);

    const ids = (body.items ?? []).map((d) => d.id);
    expect(ids).toEqual([draftId(7)]);
  });
});

describe('GET /api/tools/bridge/drafts — empty vs truncated vs failed', () => {
  itDb(
    'an EMPTY result is a 200 with an explicitly EXACT count, not an absence',
    async () => {
      const { status, body, headers } = await listDrafts(
        `project_id=${PROJECT_A}`,
      );

      expect(status).toBe(200);
      expect(body.items).toEqual([]);
      // The empty list is a MEASUREMENT: the caller is told it is exact, so a
      // UI may render "no drafts". Contrast with the failed read below, which
      // carries NO such header and therefore makes no claim at all.
      expect(headers.get('X-Count-State')).toBe('exact');
      expect(headers.get('X-Truncated')).toBe('false');
    },
  );

  itDb('a TRUNCATED page says so — and the boundary is not off by one', async () => {
    for (let i = 10; i <= 12; i += 1) {
      await seedDraft({ id: draftId(i), project_id: PROJECT_A });
    }

    const capped = await listDrafts(`project_id=${PROJECT_A}&limit=2`);
    expect(capped.body.items).toHaveLength(2);
    expect(capped.headers.get('X-Truncated')).toBe('true');
    expect(capped.headers.get('X-Count-State')).toBe('at_least');
    expect(capped.headers.get('X-Applied-Limit')).toBe('2');
    // A header a cross-origin browser cannot read is a signal that does not
    // exist, so the exposure list is part of the contract, not decoration.
    expect(capped.headers.get('Access-Control-Expose-Headers')).toContain(
      'X-Truncated',
    );

    // The control that pins the boundary: limit === the real count is NOT
    // truncated. Without it, `truncated = rows.length >= limit` also passes.
    const exact = await listDrafts(`project_id=${PROJECT_A}&limit=3`);
    expect(exact.body.items).toHaveLength(3);
    expect(exact.headers.get('X-Truncated')).toBe('false');
    expect(exact.headers.get('X-Count-State')).toBe('exact');
  });

  itDb(
    'a FAILED read is an error envelope — it never degrades to `data: []`',
    async () => {
      await seedDraft({ id: draftId(13), project_id: PROJECT_A });

      // A REAL read failure, not a bad request: the relation the query reads
      // is gone underneath it. Restored in `finally`, and this suite owns its
      // own database.
      let status: number;
      let body: ListEnvelope;
      let headers: Headers;
      await db.execute(
        drizzleSql`ALTER TABLE card_drafts RENAME TO card_drafts__listfail`,
      );
      try {
        ({ status, body, headers } = await listDrafts(
          `project_id=${PROJECT_A}`,
        ));
      } finally {
        await db.execute(
          drizzleSql`ALTER TABLE card_drafts__listfail RENAME TO card_drafts`,
        );
      }

      expect(status).toBeGreaterThanOrEqual(400);
      // The whole point: a caller can tell this apart from the empty result
      // above. No `items`, therefore nothing that can be rendered as "none" —
      // and no `X-Count-State`, so the client reports `unknown` rather than
      // upgrading silence to `exact`.
      expect(body.items).toBeUndefined();
      expect(headers!.get('X-Count-State')).toBeNull();
      expect(headers!.get('X-Truncated')).toBeNull();

      // The table really did come back — otherwise every later test in the
      // file would fail for an unrelated reason and this one would look fine.
      const rows = await db
        .select()
        .from(cardDrafts)
        .where(drizzleSql`project_id = ${PROJECT_A}`);
      expect(rows).toHaveLength(1);
    },
  );

  itDb('a nonsense `limit` is a 400, not a silent default', async () => {
    const { status, body } = await listDrafts(
      `project_id=${PROJECT_A}&limit=0`,
    );
    expect(status).toBe(400);
    expect(body.items).toBeUndefined();
  });

  itDb(
    'rows SHARING a created_at are still totally ordered — the `desc(id)` tiebreaker',
    async () => {
      // ⭐ WHY THE EXISTING TRUNCATION TESTS CANNOT COVER THIS.
      // `truncated = probed.length > limit` is order-INDEPENDENT: it counts rows,
      // so it is true for any ordering whatsoever. `desc(id)` therefore makes the
      // PAGE deterministic, not the FLAG correct, and no test in this file wrote
      // two rows sharing a `created_at` — so deleting `desc(cardDrafts.id)` from
      // `domain/bridge/drafts.ts :: list` survived the whole suite. Its own
      // comment states the stake: "a batch create writes N rows inside one
      // statement and they can share a timestamp, which makes the page boundary
      // non-deterministic and can drop or repeat a row" — and `create()` above it
      // does exactly that, inserting one row per `output_id` in a loop.
      //
      // ⚠️ INSERTED IN ASCENDING ID ORDER ON PURPOSE. With no tiebreaker,
      // Postgres's sort over three EQUAL keys leaves them in scan order, which
      // for a freshly-written heap is insertion order — i.e. ASCENDING. So the
      // mutant's most likely output is the exact reverse of what is asserted
      // here. Seeding in descending order would let the mutant pass by accident.
      const shared = new Date('2026-09-20T10:00:00.000Z');
      for (const n of [20, 21, 22]) {
        await seedDraft({ id: draftId(n), project_id: PROJECT_A, created_at: shared });
      }

      const { status, body } = await listDrafts(`project_id=${PROJECT_A}`);
      expect(status).toBe(200);
      const ids = (body.items ?? []).map((d) => d.id);
      // All three rows, and in ONE specific order — the id descending.
      expect(ids).toEqual([draftId(22), draftId(21), draftId(20)]);

      // ...and a capped page takes the TOP of that same order, which is the
      // consequence the tiebreaker actually protects: without it, which row
      // falls off the page is unspecified, so a client paging by re-reading can
      // see a row twice or never.
      const capped = await listDrafts(`project_id=${PROJECT_A}&limit=2`);
      expect((capped.body.items ?? []).map((d) => d.id)).toEqual([
        draftId(22),
        draftId(21),
      ]);
      expect(capped.headers.get('X-Truncated')).toBe('true');
    },
  );
});

describe('GET /api/tools/bridge/drafts — the span must report what it measured', () => {
  itDb(
    'fr.bridge.drafts.listed carries the REAL count and truncated flag',
    async () => {
      // ⛔ THE DEFECT. The span attributes were the literals `count: 0,
      // truncated: false`, and `emitSpan` reported them verbatim — so in Tempo
      // the truncation rate for this route read exactly 0% on every call
      // FOREVER, including on the truncated page below. That is not a missing
      // attribute; it is a MEASURED zero, which is the same absence-as-a-result
      // defect `X-Count-State` spends a paragraph refusing to ship on the wire,
      // shipped one layer over in telemetry by the same function.
      //
      // KILLS: re-hardcoding either attribute, and also reverting the completion
      // lines in `src/telemetry/spans.ts` to the PRE-CALL snapshot — until that
      // was fixed, a handler physically could not report a value it learned
      // while running, which is how the literals survived review here.
      for (let i = 30; i <= 32; i += 1) {
        await seedDraft({ id: draftId(i), project_id: PROJECT_A });
      }

      const capped = await captureSpans(() =>
        listDrafts(`project_id=${PROJECT_A}&limit=2`),
      );
      expect(capped.value.body.items).toHaveLength(2);

      const okLine = capped.lines.find(
        (l) => l.name === 'fr.bridge.drafts.listed' && l.status === 'ok',
      );
      expect(okLine).toBeDefined();
      const attrs = okLine!.attributes as Record<string, unknown>;
      expect(attrs.count).toBe(2);
      expect(attrs.truncated).toBe(true);
      expect(attrs.applied_limit).toBe(2);
      // The span and the header a client reads describe ONE request and must
      // never disagree about it.
      expect(String(attrs.truncated)).toBe(
        capped.value.headers.get('X-Truncated') ?? 'HEADER-ABSENT',
      );

      // The START line is a snapshot taken before anything was counted, so it
      // must carry NO count rather than a zero — `toOtelAttrs` drops null, so a
      // consumer sees the attribute absent and concludes "not measured" instead
      // of "measured zero". This is the assertion that stops a future author
      // "tidying" the opening values back to 0.
      const startLine = capped.lines.find(
        (l) => l.name === 'fr.bridge.drafts.listed' && l.status === 'start',
      );
      expect(startLine).toBeDefined();
      expect((startLine!.attributes as Record<string, unknown>).count).toBeNull();

      // Non-vacuity control: an UNtruncated page must report the other values,
      // or `count: 2 / truncated: true` could be two more literals.
      const whole = await captureSpans(() => listDrafts(`project_id=${PROJECT_A}`));
      const wholeOk = whole.lines.find(
        (l) => l.name === 'fr.bridge.drafts.listed' && l.status === 'ok',
      )!;
      const wholeAttrs = wholeOk.attributes as Record<string, unknown>;
      expect(wholeAttrs.count).toBe(3);
      expect(wholeAttrs.truncated).toBe(false);
    },
  );
});
