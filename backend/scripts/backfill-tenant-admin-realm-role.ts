// Backfill: give the Keycloak realm role `tenant_admin` to every existing fr
// workspace-admin (fr#1289 — George: "a fr admin is a tenant_admin").
//
// New grants get the realm role via the write-through in
// services/tenant-admin-sync.ts. Rows granted BEFORE that write-through existed
// only live in `user_roles`; this script closes that gap once.
//
// SAFETY
//   - Dry-run by DEFAULT: classifies every row and prints what it would do.
//   - `--apply` is required to write, and is REFUSED unless
//     `isTenantAdminWriteThroughEnabled()` is true (FR_TENANT_ADMIN_WRITE_THROUGH).
//     The backfill must never be the thing that switches the feature on: if the
//     write-through is off, new grants would not get the role and the estate
//     would be half-migrated.
//   - Only WOULD_ADD rows are written, each through `syncTenantAdminGrant`, the
//     same guarded path the live route uses (it re-checks super-admin / tenant
//     mismatch itself — this classification is a report, not the fence).
//   - A user Keycloak does not know is an ORPHAN grant (deleted account): it is
//     reported, never thrown on and never written.
//   - Exit is non-zero when any lookup errored (a row we could not classify is
//     not a row we may silently skip) or, with --apply, any sync 'failed'.
//
// Usage (inside the fr-backend pod — it carries DATABASE_URL + Keycloak env):
//   bun run scripts/backfill-tenant-admin-realm-role.ts            # dry-run
//   bun run scripts/backfill-tenant-admin-realm-role.ts --apply    # write
//
// The rules live in pure exported functions; the CLI body sits behind
// `import.meta.main` and imports the DB / Keycloak modules lazily so the unit
// test can load this file without a database.

// Dependency-free (no DB / Keycloak import), so the unit test still loads cleanly.
import { isKeycloakNotFoundError } from '../src/lib/keycloak-not-found';

export const BACKFILL_ACTOR_ID ='backfill-tenant-admin-realm-role';
export const TENANT_ADMIN_REALM_ROLE = 'tenant_admin';
export const SUPER_ADMIN_REALM_ROLE = 'super_admin';

export interface UserTenantAndRoles {
  tenantId: string | null;
  directRoles: string[];
  effectiveRoles: string[];
  enabled: boolean;
}

export type LookupResult =
  | { kind: 'found'; info: UserTenantAndRoles }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

export type BackfillClass =
  | 'orphan'
  | 'lookup_failed'
  | 'skipped_super_admin'
  | 'skipped_no_tenant'
  | 'skipped_tenant_mismatch'
  | 'already_holder'
  | 'WOULD_ADD';

export const BACKFILL_CLASSES: readonly BackfillClass[] = [
  'WOULD_ADD',
  'already_holder',
  'orphan',
  'skipped_super_admin',
  'skipped_no_tenant',
  'skipped_tenant_mismatch',
  'lookup_failed',
] as const;

export type SyncOutcome =
  | 'disabled'
  | 'added'
  | 'already'
  | 'skipped_no_tenant'
  | 'skipped_tenant_mismatch'
  | 'skipped_super_admin'
  | 'skipped_user_absent'
  | 'failed';

export interface AdminGrantRow {
  user_id: string;
  tenant_id: string;
}

/**
 * Pure: which class a workspace-admin grant falls in, given its Keycloak lookup.
 *
 * Mirrors `precheck` + `assignRealmTenantAdmin` in services/tenant-admin-sync.ts
 * so the dry-run predicts what `--apply` will do:
 *   - tenant checks, then super_admin (EFFECTIVE roles — its composite includes
 *     tenant_admin, and a super-admin must never be stamped with a tenant role);
 *   - "already" means a DIRECT `tenant_admin` mapping. A composite-only holder
 *     is WOULD_ADD, because the sync gives it an explicit mapping so fr's grant
 *     is not contingent on some unrelated role/group staying in place.
 */
export function classifyGrant(row: AdminGrantRow, lookup: LookupResult): BackfillClass {
  if (lookup.kind === 'not_found') return 'orphan';
  if (lookup.kind === 'error') return 'lookup_failed';
  const { info } = lookup;
  if (!info.tenantId) return 'skipped_no_tenant';
  if (info.tenantId !== row.tenant_id) return 'skipped_tenant_mismatch';
  if (info.effectiveRoles.includes(SUPER_ADMIN_REALM_ROLE)) return 'skipped_super_admin';
  if (info.directRoles.includes(TENANT_ADMIN_REALM_ROLE)) return 'already_holder';
  return 'WOULD_ADD';
}

/**
 * Pure: does this thrown value mean "Keycloak has no such user"? One
 * definition, shared with the live write-through — see
 * src/lib/keycloak-not-found.ts.
 */
export const isNotFoundError = isKeycloakNotFoundError;

/** Pure: the reason `--apply` must be refused, or null when it may proceed. */
export function applyRefusal(apply: boolean, writeThroughEnabled: boolean): string | null {
  if (!apply) return null;
  if (!writeThroughEnabled) {
    return (
      'refusing --apply: FR_TENANT_ADMIN_WRITE_THROUGH is not enabled. Enable the ' +
      'write-through first so new grants also receive tenant_admin; the backfill ' +
      'must not be the switch that turns the feature on.'
    );
  }
  return null;
}

