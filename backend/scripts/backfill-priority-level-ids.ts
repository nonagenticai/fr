// Backfill: map every stored P0..P3 priority to its tenant's
// requirements_management priority-level id (design "fr consumes RM
// vocabulary", George's Q3 = (b), migration 188).
//
// WHAT IT MAPS
//   * priority_change_events.from_priority / to_priority → *_priority_level_id,
//     using the ROW's tenant_id;
//   * projects.project_data.priority → project_data.priority_level_id, using the
//     project's own tenant tag (project_data.keycloak_tenant_id).
// A value maps to the tenant level whose NAME equals it case-insensitively
// (P1 → p1). The ids cannot be mapped in SQL: they are per tenant, in RM.
// (Planka's Metadata.priority stays text: it is outside fr's database.)
//
// SAFETY
//   - Dry-run by DEFAULT: reports what it would write. `--apply` writes.
//   - Only rows whose id is still NULL are touched, so a re-run is a no-op and
//     a value written after migration 188 (which carries its id) is never
//     overwritten.
//   - Per tenant, the report says mapped / unmapped / already for both homes,
//     and LISTS every unmapped row (row id, value, why): a tenant with no
//     catalogue (catalogue_not_initialised), a value with no level of that name,
//     or a project with no tenant tag. The FOLLOW-UP migration that drops the
//     legacy text may only run once this reports 0 unmapped for every tenant.
//   - Exit 1 when anything is unmapped (dry-run or apply), 0 otherwise.
//
// Usage (fr-backend pod: DATABASE_URL + REQUIREMENTS_API_URL):
//   bun run scripts/backfill-priority-level-ids.ts            # dry-run
//   bun run scripts/backfill-priority-level-ids.ts --apply    # write

import { sql } from 'drizzle-orm';

import { closeConnection, db } from '../src/db/client';
import { priorities } from '../src/services/catalogue/tenant-catalogue';

interface PriorityLevelRef {
  id: string;
  name: string;
}

interface TenantReport {
  tenant_id: string;
  events_mapped: number;
  events_unmapped: number;
  events_already: number;
  projects_mapped: number;
  projects_unmapped: number;
  projects_already: number;
}

interface UnmappedRow {
  home: 'priority_change_events.from' | 'priority_change_events.to' | 'projects.project_data';
  row_id: string;
  tenant_id: string | null;
  value: string;
  reason: 'catalogue_unavailable' | 'no_level_of_that_name' | 'project_tenant_unknown';
  detail?: string;
}

interface PriorityBackfillResult {
  apply: boolean;
  tenants: TenantReport[];
  unmapped: UnmappedRow[];
}

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => (Array.isArray(r) ? (r as Row[]) : ((r as { rows?: Row[] })?.rows ?? []));

