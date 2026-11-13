// A PARTIAL UPDATE MUST NOT BLANK THE FIELDS IT DID NOT MENTION.
//
// `requirements_management` REPLACES on PUT: `entity_service.py` `EntityService.update` walks
// `type(payload).model_fields` — the SCHEMA's fields, not the body's keys — over a
// `model_dump` taken without `exclude_unset`, so every key fr omits is written
// back as `None`. fr's editor builds its body from `manifest.editor.sections`
// alone, so every field no editor section offers is destroyed on save. The fix is
// `src/integrations/_lib/merge-update.ts`; this file is its ratchet.
//
// ## Why the census is mechanical
//
// A hand-written list of "the update functions" is the hole, not the guard: the
// next one is simply absent from it and goes green. So the subject set is
// DISCOVERED — every `.ts` under `src/integrations/` is imported and every
// exported function whose name starts with `update` becomes a subject. Each one
// must then land in exactly one of the recorded sets below, and each set is
// checked for GHOSTS as well as for gaps, so neither adding a function nor
// deleting one can leave the decision stale.
//
// ## Why there are several sets and not one
//
// Kanban (Planka) and research issue **PATCH**, the PM catalogue's PUT is
// documented partial, and the TOC config PUT is a whole-document upsert: none
// of them has the defect and none must ever be "fixed". Each gets its own set,
// and — in the idiom of `project-scope-caller-census.test.ts` — its exemption is
// only as alive as its PROOF, re-read below. An exemption list nobody
// re-verifies is a licence not to look.
//
// ## Where the BEHAVIOUR is measured
//
// Not here. Whether each CONVERTED function really sends the stored row plus
// the edit was measured at fr's transport boundary, per PUT path, by the
// rm-put-sends-merged-row suite (deleted 2026-10-29 under the no-test-doubles
// ruling) — that behaviour is no longer measured in the suite. This file owns the partition and the helper's own
// contract.
//
// ⛔ No git ref is read anywhere here. Filesystem + the committed OpenAPI
// snapshot only.

import { describe, expect, test as bunTest } from 'bun:test';
import { withRequestContext } from '../../../src/integrations/_lib/context';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  bodyKeysOf,
  mergeReplacingUpdate,
  DERIVED_ON_CHANGE,
  NEVER_PRESERVE,
} from '../../../src/integrations/_lib/merge-update';
import { PUT_BODY_PROPERTIES, type DecisionIn } from '@fr/service-client-requirements';

// The requirements_management clients run with `requireTenant` (no tenant ⇒
// MISSING_TENANT, nothing sent). Production calls these inside a request frame,
// so every test here runs inside one too.
const RM_TEST_FRAME = {
  correlationId: 'rm-test-frame',
  initiator: 'human' as const,
  channel: 'web' as const,
  tenantId: '0195f48b-d000-7000-8000-000000000f01',
};
const test = (name: string, fn: () => unknown): void => {
  bunTest(name, () => withRequestContext(RM_TEST_FRAME, async () => {
    await fn();
  }));
};

const INTEGRATIONS = join(import.meta.dir, '../../../src/integrations');
const REQUIREMENTS_SPEC = join(
  import.meta.dir,
  '../../../../tooling/openapi/specs/requirements.json',
);

// --- the census -----------------------------------------------------------