export interface BackfillDeps {
  apply: boolean;
  listAdminGrants: () => Promise<AdminGrantRow[]>;
  getUserTenantAndRoles: (userId: string) => Promise<UserTenantAndRoles | null>;
  isWriteThroughEnabled: () => boolean;
  syncTenantAdminGrant: (userId: string, tenantId: string, actorId: string) => Promise<SyncOutcome>;
  log: (line: string) => void;
}

export interface ClassifiedRow extends AdminGrantRow {
  cls: BackfillClass;
  enabled: boolean | null;
  kcTenant: string | null;
  detail?: string;
  outcome?: SyncOutcome;
}

export interface BackfillResult {
  exitCode: number;
  refused: boolean;
  rows: ClassifiedRow[];
  counts: Record<BackfillClass, number>;
  outcomes: Partial<Record<SyncOutcome, number>>;
}

async function lookupUser(
  deps: BackfillDeps,
  userId: string,
): Promise<LookupResult> {
  try {
    const info = await deps.getUserTenantAndRoles(userId);
    return info ? { kind: 'found', info } : { kind: 'not_found' };
  } catch (err) {
    if (isNotFoundError(err)) return { kind: 'not_found' };
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** The whole run, with every side effect injected. */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const counts = Object.fromEntries(BACKFILL_CLASSES.map((c) => [c, 0])) as Record<BackfillClass, number>;
  const outcomes: Partial<Record<SyncOutcome, number>> = {};

  // Refuse BEFORE reading anything: a refused apply must not look like a run.
  const refusal = applyRefusal(deps.apply, deps.isWriteThroughEnabled());
  if (refusal) {
    deps.log(`[backfill-tenant-admin] ${refusal}`);
    return { exitCode: 2, refused: true, rows: [], counts, outcomes };
  }

  deps.log(`[backfill-tenant-admin] mode: ${deps.apply ? 'APPLY (will write tenant_admin)' : 'DRY-RUN (report only)'}`);
  const grants = await deps.listAdminGrants();
  deps.log(`[backfill-tenant-admin] workspace-admin rows: ${grants.length}`);

  const rows: ClassifiedRow[] = [];
  for (const g of grants) {
    const lookup = await lookupUser(deps, g.user_id);
    const cls = classifyGrant(g, lookup);
    counts[cls] += 1;
    rows.push({
      user_id: g.user_id,
      tenant_id: g.tenant_id,
      cls,
      enabled: lookup.kind === 'found' ? lookup.info.enabled : null,
      kcTenant: lookup.kind === 'found' ? lookup.info.tenantId : null,
      detail: lookup.kind === 'error' ? lookup.message : undefined,
    });
  }

  deps.log('class                    user_id                               fr_tenant                             kc_tenant                             enabled');
  for (const r of rows) {
    deps.log(
      `${r.cls.padEnd(24)} ${r.user_id.padEnd(37)} ${r.tenant_id.padEnd(37)} ${(r.kcTenant ?? '-').padEnd(37)} ${
        r.enabled === null ? '-' : String(r.enabled)
      }${r.detail ? `  (${r.detail})` : ''}`,
    );
  }
  deps.log(
    `[backfill-tenant-admin] counts: ${BACKFILL_CLASSES.map((c) => `${c}=${counts[c]}`).join(' ')}`,
  );

  let exitCode = counts.lookup_failed > 0 ? 1 : 0;

  if (!deps.apply) {
    deps.log('[backfill-tenant-admin] dry-run complete — re-run with --apply to write WOULD_ADD rows.');
    return { exitCode, refused: false, rows, counts, outcomes };
  }

  for (const r of rows) {
    if (r.cls !== 'WOULD_ADD') continue;
    let outcome: SyncOutcome;
    try {
      outcome = await deps.syncTenantAdminGrant(r.user_id, r.tenant_id, BACKFILL_ACTOR_ID);
    } catch (err) {
      outcome = 'failed';
      r.detail = err instanceof Error ? err.message : String(err);
    }
    r.outcome = outcome;
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    deps.log(`  [sync] ${r.user_id} tenant=${r.tenant_id} -> ${outcome}${r.detail ? ` (${r.detail})` : ''}`);
  }
  deps.log(
    `[backfill-tenant-admin] outcomes: ${
      Object.entries(outcomes).map(([k, v]) => `${k}=${v}`).join(' ') || '(nothing to write)'
    }`,
  );
  // 'disabled' mid-run means the flag flipped under us: nothing was written, say so loudly.
  if ((outcomes.failed ?? 0) > 0 || (outcomes.disabled ?? 0) > 0) exitCode = 1;
  return { exitCode, refused: false, rows, counts, outcomes };
}

if (import.meta.main) {
  const { db, closeConnection } = await import('../src/db/client');
  const { listAllGrants } = await import('../src/services/user-roles');
  const { keycloak } = await import('../src/services/keycloak');
  const sync = await import('../src/services/tenant-admin-sync');
  let code = 1;
  try {
    const result = await runBackfill({
      apply: process.argv.includes('--apply'),
      listAdminGrants: async () =>
        (await listAllGrants(db))
          .filter((g) => g.role === 'workspace-admin')
          .map((g) => ({ user_id: g.user_id, tenant_id: g.tenant_id })),
      getUserTenantAndRoles: (userId) => keycloak.getUserTenantAndRoles(userId),
      isWriteThroughEnabled: () => sync.isTenantAdminWriteThroughEnabled(),
      syncTenantAdminGrant: (u, t, a) => sync.syncTenantAdminGrant(u, t, a),
      log: (line) => console.log(line),
    });
    code = result.exitCode;
  } finally {
    await closeConnection();
  }
  process.exit(code);
}