async function runPriorityBackfill(opts: { apply: boolean }): Promise<PriorityBackfillResult> {
  const log = (line: string) => console.log(line);
  const reports = new Map<string, TenantReport>();
  const report = (t: string): TenantReport => {
    let r = reports.get(t);
    if (!r) {
      r = {
        tenant_id: t,
        events_mapped: 0,
        events_unmapped: 0,
        events_already: 0,
        projects_mapped: 0,
        projects_unmapped: 0,
        projects_already: 0,
      };
      reports.set(t, r);
    }
    return r;
  };
  const unmapped: UnmappedRow[] = [];
  const levelCache = new Map<string, { levels: PriorityLevelRef[] } | { error: string }>();
  const levels = async (t: string) => {
    let hit = levelCache.get(t);
    if (!hit) {
      try {
        hit = { levels: (await priorities(t)).map((l) => ({ id: l.id, name: l.name })) };
      } catch (err) {
        hit = { error: err instanceof Error ? err.message : String(err) };
      }
      levelCache.set(t, hit);
    }
    return hit;
  };
  const levelFor = (ls: PriorityLevelRef[], v: string) =>
    ls.find((l) => l.name.toLowerCase() === v.trim().toLowerCase()) ?? null;

  // ── priority_change_events ────────────────────────────────────────────────
  const events = rowsOf(
    await db.execute(sql`
      SELECT id::text AS id, tenant_id::text AS tenant_id,
             from_priority, to_priority,
             from_priority_level_id::text AS from_id, to_priority_level_id::text AS to_id
        FROM priority_change_events
       WHERE from_priority IS NOT NULL OR to_priority IS NOT NULL
       ORDER BY id`),
  );
  for (const e of events) {
    const tenant = String(e.tenant_id);
    const r = report(tenant);
    for (const side of ['from', 'to'] as const) {
      const value = e[`${side}_priority`];
      if (typeof value !== 'string' || value === '') continue;
      if (e[`${side}_id`]) {
        r.events_already += 1;
        continue;
      }
      const ls = await levels(tenant);
      const home = `priority_change_events.${side}` as const;
      if ('error' in ls) {
        r.events_unmapped += 1;
        unmapped.push({ home, row_id: String(e.id), tenant_id: tenant, value, reason: 'catalogue_unavailable', detail: ls.error });
        continue;
      }
      const level = levelFor(ls.levels, value);
      if (!level) {
        r.events_unmapped += 1;
        unmapped.push({ home, row_id: String(e.id), tenant_id: tenant, value, reason: 'no_level_of_that_name' });
        continue;
      }
      r.events_mapped += 1;
      if (opts.apply) {
        if (side === 'from') {
          await db.execute(sql`UPDATE priority_change_events SET from_priority_level_id = ${level.id}::uuid
                                  WHERE id = ${String(e.id)}::bigint AND from_priority_level_id IS NULL`);
        } else {
          await db.execute(sql`UPDATE priority_change_events SET to_priority_level_id = ${level.id}::uuid
                                  WHERE id = ${String(e.id)}::bigint AND to_priority_level_id IS NULL`);
        }
      }
    }
  }

  // ── projects.project_data ────────────────────────────────────────────────
  const projects = rowsOf(
    await db.execute(sql`
      SELECT id::text AS id,
             project_data->>'keycloak_tenant_id' AS tenant_id,
             project_data->>'priority' AS priority,
             project_data->>'priority_level_id' AS level_id
        FROM projects
       WHERE coalesce(project_data->>'priority', '') <> ''
       ORDER BY id`),
  );
  for (const p of projects) {
    const value = String(p.priority);
    const tenant = typeof p.tenant_id === 'string' && p.tenant_id.trim() !== '' ? p.tenant_id.trim() : null;
    if (!tenant) {
      unmapped.push({ home: 'projects.project_data', row_id: String(p.id), tenant_id: null, value, reason: 'project_tenant_unknown' });
      continue;
    }
    const r = report(tenant);
    if (p.level_id) {
      r.projects_already += 1;
      continue;
    }
    const ls = await levels(tenant);
    if ('error' in ls) {
      r.projects_unmapped += 1;
      unmapped.push({ home: 'projects.project_data', row_id: String(p.id), tenant_id: tenant, value, reason: 'catalogue_unavailable', detail: ls.error });
      continue;
    }
    const level = levelFor(ls.levels, value);
    if (!level) {
      r.projects_unmapped += 1;
      unmapped.push({ home: 'projects.project_data', row_id: String(p.id), tenant_id: tenant, value, reason: 'no_level_of_that_name' });
      continue;
    }
    r.projects_mapped += 1;
    if (opts.apply) {
      await db.execute(sql`
        UPDATE projects
           SET project_data = jsonb_set(project_data, '{priority_level_id}', to_jsonb(${level.id}::text))
         WHERE id = ${String(p.id)}::uuid
           AND coalesce(project_data->>'priority_level_id', '') = ''`);
    }
  }

  const tenants = [...reports.values()].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));
  const verb = opts.apply ? 'mapped' : 'would map';
  for (const t of tenants) {
    log(
      `[tenant ${t.tenant_id}] events: ${verb} ${t.events_mapped}, unmapped ${t.events_unmapped}, ` +
        `already ${t.events_already} | projects: ${verb} ${t.projects_mapped}, unmapped ${t.projects_unmapped}, ` +
        `already ${t.projects_already}`,
    );
  }
  for (const u of unmapped) {
    log(`[unmapped] ${u.home} row=${u.row_id} tenant=${u.tenant_id ?? '(none)'} value=${u.value} reason=${u.reason}${u.detail ? ` (${u.detail})` : ''}`);
  }
  log(`[done] apply=${opts.apply} tenants=${tenants.length} unmapped=${unmapped.length}`);
  return { apply: opts.apply, tenants, unmapped };
}

if (import.meta.main) {
  const apply = process.argv.includes('--apply');
  let exit = 0;
  try {
    const result = await runPriorityBackfill({ apply });
    if (result.unmapped.length > 0) exit = 1;
  } catch (err) {
    console.error('[fatal]', err instanceof Error ? (err.stack ?? err.message) : err);
    exit = 1;
  } finally {
    await closeConnection();
  }
  process.exit(exit);
}