/** `_lib` and `_*.ts` are helpers, not integration modules — and `_lib/merge-update.ts` is the helper under test. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('_')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const MODULE_FILES = walk(INTEGRATIONS).sort();

/** Every non-test `.ts` under `src/` (helpers included), for the source censuses. */
function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkSrc(p, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * How many MODULES the filesystem walk matched.
 *
 * Floored separately from how many `update*` functions were recognised inside
 * them, mirroring `frontend/src/lib/manifests/_allManifests.ts`'s
 * `MANIFEST_MODULE_COUNT`: a walk that found no files and a scan that found no
 * functions are different failures and must not share one number.
 */
const INTEGRATION_MODULE_COUNT = MODULE_FILES.length;

interface Subject {
  /** `"<file relative to integrations/>::<export name>"`. */
  key: string;
  file: string;
  name: string;
  /** The function's source, sliced out of its module. */
  body: string;
}

/**
 * The function's own source, from its `export` line to the `}` in column 0 that
 * closes it. Sliced rather than read whole-file so a `method:` belonging to the
 * NEXT function cannot be attributed to this one.
 */
function sliceBody(source: string, name: string): string {
  const own = sliceFn(source, `export\\s+(?:async\\s+)?function\\s+${name}\\s*[(<]`);
  // A reader/writer SEAM (`deps.<fn>(…)`, sanctioned test-injection pattern) delegates
  // to the module's real HTTP implementation `http<Fn>`: that is the code this census
  // measures, so it is appended to the function's own slice.
  const impls = [...own.matchAll(/\bdeps\.(\w+)\s*[(<]/g)].map((m) =>
    sliceFn(source, `(?:export\\s+)?(?:async\\s+)?function\\s+http${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}\\s*[(<]`),
  );
  return [own, ...impls].join('\n');
}

function sliceFn(source: string, declRe: string): string {
  const m = new RegExp(declRe).exec(source);
  if (!m) return '';
  const rest = source.slice(m.index);
  const end = rest.indexOf('\n}');
  return end === -1 ? rest : rest.slice(0, end + 2);
}

const SUBJECTS: Subject[] = [];
for (const file of MODULE_FILES) {
  // `pathToFileURL` and not the bare path: a dynamic import of an absolute
  // POSIX path is resolver-dependent, and a resolution failure here would read
  // as "this module exports no update function".
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const source = readFileSync(file, 'utf8');
  const rel = relative(INTEGRATIONS, file);
  for (const name of Object.keys(mod).sort()) {
    if (!name.startsWith('update')) continue;
    if (typeof mod[name] !== 'function') continue;
    SUBJECTS.push({ key: `${rel}::${name}`, file: rel, name, body: sliceBody(source, name) });
  }
}

// --- the three recorded sets ----------------------------------------------

/**
 * Converted: a read-modify-write (`mergeReplacingUpdate`, or `rmUpdateModelRow`
 * for modeling rows). This set only ever GROWS; the behaviour of each is no
 * longer measured in the suite (see the header).
 */
const CONVERTED: ReadonlySet<string> = new Set([
  // RM PUT replaces (entity_service.py `update`, omitted field ⇒ its default);
  // the key set is the GENERATED `PUT_BODY_PROPERTIES` (2026-10-29).
  'architecture.ts::updateArchitectureElement',
  'architecture.ts::updateArchitectureStandard',
  'architecture.ts::updateArchitectureView',
  'decisions.ts::updateDecision',
  'principles.ts::updatePrinciple',
  'requirements.ts::updateRequirement',
  'toc.ts::updateTocNode',
  'toc.ts::updateTocTree',
  // (Every pm.ts update — updateActivity, updatePmProjectInTenant, updateProject,
  // updateProgramme, updateRisk — is GONE, not regressed: George 2026-10-13, v4
  // D15/R16 — fr writes no PM resource; RM refuses it with 403. The helper's
  // behaviour is now measured on `mergeReplacingUpdate` itself, below.)
]);

/**
 * ⛔ SHRINK-ONLY. Every entry is a PUT against a replacing upstream that still
 * blanks the fields fr's request body omits. This set MUST reach empty, and
 * NOTHING MAY EVER BE ADDED TO IT — a new `update*` function that needs merging
 * is written through the helper from the start, which is why a new subject
 * failing the partition test below is the correct outcome and not an
 * inconvenience to be silenced by appending a line here.
 *
 * Every requirements_management entry is gone (2026-10-29). The one left is
 * ANOTHER service, and its GET is not an image of the PUT body: `WorkerResponse`
 * carries only part of `WorkerCreateRequest` (no `deps`, `workspace`,
 * `description`, …) and returns `api_key_override`. It needs its upstream's
 * semantics measured before a read-modify-write is safe — not this helper
 * applied blind.
 */
const PENDING_CONVERSION: ReadonlySet<string> = new Set([
  'workers.ts::updateWorker',
]);

/**
 * NOT a backlog — a whole-DOCUMENT upsert, not a row with columns to lose.
 * `PUT /toc/config` (`toc.py` `upsert_toc_config` → `toc_service.upsert_settings`)
 * keys the row by `project_id` and stores `settings` as one document; there is no
 * other column. And its GET answers the RESOLVED settings (defaults ← global ←
 * tenant ← project, `toc_service.resolve_settings`), not the row, so a
 * read-modify-write would freeze the inherited layers into this one.
 *
 * The exemption is only as alive as its proof: the test below holds it only
 * while the committed snapshot's body schema still has exactly the address key
 * plus the one document key.
 */
const DOCUMENT_UPSERT: ReadonlyMap<string, { schema: string; address: string; document: string }> = new Map([
  ['toc.ts::updateTocConfig', { schema: 'TocSettingsIn', address: 'project_id', document: 'settings' }],
]);

/**
 * NOT a backlog — these upstreams take PATCH, which is already a partial update,
 * so merging a GET in would add a round-trip and a lost-update window to buy
 * nothing. They must stay unconverted.
 *
 * The exemption is only as alive as its proof: the test below re-reads each
 * body and holds the exemption only while that body issues PATCH and no PUT. If
 * Planka or research ever moves to PUT, this goes red instead of becoming a
 * blind spot.
 */
const PARTIAL_UPDATE_UPSTREAM: ReadonlySet<string> = new Set([
  'kanban.ts::updateBoard',
  'kanban.ts::updateCard',
  'kanban.ts::updateLabel',
  'kanban.ts::updateList',
  'kanban.ts::updateProject',
  'kanban.ts::updateTask',
  'kanban.ts::updateTaskList',
  'research.ts::updateSession',
]);

/**
 * NOT a backlog either — upstreams whose PUT is itself PARTIAL (an omitted
 * field is left unchanged). Merging a GET in would re-send every stored value
 * and race a concurrent writer for nothing, so fr forwards the body verbatim.
 *
 * The exemption is only as alive as its proof: the test below holds it only
 * while the body issues a PUT without the helper AND the committed RM snapshot
 * still documents EVERY allowlisted catalogue PUT as "omitted fields are
 * unchanged" (rm#208). If RM ever goes back to replacing, this goes red.
 */
const PARTIAL_PUT_UPSTREAM: ReadonlySet<string> = new Set([
  'pm-catalogue.ts::updatePmCatalogueItem',
]);

/**
 * A stored PM project carrying SENTINELS — real `ProjectIn` fields that the
 * caller below never mentions, so they are exactly what a replacing PUT would
 * destroy. Plus keys `ProjectIn` does NOT accept (the `*Out`-only columns and
 * three keys of other schemas), so the probe can also prove that only `*In`
 * keys travel. `NEVER_PRESERVE` is measured on `RiskIn`, the schema that
 * carries `risk_score`, below. (This used `ActivityIn` until RM's schedule
 * apparatus was deleted, R352.)
 */
const STORED_PROJECT: Record<string, unknown> = {
  // *Out*-only — must never appear in the PUT body.
  id: '0191c0de-dead-beef-cafe-000000000001',
  slug: 'ship-the-thing',
  tenant_id: 'tenant-a',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  // In the caller's body, so the caller overwrites them.
  title: 'Ship the thing',
  programme_id: 'PG-1',
  // ⭐ SENTINELS — in `ProjectIn`, not mentioned by the caller.
  tranche: 'T1',
  wip_limit: 3,
  rework_limit: 2,
  start_date: '2026-01-05',
  end_date: null,
  budget: 0,
  fixture: false,
  // Not `ProjectIn` keys (checked below), so they must not travel either.
  risk_score: 0.42,
  impact_score: 3,
  creator_id: 'user-first-author',
};

describe('partial updates preserve the fields they do not mention', () => {

  // --- non-vacuity floors -------------------------------------------------

  test('the walk found the integration modules', () => {
    // A walk that matched nothing must not read as "nothing to check".
    // Non-vacuity only — no count is pinned.
    expect(INTEGRATION_MODULE_COUNT).toBeGreaterThan(0);
  });

  test('the census found the update functions', () => {
    // ⛔ THE FLOOR: below this the census has stopped seeing its subjects and
    // every assertion in this file would pass while checking nothing. Non-zero
    // only — the number of subjects grows with the tree.
    expect(SUBJECTS.length).toBeGreaterThan(0);
  });

  test('every subject body was sliced out of its module', () => {
    // An empty slice silently satisfies "contains no PUT" and "does not call the
    // helper", which would turn two ratchets into no-ops at once.
    const unsliced = SUBJECTS.filter((s) => s.body.length === 0)
      .map((s) => s.key)
      .sort();
    expect(unsliced).toEqual([]);
  });

  // --- the partition ------------------------------------------------------

  test('every discovered update function is recorded in exactly one set', () => {
    const misfiled = SUBJECTS.map((s) => {
      const hits = [
        CONVERTED.has(s.key) && 'CONVERTED',
        PENDING_CONVERSION.has(s.key) && 'PENDING_CONVERSION',
        PARTIAL_UPDATE_UPSTREAM.has(s.key) && 'PARTIAL_UPDATE_UPSTREAM',
        PARTIAL_PUT_UPSTREAM.has(s.key) && 'PARTIAL_PUT_UPSTREAM',
        DOCUMENT_UPSERT.has(s.key) && 'DOCUMENT_UPSERT',
      ].filter(Boolean);
      if (hits.length === 1) return null;
      return `${s.key}: in ${hits.length} set(s) [${hits.join(', ')}]`;
    })
      .filter((x): x is string => x !== null)
      .sort();
    // A new `update*` function landed. Write it through `mergeReplacingUpdate`
    // and add it to CONVERTED — or, if its upstream takes PATCH, to
    // PARTIAL_UPDATE_UPSTREAM. ⛔ Not to PENDING_CONVERSION.
    expect(misfiled).toEqual([]);
  });

  test('no recorded entry has lost its function', () => {
    const live = new Set(SUBJECTS.map((s) => s.key));
    const ghosts = [...CONVERTED, ...PENDING_CONVERSION, ...PARTIAL_UPDATE_UPSTREAM, ...PARTIAL_PUT_UPSTREAM, ...DOCUMENT_UPSERT.keys()]
      .filter((k) => !live.has(k))
      .sort();
    expect(ghosts).toEqual([]);
  });

  // --- the ratchet, in both directions ------------------------------------

  test('a converted function may not stay in PENDING_CONVERSION', () => {
    // This is what forces the set to SHRINK: convert one and forget to move it,
    // and the backlog is wrong in a way that goes red rather than unnoticed.
    const converted = [...PENDING_CONVERSION]
      .filter((k) => SUBJECTS.find((s) => s.key === k)?.body.includes('mergeReplacingUpdate'))
      .sort();
    expect(converted).toEqual([]);
  });

  test('every PARTIAL_UPDATE_UPSTREAM exemption still issues PATCH, not PUT', () => {
    const broken = [...PARTIAL_UPDATE_UPSTREAM]
      .map((k) => {
        const body = SUBJECTS.find((s) => s.key === k)?.body ?? '';
        const methods = [...body.matchAll(/method:\s*'(\w+)'/g)].map((m) => m[1]!);
        if (methods.includes('PATCH') && !methods.includes('PUT')) return null;
        return `${k}: methods [${methods.join(', ') || 'none'}]`;
      })
      .filter((x): x is string => x !== null)
      .sort();
    // The exemption rested on PATCH semantics. If this is red, the upstream
    // moved and the function now needs converting like the rest.
    expect(broken).toEqual([]);
  });

  test('every PARTIAL_PUT_UPSTREAM exemption issues a bare PUT and its upstream still documents partial PUTs', async () => {
    const { PM_CATALOGUE_RESOURCES } = await import('../../../src/integrations/pm-catalogue');
    const rmSpec = JSON.parse(
      readFileSync(join(import.meta.dir, '../../../../tooling/openapi/specs/requirements.json'), 'utf8'),
    ) as { paths: Record<string, { put?: { description?: string } }> };
    const broken = [...PARTIAL_PUT_UPSTREAM]
      .map((k) => {
        const body = SUBJECTS.find((s) => s.key === k)?.body ?? '';
        if (!/method:\s*'PUT'/.test(body)) return `${k}: no PUT`;
        if (body.includes('mergeReplacingUpdate')) return `${k}: merges (belongs in CONVERTED)`;
        return null;
      })
      .filter((x): x is string => x !== null);
    const replacing = PM_CATALOGUE_RESOURCES.filter(
      (r) => !/omitted\s+fields[\s\S]{0,60}?are\s+unchanged/i.test(rmSpec.paths[`/pm/${r}/{eid}`]?.put?.description ?? ''),
    );
    expect(PM_CATALOGUE_RESOURCES.length).toBeGreaterThan(0);
    expect(broken).toEqual([]);
    expect(replacing).toEqual([]);
  });

  test('every PENDING_CONVERSION function still issues the replacing PUT', () => {
    const notPut = [...PENDING_CONVERSION]
      .filter((k) => {
        const body = SUBJECTS.find((s) => s.key === k)?.body ?? '';
        return !/method:\s*'PUT'/.test(body);
      })
      .sort();
    // Not a backlog entry at all then — it either moved to PATCH (file it under
    // PARTIAL_UPDATE_UPSTREAM) or it no longer writes.
    expect(notPut).toEqual([]);
  });

  // --- the behaviour, measured ---------------------------------------------

  test('mergeReplacingUpdate preserves the fields the caller never mentioned (ProjectIn from the committed spec)', async () => {
    const spec = JSON.parse(readFileSync(REQUIREMENTS_SPEC, 'utf8')) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const allowed = Object.keys(spec.components.schemas.ProjectIn?.properties ?? {});
    expect(allowed.length).toBeGreaterThan(0);
    let reads = 0;
    const put = (await mergeReplacingUpdate(
      async () => {
        reads += 1;
        return STORED_PROJECT;
      },
      { title: 'Ship the thing, revised', programme_id: 'PG-1' },
      allowed,
    )) as Record<string, unknown>;
    expect(reads).toBe(1);

    // ⭐ The sentinels survive — this is the whole point.
    expect(put.tranche).toBe('T1');
    expect(put.wip_limit).toBe(3);
    expect(put.rework_limit).toBe(2);
    expect(put.start_date).toBe('2026-01-05');
    // Falsy stored values are values, not absences.
    expect(put.budget).toBe(0);
    expect(put.fixture).toBe(false);
    expect(Object.hasOwn(put, 'end_date')).toBe(true);
    expect(put.end_date).toBeNull();
    // The caller still wins where it spoke.
    expect(put.title).toBe('Ship the thing, revised');
    // `*Out`-only columns are not echoed back.
    for (const key of ['id', 'slug', 'tenant_id', 'created_at', 'updated_at']) {
      expect(Object.hasOwn(put, key)).toBe(false);
    }
    // Keys `ProjectIn` does not accept do not travel. Their absence from the
    // schema is asserted first, so this stays a statement about the allow-list
    // and cannot pass by accident if the schema starts carrying one of them.
    for (const key of ['risk_score', 'impact_score', 'creator_id']) {
      expect(allowed.includes(key), key).toBe(false);
      expect(Object.hasOwn(put, key), key).toBe(false);
    }
  });

  // --- the helper's own contract ------------------------------------------

  test('NEVER_PRESERVE drops risk_score from a RiskIn body (the generated key set carries it), and keeps the author', async () => {
    // Measured on the schema that really accepts `risk_score`: the GENERATED
    // RiskIn key set. A regression in the default deny list shows up here.
    const allowed = PUT_BODY_PROPERTIES.RiskIn;
    expect(allowed).toContain('risk_score');
    expect(allowed).toContain('probability');
    const merged = (await mergeReplacingUpdate(
      async () => ({
        title: 'Vendor may slip',
        probability: 0.4,
        impact_score: 3,
        risk_score: 1.2,
        owner: 'user-owner',
      }),
      { title: 'Vendor will slip' },
      allowed,
    )) as Record<string, unknown>;

    expect(merged.probability).toBe(0.4);
    expect(merged.impact_score).toBe(3);
    expect(merged.owner).toBe('user-owner');
    expect(merged.title).toBe('Vendor will slip');
    // ⛔ `risk_score` arriving non-null makes upstream SKIP its recompute
    // (`RiskIn.compute_risk_score`), freezing the score while probability moves.
    expect(Object.hasOwn(merged, 'risk_score')).toBe(false);
    expect([...NEVER_PRESERVE]).toEqual(['risk_score']);
  });

  test('the author is preserved where the schema accepts it (DecisionIn.created_by_user_id)', async () => {
    // Dropping it blanked the AUTHOR on every save; RM's own PATCH keeps it.
    const keys = bodyKeysOf<DecisionIn>()(PUT_BODY_PROPERTIES.DecisionIn);
    expect(keys).toContain('created_by_user_id');
    const merged = (await mergeReplacingUpdate(
      async () => ({ title: 'Use Postgres', created_by_user_id: 'user-first-author' }),
      { title: 'Use Postgres 18' },
      keys,
    )) as Record<string, unknown>;
    expect(merged.created_by_user_id).toBe('user-first-author');
  });

  test('a changed source drops the stored field RM derives from it; an unchanged one keeps it', async () => {
    const stored = async () => ({ element_type: 'business_actor', layer: 'business', origin_kind: 'project', origin_project_id: 'P-1', title: 't' });
    const keys = ['element_type', 'layer', 'origin_kind', 'origin_project_id', 'origin_workflow_run_id', 'title'];
    const retyped = (await mergeReplacingUpdate(stored, { element_type: 'application_component' }, keys)) as Record<string, unknown>;
    expect(Object.hasOwn(retyped, 'layer')).toBe(false);
    const sameType = (await mergeReplacingUpdate(stored, { element_type: 'business_actor' }, keys)) as Record<string, unknown>;
    expect(sameType.layer).toBe('business');
    const toTenant = (await mergeReplacingUpdate(stored, { origin_kind: 'tenant' }, keys)) as Record<string, unknown>;
    expect(Object.hasOwn(toTenant, 'origin_project_id')).toBe(false);
    const explicit = (await mergeReplacingUpdate(stored, { origin_kind: 'project', origin_project_id: 'P-2' }, keys)) as Record<string, unknown>;
    expect(explicit.origin_project_id).toBe('P-2');
    expect(Object.keys(DERIVED_ON_CHANGE).sort()).toEqual(['layer', 'origin_project_id', 'origin_workflow_run_id']);
  });

  // --- the live-RM regression (2026-10-29), from the GENERATED key set -------

  test('a decision edited through the generic form keeps the fields the form does not carry', async () => {
    // ⭐ THE BUG. Live RM's `DecisionIn` gained card_id / phase / raised_at /
    // decided_at / decided_by_kind; fr's editor body carries none of them, so the
    // replacing PUT nulled every one. The key set is the GENERATED one — the
    // same constant `updateDecision` uses — not a list written here.
    const keys = bodyKeysOf<DecisionIn>()(PUT_BODY_PROPERTIES.DecisionIn);
    const stored: Record<string, unknown> = {
      id: '0191c0de-0000-7000-8000-00000000d001',
      slug: 'adr-7',
      tenant_id: 'tenant-a',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      title: 'Use Postgres',
      context: 'old context',
      decision: 'old decision',
      status: 'accepted',
      card_id: 'planka-card-42',
      phase: 'execution',
      raised_at: '2026-10-01T09:00:00Z',
      decided_at: '2026-10-03T09:00:00Z',
      decided_by_kind: 'human',
      created_by_user_id: 'user-author',
      origin_kind: 'project',
      origin_project_id: 'P-9',
      stable_key: 'card-42:decision:1',
      version_status: 'published',
    };
    const editorBody = { title: 'Use Postgres 18', context: 'new context', decision: 'new decision', status: 'accepted' };
    const put = (await mergeReplacingUpdate(async () => stored, editorBody, keys)) as Record<string, unknown>;

    for (const key of ['card_id', 'phase', 'raised_at', 'decided_at', 'decided_by_kind', 'created_by_user_id', 'origin_kind', 'origin_project_id', 'stable_key', 'version_status']) {
      expect(put[key], key).toBe(stored[key]);
    }
    expect(put.title).toBe('Use Postgres 18');
    expect(put.context).toBe('new context');
    for (const key of ['id', 'slug', 'tenant_id', 'created_at', 'updated_at']) {
      expect(Object.hasOwn(put, key), key).toBe(false);
    }
  });

  test('every replacing RM PUT body fr builds carries every stored field it was not asked to change', async () => {
    // Over EVERY schema fr writes through the helper (discovered from the source,
    // not listed): a row carrying a sentinel in every generated key, an edit that
    // names none of them ⇒ every key but NEVER_PRESERVE comes back untouched. A
    // field RM adds tomorrow is in this set the moment the snapshot is regenerated.
    const used = new Set<string>();
    for (const file of walkSrc(join(INTEGRATIONS, '..'))) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('bodyKeysOf')) continue;
      for (const m of src.matchAll(/PUT_BODY_PROPERTIES\.(\w+)/g)) used.add(m[1]!);
    }
    // Floor: the six RM resources plus TOC and the UML / occurrence bodies.
    // Non-vacuity only — the loop below asserts every discovered schema.
    expect(used.size).toBeGreaterThan(0);
    const table = PUT_BODY_PROPERTIES as Record<string, readonly string[]>;
    const lost: string[] = [];
    for (const schema of [...used].sort()) {
      const keys = table[schema];
      expect(keys, schema).toBeDefined();
      const stored = Object.fromEntries(keys!.map((k) => [k, `stored:${k}`]));
      const put = (await mergeReplacingUpdate(async () => stored, {}, keys!)) as Record<string, unknown>;
      for (const k of keys!) {
        if (NEVER_PRESERVE.has(k)) continue;
        if (put[k] !== `stored:${k}`) lost.push(`${schema}.${k}`);
      }
    }
    expect(lost).toEqual([]);
  });

  test('the generated PUT_BODY_PROPERTIES are the committed snapshot\'s schemas', () => {
    // The derivation, re-measured: a stale or hand-edited table would carry
    // fields through by a list nobody regenerated.
    const spec = JSON.parse(readFileSync(REQUIREMENTS_SPEC, 'utf8')) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const table = PUT_BODY_PROPERTIES as Record<string, readonly string[]>;
    // Non-vacuity only: the per-schema equality below is the assertion.
    expect(Object.keys(table).length).toBeGreaterThan(0);
    for (const [schema, keys] of Object.entries(table)) {
      expect([...keys].sort(), schema).toEqual(Object.keys(spec.components.schemas[schema]?.properties ?? {}).sort());
    }
  });

  test('every DOCUMENT_UPSERT exemption still writes one document under one address', () => {
    const spec = JSON.parse(readFileSync(REQUIREMENTS_SPEC, 'utf8')) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const broken = [...DOCUMENT_UPSERT].flatMap(([key, { schema, address, document }]) => {
      const props = Object.keys(spec.components.schemas[schema]?.properties ?? {}).sort();
      const body = SUBJECTS.find((s) => s.key === key)?.body ?? '';
      const out: string[] = [];
      if (JSON.stringify(props) !== JSON.stringify([address, document].sort())) out.push(`${key}: ${schema} is now [${props}]`);
      if (!/method:\s*'PUT'/.test(body)) out.push(`${key}: no PUT`);
      return out;
    });
    expect(DOCUMENT_UPSERT.size).toBeGreaterThan(0);
    expect(broken).toEqual([]);
  });

  test('an explicit undefined in the caller body does not blank a stored field', async () => {
    // `JSON.stringify` drops `undefined`, so letting it through would reproduce
    // the omitted-key bug one field at a time. `null` is the way to clear.
    const merged = (await mergeReplacingUpdate(
      async () => ({ title: 'kept', description: 'kept too' }),
      { title: 'new', description: undefined } as Record<string, unknown>,
      ['title', 'description'],
    )) as Record<string, unknown>;
    expect(merged.description).toBe('kept too');

    const cleared = (await mergeReplacingUpdate(
      async () => ({ title: 'kept', description: 'kept too' }),
      { title: 'new', description: null } as Record<string, unknown>,
      ['title', 'description'],
    )) as Record<string, unknown>;
    expect(cleared.description).toBeNull();
  });
});
