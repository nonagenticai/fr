// tests/integration/reviews-whole-chain.manual.ts
//
// ⚠️ DELIBERATELY named without `.test.ts`/`.spec.ts`, and run with an
// explicit `./` path (see "Running it" below) rather than bare `bun test`.
// It is a local-only harness, not part of any CI test lane.
// That ratchet exists for tests CI COULD run but currently does not (stale
// fixtures, product gaps); this file needs `uv`, a local Postgres superuser,
// and sibling `kag`/`evidence_review_service` checkouts that will never exist
// on a hosted runner, exactly the same category `frontend/e2e/README.md`
// documents for the `dev-cluster` Playwright lane ("In CI: no"). Naming it
// this way keeps that ratchet honest — a file it was never designed to
// police — instead of spending one of its shrink-only slots on a test that
// was never going to run there.
//
// The chain nothing in the estate drives end to end: frontend client shapes ->
// fr's `/api/assets/kag/reviews/*` proxy -> the kag gateway's `/reviews/*`
// router -> Evidence Review's real `/api/reviews/*` mount.
//
// ## Why this file exists
//
// `evidence_review_service`'s E2E-002/E2E-003 drive Evidence Review's own API
// directly with an in-process `TestClient` — one hop. `fr/frontend`'s
// `research-screening*.spec.ts` drive the UI through a REAL fr backend and a
// REAL kag gateway, but point `EVIDENCE_REVIEW_URL` at a local Evidence Review
// with `ENABLE_AUTH=false`, and only run as a browser lane nothing in CI
// exercises. fr's former kag-reviews-fidelity unit suite (deleted 2026-10-29
// under the no-test-doubles ruling) drove fr's half of the passthrough against
// a FAKE upstream on `Bun.serve`; kag's own
// `tests/test_reviews_proxy_fidelity.py` drives its half the same way. Every
// one of those is right about the hop it covers and silent about the seam
// between hops — a path rename or a changed error body in fr's routing table,
// kag's rewrite, or Evidence Review's mount would be caught by NONE of them,
// because none of them runs the other two services' real code.
//
// This file runs all three: a real Evidence Review (its actual FastAPI app,
// its actual Postgres migrations, `ENABLE_AUTH=false`), a real kag gateway
// (its actual FastAPI app, pointed at that Evidence Review), and fr's actual
// `handleKagReviewsProxy` handler, so this exercises the
// identical code path fr's own server dispatches to, without needing a second
// process for fr itself (fr's HTTP routing of that path was pinned by the
// kag-reviews-routing unit suite, deleted 2026-10-29 under the no-test-doubles
// ruling; it is no longer pinned in the suite).
//
// ## Placement
//
// This lives in fr, not `evidence_review_service`, because fr owns TWO of the
// three hops (the frontend client's request shapes and the proxy that forwards
// them) and already has the exact seam (`handleKagReviewsProxy`) and the
// in-process-against-a-real-HTTP-upstream pattern this needs. Standing up Evidence Review + kag as child
// processes is orchestration this file owns; neither of those services'
// business logic is touched or duplicated here. Per fr's CLAUDE.md (hot,
// multi-agent repo), this file was authored in a worktree
// (`.worktrees/reviews-whole-chain`) rather than the shared checkout.
//
// ## What this proves
//
// 1. PATHS: every operation `fr/frontend/src/lib/api/reviews.ts` calls (read
//    verbatim from that file — see the table below, each entry cites the
//    exact reviews.ts function) reaches a REAL Evidence Review route through
//    BOTH proxies, not a 404 either hop invented. Proven by asserting the
//    response is never Evidence Review's bare route-miss shape
//    (`{"detail":"Not Found"}`, no `type`/`code`) — every path below instead
//    gets a genuine domain answer: a `404 not_found` RFC 9457 body ("no such
//    review", meaning the ROUTE matched and the resource legitimately doesn't
//    exist) or a `422` on real pydantic field validation (meaning the route
//    matched and a body was parsed).
// 2. ERROR SHAPES: a `404` and a `403` from Evidence Review survive BOTH
//    proxies with their RFC 9457 `type`/`title`/`status`/`detail`/`code` intact
//    — this is the passthrough contract's entire reason to exist, and the only
//    place it is checked against Evidence Review's REAL exception handlers
//    rather than a hand-written fake one. A framework-level `422` (FastAPI's
//    own `detail: [...]` shape, raised before any of Evidence Review's own
//    `ProblemError` code runs) is ALSO asserted, and asserted to be DIFFERENT
//    from the RFC 9457 shape — that asymmetry is real and undocumented
//    elsewhere; a caller branching on `body.code` for a plain missing-field
//    422 will find it absent.
// 3. ROUND TRIP: create a review through the full chain, read it back through
//    the full chain, list it through the full chain — all against a Postgres
//    database this file creates and drops, never production.
// 4. THE 307 HOP: when `EVIDENCE_REVIEW_URL` is unset on fr (the production
//    shape used throughout this file), the bare collection path
//    (`listReviews`/`createReview`) resolves through kag's
//    `/reviews/{path:path}` route, which Starlette answers with a same-origin
//    `307` before forwarding — invisible in a browser (fetch follows it) and
//    invisible to the former kag-reviews-fidelity suite (its fake upstream
//    was `Bun.serve`, which never redirects). Nothing in the estate asserted this
//    hop exists before this file. It survives only because `fetch`'s default
//    `redirect: 'follow'` chases it; a future `redirect: 'manual'` anywhere in
//    `fetchWithHeaderBudget` would silently break `listReviews`/`createReview`
//    while every existing fidelity test stayed green.
//
// ## What this does NOT prove, and why
//
// - The frontend `reviews.ts` functions are never called. There is no DOM/
//   fetch harness for them here; each path below is instead READ from that
//   file (function name cited per row) and driven with the identical
//   method+path+body shape. fr's own HTTP dispatch of these paths to
//   `handleKagReviewsProxy` is not this file's job (its unit pin, the
//   kag-reviews-routing suite, was deleted 2026-10-29).
// - `401`/`403 human_principal_required` under a VERIFIED Keycloak JWT are not
//   reachable here, for the same reason `frontend/e2e/README.md` states for
//   the `dev-cluster` Playwright lane: the deployed Evidence Review runs
//   `ENABLE_AUTH=true` and needs a real reviewer token, which nothing
//   unattended has. What IS reachable and proven below is
//   `403 human_principal_required` under `ENABLE_AUTH=false` — but ONLY
//   against kag directly, not through fr: fr's `AUTH_BYPASS` always
//   synthesizes an `X-Subject-Id` from the bypass user
//   (`routes/assets/kag-reviews.ts:318`), so a caller through fr can never
//   present as a subject-less service principal. That is not a gap in this
//   test, it is a fact about `AUTH_BYPASS` that `research-screening.spec.ts`
//   already documents (PR #788) — restated here because it means this ONE
//   assertion is 2 hops (kag -> Evidence Review), not 3.
// - The business workflow (locked protocol -> sealed corpus -> dedup ->
//   blinded decisions -> conflict adjudication -> flow) is not driven; that is
//   `research-screening{,-full,-dual}.spec.ts`'s job against a browser. This
//   file proves the PROXY CONTRACT, not the domain workflow.
//
// ## Running it
//
// Needs `uv`, a reachable Postgres superuser at
// `WHOLE_CHAIN_PG_*` (defaults: 127.0.0.1:5432, role `georgedekker`, matching
// this project's standard local Postgres 18 setup), and the `kag` /
// `evidence_review_service` sibling checkouts. Entirely skipped (loudly, via
// `describe.skipIf`, not silently) when any prerequisite is missing — this is
// NOT wired into CI, exactly like the `dev-cluster` Playwright lane it
// complements: `bun test ./tests/integration/reviews-whole-chain.manual.ts`
// (the leading `./` is required — see the naming note at the top of this file).
//
// Creates its OWN Postgres database + two roles (owner, non-superuser app) per
// run, named with a random suffix so concurrent runs on a shared box do not
// collide, and drops both in `afterAll`. Never touches port 5432's default
// database, never sets `MIGRATION_DATABASE_URL` and `DATABASE_URL` in the same
// command (the migration step and the app-boot step are separate `Bun.spawn`
// calls with disjoint env) — the ephemeral role provisioning this test does by
// hand is the equivalent of `evidence_review_service/tests/conftest.py`'s
// `_provision_runtime_role`, which is pytest-only and does not run for a
// process booted via `uvicorn` directly.

import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { config } from '../../src/config';

const PG_HOST = process.env.WHOLE_CHAIN_PG_HOST ?? '127.0.0.1';
const PG_PORT = process.env.WHOLE_CHAIN_PG_PORT ?? '5432';
const PG_SUPERUSER = process.env.WHOLE_CHAIN_PG_SUPERUSER ?? 'georgedekker';

const KAG_REPO = process.env.WHOLE_CHAIN_KAG_REPO ?? '~/knowledge/kag';
const ER_REPO =
  process.env.WHOLE_CHAIN_ER_REPO ?? '~/knowledge/evidence_review_service';

function hasCmd(cmd: string): boolean {
  try {
    return Bun.spawnSync(['which', cmd]).exitCode === 0;
  } catch {
    return false;
  }
}

function pgReachable(): boolean {
  try {
    const r = Bun.spawnSync(
      ['psql', '-h', PG_HOST, '-p', PG_PORT, '-U', PG_SUPERUSER, '-d', 'postgres', '-c', 'select 1'],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

// Evaluated once, at module load, so the skip reason below is stable and the
// `describe.skipIf` decision does not depend on ordering with `beforeAll`.
const PREREQS: { ok: boolean; reason: string } = (() => {
  if (!hasCmd('uv')) return { ok: false, reason: 'uv is not on PATH' };
  if (!hasCmd('psql')) return { ok: false, reason: 'psql is not on PATH' };
  if (!existsSync(KAG_REPO)) return { ok: false, reason: `kag checkout not found at ${KAG_REPO}` };
  if (!existsSync(ER_REPO)) {
    return { ok: false, reason: `evidence_review_service checkout not found at ${ER_REPO}` };
  }
  if (!pgReachable()) {
    return {
      ok: false,
      reason: `Postgres not reachable at ${PG_HOST}:${PG_PORT} as ${PG_SUPERUSER}`,
    };
  }
  return { ok: true, reason: '' };
})();

if (!PREREQS.ok) {
  // A loud skip reason in the test log, not just a silently-absent suite.
  // eslint-disable-next-line no-console
  console.warn(`reviews-whole-chain.manual.ts: SKIPPED — ${PREREQS.reason}`);
}

function runPsql(database: string, sql: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'wc-psql-'));
  const file = join(dir, 'q.sql');
  writeFileSync(file, sql);
  try {
    const r = Bun.spawnSync(
      ['psql', '-h', PG_HOST, '-p', PG_PORT, '-U', PG_SUPERUSER, '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', file],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `psql against ${database} failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An OS-assigned free TCP port on loopback. A small bind/spawn race is
 * accepted — this is a single-host local test, not adversarial. */
async function freePort(): Promise<number> {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      // Any HTTP response (kag's own `/health` reports 200 with an
      // `"unhealthy"` body for unrelated, unconfigured downstreams — that is
      // not this test's concern) means the process is accepting connections.
      if (r.status > 0) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`${url} did not respond within ${timeoutMs}ms: ${String(lastErr)}`);
}

describe.skipIf(!PREREQS.ok)('the whole reviews chain: fr proxy -> kag gateway -> Evidence Review', () => {
  const RUN_ID = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const DB_NAME = `err_wholechain_${RUN_ID}`;
  const OWNER_ROLE = `err_owner_${RUN_ID}`;
  const APP_ROLE = `err_app_${RUN_ID}`;
  const OWNER_PW = 'wc-owner-pw';
  const APP_PW = 'wc-app-pw';

  let erProc: Bun.Subprocess | null = null;
  let kagProc: Bun.Subprocess | null = null;
  let erPort = 0;
  let kagPort = 0;
  let priorKagBaseUrl = '';
  let priorErBaseUrl = '';

  const services = config.services as unknown as Record<string, { baseUrl: string } | undefined>;

  beforeAll(async () => {
    // 1. A dedicated database + a non-owner app role, exactly the shape
    //    `evidence_review_service/README.md` § Local development documents,
    //    built by hand because that provisioning is pytest-conftest-only.
    runPsql(
      'postgres',
      `
      CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${OWNER_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
      CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
      CREATE DATABASE ${DB_NAME} OWNER ${OWNER_ROLE};
      `,
    );
    runPsql(
      DB_NAME,
      `
      GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
      ALTER SCHEMA public OWNER TO ${OWNER_ROLE};
      `,
    );

    // 2. Migrations, as the OWNER, in a command that sets ONLY
    //    MIGRATION_DATABASE_URL — never alongside DATABASE_URL. Conflating the
    //    two silently runs a later test suite as superuser with RLS bypassed;
    //    keeping the migration step and the app-boot step as separate
    //    Bun.spawn calls with disjoint env is how this file avoids that.
    const migrationUrl = `postgresql+psycopg://${OWNER_ROLE}:${OWNER_PW}@${PG_HOST}:${PG_PORT}/${DB_NAME}`;
    const alembic = Bun.spawnSync(['uv', 'run', 'alembic', 'upgrade', 'head'], {
      cwd: ER_REPO,
      env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl, DATABASE_URL: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (alembic.exitCode !== 0) {
      throw new Error(`alembic upgrade head failed: ${new TextDecoder().decode(alembic.stderr)}`);
    }

    // 3. DML for the app role, mirroring conftest's `_provision_runtime_role`
    //    blanket GRANT (this test does not need the append-only REVOKE
    //    corrections that file re-asserts — those guard write-privilege
    //    tests, not this proxy-contract one).
    runPsql(
      DB_NAME,
      `
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};
      `,
    );

    // 4. Evidence Review, for real: its actual `app:create_app` factory,
    //    ENABLE_AUTH off (a non-production ENVIRONMENT, exactly what the
    //    factory requires to allow that), connected as the non-owner app
    //    role. No MIGRATION_DATABASE_URL in this env block.
    erPort = await freePort();
    erProc = Bun.spawn({
      cmd: ['uv', 'run', 'uvicorn', 'app:create_app', '--factory', '--host', '127.0.0.1', '--port', String(erPort)],
      cwd: ER_REPO,
      env: {
        ...process.env,
        DATABASE_URL: `postgresql+psycopg://${APP_ROLE}:${APP_PW}@${PG_HOST}:${PG_PORT}/${DB_NAME}`,
        MIGRATION_DATABASE_URL: '',
        ENVIRONMENT: 'development',
        ENABLE_AUTH: 'false',
        PYTHONPATH: 'src',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForHttp(`http://127.0.0.1:${erPort}/health`, 20_000);

    // 5. kag, for real: its actual `main:app`, pointed at the Evidence Review
    //    just started. `ENABLE_AUTH=false` on kag too — the ONLY way to drive
    //    the write path without a verified Keycloak reviewer JWT, exactly as
    //    `frontend/e2e/README.md` § "The three Screening specs need a LOCAL
    //    Evidence Review" documents for the browser lane. Every OTHER
    //    downstream kag proxies (ingestion, hirag, karma, ...) stays
    //    unconfigured; `ENVIRONMENT=development` means kag's own
    //    `_REQUIRED_IN_PRODUCTION` gate never fires for them, and `/reviews`
    //    does not depend on any of them.
    kagPort = await freePort();
    kagProc = Bun.spawn({
      cmd: ['uv', 'run', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(kagPort)],
      cwd: join(KAG_REPO, 'src'),
      env: {
        ...process.env,
        ENVIRONMENT: 'development',
        ENABLE_AUTH: 'false',
        EVIDENCE_REVIEW_URL: `http://127.0.0.1:${erPort}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForHttp(`http://127.0.0.1:${kagPort}/health`, 20_000);

    // 6. Point fr's real proxy at the real kag gateway. `evidenceReview`
    //    stays UNSET — the production shape — so `resolveReviewsTarget` takes
    //    the gateway branch and the fr -> kag hop is genuinely exercised, not
    //    skipped the way the "direct form" driving aid in the e2e README is.
    priorKagBaseUrl = services.kag?.baseUrl ?? '';
    priorErBaseUrl = services.evidenceReview?.baseUrl ?? '';
    services.kag = { baseUrl: `http://127.0.0.1:${kagPort}` };
    services.evidenceReview = { baseUrl: '' };
  }, 60_000);

  afterAll(async () => {
    services.kag = { baseUrl: priorKagBaseUrl };
    services.evidenceReview = { baseUrl: priorErBaseUrl };

    kagProc?.kill();
    erProc?.kill();
    if (kagProc) await kagProc.exited;
    if (erProc) await erProc.exited;

    // Postgres refuses DROP DATABASE with an open connection; the process
    // exits above have already closed fr/kag's pools, so this should not
    // need a retry — but a provisioning failure earlier must never leave a
    // half-created role/database behind on a shared dev box, so failures
    // here are logged, not thrown (an afterAll throw would mask the real
    // test failure that preceded it).
    try {
      runPsql('postgres', `DROP DATABASE IF EXISTS ${DB_NAME};`);
      runPsql('postgres', `DROP ROLE IF EXISTS ${APP_ROLE}; DROP ROLE IF EXISTS ${OWNER_ROLE};`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`reviews-whole-chain: cleanup failed, ${DB_NAME}/${OWNER_ROLE}/${APP_ROLE} may be orphaned:`, e);
    }
  }, 30_000);

  /** Drives fr's REAL proxy handler — the same function fr's server dispatches
   * `/api/assets/kag/reviews/*` to — with a Request shaped exactly like the frontend
   * client sends it. */
  async function callProxy(
    method: string,
    path: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const { handleKagReviewsProxy } = await import('../../src/routes/assets/kag-reviews');
    return handleKagReviewsProxy(new Request(`https://fr.example.com${path}`, { method, headers, body }));
  }

  /** True iff `res` is Evidence Review's BARE route-miss 404
   * (`{"detail":"Not Found"}`, no RFC 9457 fields) — the one shape that means
   * neither hop found a matching route. A domain 404 (`{"type":...,
   * "code":"not_found",...}`, "no such review") or a 422 with a `detail`
   * ARRAY (FastAPI's own field-validation shape) both mean the route WAS
   * matched — the request just failed downstream of routing, which is a
   * different fact this function does not judge. */
  async function isRouteMiss(res: Response): Promise<boolean> {
    if (res.status !== 404) return false;
    const body = (await res.clone().json()) as Record<string, unknown>;
    return typeof body.detail === 'string' && !('type' in body) && !('code' in body);
  }

  test('round trip: create -> get -> list survives fr -> kag -> Evidence Review intact', async () => {
    // BASE + POST '' — reviews.ts `createReview()`.
    const createRes = await callProxy(
      'POST',
      '/api/assets/kag/reviews',
      JSON.stringify({
        project_id: 'whole-chain-e2e',
        external_key: `wc-${RUN_ID}`,
        title: 'Whole chain round trip',
      }),
      { 'content-type': 'application/json' },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { review_id: string };
    expect(created.review_id).toBeTruthy();

    // reviews.ts `getReview(id)` — GET '/{id}'.
    const getRes = await callProxy('GET', `/api/assets/kag/reviews/${created.review_id}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(created);

    // reviews.ts `listReviews()` — GET '' (the bare-collection / 307-hop path;
    // see the file header, "THE 307 HOP").
    const listRes = await callProxy('GET', '/api/assets/kag/reviews');
    expect(listRes.status).toBe(200);
    const { items } = (await listRes.json()) as { items: { review_id: string }[] };
    expect(items.some((r) => r.review_id === created.review_id)).toBe(true);
  });

  test('a 404 from Evidence Review survives fr AND kag intact (RFC 9457)', async () => {
    const res = await callProxy('GET', '/api/assets/kag/reviews/00000000-0000-0000-0000-0000000000ff');
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe('https://contracts.nonagentic.ai/problems/evidence-review/not_found');
    expect(body.code).toBe('not_found');
    expect(body.title).toBe('Not Found');
    expect(typeof body.detail).toBe('string');
  });

  test('a framework 422 does NOT carry the RFC 9457 shape — a real, undocumented asymmetry', async () => {
    // reviews.ts `createReview()` with a body missing every required field.
    // Evidence Review's own `ValidationFailedError` (422 `validation_failed`,
    // RFC 9457) never runs here — FastAPI's request-body parser rejects the
    // shape before the route handler is entered, so this is its OWN
    // `detail: [...]` array, no `type`, no `code`.
    const res = await callProxy('POST', '/api/assets/kag/reviews', '{}', {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.detail)).toBe(true);
    expect(body.type).toBeUndefined();
    expect(body.code).toBeUndefined();
  });

  test('403 human_principal_required survives kag -> Evidence Review intact (2 hops, not 3 — see file header)', async () => {
    // Driven directly against kag, NOT through fr's handler: fr's AUTH_BYPASS
    // always forwards an X-Subject-Id (routes/assets/kag-reviews.ts:318), so
    // a caller through fr can never present as a subject-less service
    // principal — see "What this does NOT prove" above.
    const res = await fetch(`http://127.0.0.1:${kagPort}/reviews`, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-jwt' },
      body: JSON.stringify({ project_id: 'whole-chain-e2e', external_key: `wc-403-${RUN_ID}`, title: 'x' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('human_principal_required');
    expect(body.type).toBe(
      'https://contracts.nonagentic.ai/problems/evidence-review/human_principal_required',
    );
  });

  // Every operation `reviews.ts` calls that takes a review id, driven with a
  // syntactically-valid-but-nonexistent UUID. Each row cites the exact
  // reviews.ts function it mirrors. None of these should ever be a route
  // miss — proving the path fr builds, the path kag rewrites to, and the path
  // Evidence Review mounts all agree, for the WHOLE surface, not one sample.
  const RID = '00000000-0000-0000-0000-0000000000ff';
  const PATH_TABLE: { op: string; method: string; path: string; body?: string }[] = [
    { op: 'getReview', method: 'GET', path: `/${RID}` },
    { op: 'listProtocolVersions (via createReview flow)', method: 'GET', path: `/${RID}/protocol-versions` },
    { op: 'createProtocol', method: 'POST', path: `/${RID}/protocol-versions`, body: '{}' },
    { op: 'lockProtocol', method: 'POST', path: `/${RID}/protocol-versions/00000000-0000-0000-0000-000000000001:lock`, body: '{}' },
    { op: 'activateReview', method: 'POST', path: `/${RID}:activate`, body: '{}' },
    { op: 'importCorpus', method: 'POST', path: `/${RID}/imports?source_kind=ris`, body: '{}' },
    { op: 'importDiscoveryBatch', method: 'POST', path: `/${RID}/imports/from-discovery`, body: '{}' },
    { op: 'sealCorpus', method: 'POST', path: `/${RID}/corpus-versions`, body: '{}' },
    { op: 'listCorpusVersions', method: 'GET', path: `/${RID}/corpus-versions` },
    { op: 'listStages', method: 'GET', path: `/${RID}/stages` },
    { op: 'runDeduplication', method: 'POST', path: `/${RID}/deduplication-runs`, body: '{}' },
    { op: 'listDeduplicationRuns', method: 'GET', path: `/${RID}/deduplication-runs` },
    { op: 'listClusters', method: 'GET', path: `/${RID}/duplicate-clusters` },
    { op: 'resolveCluster', method: 'POST', path: `/${RID}/duplicate-clusters/00000000-0000-0000-0000-000000000002:resolve`, body: '{}' },
    { op: 'createAssignments', method: 'POST', path: `/${RID}/assignments`, body: '{}' },
    { op: 'getQueue', method: 'GET', path: `/${RID}/screening/queue?stage_id=00000000-0000-0000-0000-000000000003&round_number=1` },
    { op: 'recordDecision', method: 'POST', path: `/${RID}/decisions`, body: '{}' },
    { op: 'listConflicts', method: 'GET', path: `/${RID}/conflicts` },
    { op: 'unblindConflict', method: 'POST', path: `/${RID}/conflicts/00000000-0000-0000-0000-000000000004:unblind`, body: '{}' },
    { op: 'adjudicate', method: 'POST', path: `/${RID}/conflicts/00000000-0000-0000-0000-000000000004:resolve`, body: '{}' },
    { op: 'getFlow', method: 'GET', path: `/${RID}/flow` },
    { op: 'rebuildFlow', method: 'POST', path: `/${RID}/flow:rebuild`, body: '{}' },
    { op: 'createExport', method: 'POST', path: `/${RID}/exports`, body: '{}' },
    { op: 'listExports', method: 'GET', path: `/${RID}/exports` },
    { op: 'getExport', method: 'GET', path: `/${RID}/exports/00000000-0000-0000-0000-000000000005` },
    { op: 'verifyExport', method: 'GET', path: `/${RID}/exports/00000000-0000-0000-0000-000000000005:verify` },
    { op: 'listQuarantine', method: 'GET', path: `/${RID}/quarantine` },
  ];

  for (const { op, method, path, body } of PATH_TABLE) {
    test(`path mapping: ${op} (${method} .../reviews${path}) reaches a real Evidence Review route`, async () => {
      const res = await callProxy(
        method,
        `/api/assets/kag/reviews${path}`,
        body,
        body ? { 'content-type': 'application/json' } : {},
      );
      expect(
        await isRouteMiss(res),
        `${op} at ${path} came back as Evidence Review's bare route-miss 404 — ` +
          'the path fr built, kag rewrote, or Evidence Review mounted has drifted',
      ).toBe(false);
    });
  }
});
