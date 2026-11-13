// scripts/remap-user-sub.ts — re-key ONE fr user from one Keycloak `sub` to another, in one transaction.
//
// Why: realm-per-app (fr cutover, 2026-10-22). fr users move from Keycloak realm `portal` to realm `fr`.
// A user who MOVES keeps their id and needs nothing here. A user who is COPIED (fr-test, Ola, …) gets a
// NEW Keycloak id in realm `fr` — and fr keys its data on the sub: there is no users table, the sub sits
// in ~60 plain columns (projects.owner_id, user_roles.user_id, signup_approvals.kc_user_id, …). This
// script moves all of them. Port of commonpractice backend/scripts/remap-user-sub.ts (CP #481).
//
//   bun run scripts/remap-user-sub.ts --from <old sub> --to <new sub>             # dry run (default)
//   bun run scripts/remap-user-sub.ts --from <old sub> --to <new sub> --apply     # remap
//   bun run scripts/remap-user-sub.ts --from <old> --to <new> --resolve-preexisting --email <addr>
//                                     [--moved-after <ISO>] [--apply]
//
// WHICH COLUMNS. fr has no users table, so no foreign key can be discovered — every column is LISTED
// below, in exactly one of three lists:
//   SUB_COLUMNS     — hold a sub; rewritten. A text column also matches the tagged form `<kind>:<sub>`
//                     (priority_change_events.priority_set_by = `human:<sub>`), and the tag is kept.
//                     A uuid[]/text[] column has the element replaced (none listed since 2026-11-03).
//   LEDGER_COLUMNS  — hold a sub but sit on an APPEND-ONLY table (a trigger refuses UPDATE): counted
//                     and reported, never rewritten. They record who acted at the time.
//   NOT_SUB_COLUMNS — name looks like a person, value is not a sub (emails, worker names, row ids).
// Before anything else the run asks the LIVE database for every text/uuid/array column whose name looks
// person-shaped (CANDIDATE_NAME_RE) and REFUSES if one is in none of the lists, or if a listed column is
// missing. tests/integration/scripts/remap-user-sub.integration.test.ts fails the same way in CI, so a
// new sub-bearing column cannot be added without classifying it here.
// jsonb is NOT rewritten (projects.project_data, comments.mentions, …): the run COUNTS rows whose jsonb
// text contains --from and prints them, so the operator sees what is left behind.
//
// PRE-EXISTING --to ROWS (the user used fr with the NEW sub before this ran). Without
// --resolve-preexisting the run refuses and prints what references --to. With it, the same transaction
// first DELETEs --to's rows, then re-keys as usual — but ONLY for a stub of the SAME PERSON:
//   * --email <addr> is required, every email fr has on record for --from AND --to (signup_approvals,
//     provisioning_audit, user_channel_prefs channel='email') equals it case-insensitively, and at least
//     one such email exists — otherwise it is unprovable that both subs are one person;
//   * --to is referenced ONLY in STUB_TABLES (sessions, notification prefs/channels, notifications, in-app
//     messages — per-user state that is disposable), each row created at/after --moved-after
//     (default: now() - 24h). Anything else ⇒ refused, merge by hand.
// Still a dry run unless --apply is also given.
//
// WHAT --apply DOES, IN ONE TRANSACTION (BEGIN … COMMIT; no session-level SET — fr reaches Postgres
// through PgBouncer in transaction pooling):
//   1. classify + count (as the dry run); refuse on an unclassified column or an unresolvable --to;
//   2. delete a verified --to stub (if --resolve-preexisting);
//   3. UPDATE every SUB_COLUMNS column from --from to --to;
//   4. re-count: any SUB_COLUMNS row still on --from, or fewer rows on --to than moved ⇒ throw ⇒ ROLLBACK.
// The dry run runs the same steps 1 inside a READ ONLY transaction and writes nothing.
// Idempotent: --from unreferenced (SUB_COLUMNS) and --to referenced ⇒ "already remapped", exit 0.
//
// Exit: 0 ok · 1 usage / refused / rolled back (nothing written).
import type postgres from 'postgres';

export interface ListedColumn {
  table: string;
  column: string;
}

/** Columns holding a Keycloak sub — rewritten by --apply. */
export const SUB_COLUMNS: ReadonlyArray<ListedColumn> = [
  { table: 'action_idempotency', column: 'user_id' },
  { table: 'agent_runtime_sessions', column: 'user_id' },
  { table: 'agent_sessions', column: 'user_id' },
  { table: 'agent_members', column: 'created_by' },
  { table: 'analytics_rollups', column: 'user_id' },
  { table: 'approval_decisions', column: 'approver_id' },
  { table: 'approvals', column: 'approver_user_id' },
  { table: 'approvals', column: 'requester_id' },
  { table: 'approvals', column: 'voided_by' }, // free-text operator id; a sub when a person voided
  { table: 'asset_assignments', column: 'assigned_by' },
  { table: 'asset_bindings', column: 'bound_by_user_id' }, // sub, or `workflow:<run>` (never matches)
  { table: 'budget_topups', column: 'actor_user_id' },
  { table: 'capability_audit', column: 'user_id' },
  { table: 'card_drafts', column: 'assignee_user_id' },
  { table: 'card_drafts', column: 'drafter_id' },
  { table: 'channels', column: 'created_by_user_id' },
  { table: 'coding_analysis_runs', column: 'user_id' },
  { table: 'comments', column: 'author_id' },
  { table: 'department_members', column: 'user_id' },
  { table: 'documents', column: 'user_id' },
  { table: 'engagement_deliveries', column: 'recipient_user_id' },
  { table: 'finding_suppression_events', column: 'actor' },
  { table: 'finding_suppressions', column: 'decided_by' },
  { table: 'github_app_installations', column: 'installed_by_user_id' },
  { table: 'inapp_messages', column: 'user_id' },
  { table: 'katas', column: 'opened_by' }, // 'coach' | 'super_admin:<sub>' (tagged)
  { table: 'katas', column: 'cord_released_by' }, // 'super_admin:<sub>' (tagged; George 2026-11-04 Release)
  { table: 'member_knowledge_areas', column: 'assigned_by' },
  { table: 'member_knowledge_areas', column: 'user_id' },
  { table: 'n8n_execution_mapping', column: 'user_id' },
  { table: 'notification_log', column: 'recipient' }, // phone | email | user id — only the sub matches
  { table: 'notification_prefs', column: 'user_id' },
  { table: 'notifications', column: 'user_id' },
  { table: 'priority_change_events', column: 'actor_id' },
  { table: 'priority_change_events', column: 'priority_set_by' }, // `human:<sub>` | `operator:<sub>`
  { table: 'project_asset_copy_intents', column: 'claimed_by' },
  { table: 'project_conveyor_failures', column: 'resumed_by' },
  { table: 'project_conveyor_start_attempts', column: 'requested_by' },
  { table: 'project_outlines', column: 'decided_by' },
  { table: 'project_outlines', column: 'proposed_by' },
  { table: 'project_requests', column: 'created_by' },
  { table: 'project_requests', column: 'reviewed_by' },
  { table: 'project_stakeholders', column: 'user_id' },
  { table: 'projects', column: 'owner_id' },
  { table: 'projects', column: 'andon_engaged_by' },
  { table: 'provisioning_audit', column: 'actor_user_id' },
  { table: 'provisioning_audit', column: 'target_user_id' },
  { table: 'repositories', column: 'user_id' },
  { table: 'required_approvers', column: 'user_id' },
  { table: 'scheduled_trigger_runs', column: 'triggered_by_user_id' },
  { table: 'scheduled_triggers', column: 'created_by_user_id' },
  { table: 'signup_approvals', column: 'decided_by' },
  { table: 'signup_approvals', column: 'decider_actor' }, // sub, or `telegram:<id>` (never matches)
  { table: 'signup_approvals', column: 'kc_user_id' },
  { table: 'streams', column: 'andon_engaged_by' },
  { table: 'suggested_schedules', column: 'user_id' },
  { table: 'user_channel_prefs', column: 'user_id' },
  { table: 'user_roles', column: 'granted_by' },
  { table: 'user_roles', column: 'user_id' },
  { table: 'user_secrets', column: 'user_id' },
];

/**
 * Columns that may hold a sub on APPEND-ONLY tables (a trigger refuses UPDATE — migration 162, and
 * migration 215 for the super_admin tenant audit): counted, never rewritten.
 */
export const LEDGER_COLUMNS: ReadonlyArray<ListedColumn> = [
  { table: 'card_done_overrides', column: 'actor_id' },
  { table: 'card_computed_checks', column: 'written_by' },
  { table: 'super_admin_tenant_actions', column: 'actor_user_id' },
];

/** Person-shaped names whose values are NOT a Keycloak sub. `table.column` → why. */
export const NOT_SUB_COLUMNS: Readonly<Record<string, string>> = {
  'agent_members.user_id': 'synthetic agent principal, a version-8 UUID (fr #1683), never a Keycloak sub',
  'agent_sessions.replaced_by': 'id of the successor agent_sessions row',
  'analytics_rollups.initiator': "label: 'user' | 'agent' | 'cron' | 'unknown'",
  'andon_state.engaged_by': 'email of the super_admin who pulled the global cord',
  'andon_state_history.changed_by': 'email (same writer as andon_state.engaged_by)',
  'approval_decisions.decided_by_kind': "label: 'human' | 'triage_agent' | 'rule' (migration 211)",
  'approval_decisions.required_approver_id': 'id of the required_approvers roster row discharged',
  'capability_audit.initiator': "label: 'user' | 'agent' | …",
  'card_done_overrides.done_by': "CHECK = 'human_override'",
  'card_drafts.initiator': "label: 'user' | 'agent' | 'cron'",
  'card_phase_lease.holder': 'phase-writer name (ready-prefetch, watchdog, …)',
  'card_plan_events.actor_execution_id': 'n8n execution id',
  'card_plan_events.computed_by': "'rule' | 'invest_t' provenance",
  'decompositions.computed_by': "'rule' | 'invest_t' provenance",
  'engagement_deliveries.recipient_address': 'channel address (phone / email / webhook)',
  'family_decisions.superseded_by': 'id of the superseding family_decisions row',
  'github_app_installations.github_user_login': 'GitHub login, not a Keycloak sub',
  'priority_change_events.actor_kind': "label: 'user' | 'operator' | 'conveyor'",
  'priority_change_events.actor_name': 'display name',
  'priority_change_events.actor_username': 'Keycloak username (not the sub)',
  'project_reports.generated_by': "'n8n' | 'manual'",
  'streams.owner_dept_id': 'departments.id',
};

/** Postgres regex over column names: what "looks like it could hold a person". */
export const CANDIDATE_NAME_RE =
  '(^|_)(user|users|owner|actor|assignee|approver|requester|author|creator|drafter|reviewer|decider|recipient|' +
  'member|subject|sub|principal|grantee|holder|initiator|operator)(_|$)|_by($|_)|(^|_)kc_|keycloak';

/** Per-user disposable state a --to stub may hold; deleted by --resolve-preexisting. */
export const STUB_TABLES: ReadonlyArray<{ table: string; column: string; createdAt: string }> = [
  { table: 'agent_sessions', column: 'user_id', createdAt: 'created_at' },
  { table: 'notification_prefs', column: 'user_id', createdAt: 'created_at' },
  { table: 'user_channel_prefs', column: 'user_id', createdAt: 'created_at' },
  { table: 'notifications', column: 'user_id', createdAt: 'created_at' },
  { table: 'inapp_messages', column: 'user_id', createdAt: 'created_at' },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class RemapRefused extends Error {}

export interface RemapOptions {
  resolvePreexisting?: boolean;
  /** required with resolvePreexisting: the person's email */
  email?: string | null;
  /** ISO timestamp of the Keycloak move; stub rows must be created at/after it. Default now() - 24h */
  movedAfter?: string | null;
}

type Kind = 'uuid' | 'text' | 'array';
export interface ResolvedColumn extends ListedColumn {
  kind: Kind;
  elem?: 'uuid' | 'text';
  ledger: boolean;
}
export interface ColumnCount extends ResolvedColumn {
  rows: number;
}
export interface Preexisting {
  refs: ColumnCount[];
  emails: { from: string[]; to: string[] };
  movedAfter: string;
  /** stub rows per STUB_TABLES table (deleted by --resolve-preexisting) */
  stubRows: { table: string; rows: number }[];
  blockers: string[];
}
export interface RemapPlan {
  state: 'ready' | 'already_remapped';
  columns: ColumnCount[];
  /** SUB_COLUMNS rows that --apply rewrites */
  total: number;
  /** LEDGER_COLUMNS rows that stay on --from */
  ledgerRows: number;
  /** jsonb columns whose text contains --from (reported, not rewritten) */
  json: { table: string; column: string; rows: number }[];
  preexisting?: Preexisting;
}

type Tx = postgres.TransactionSql;
const q = async <T>(tx: Tx, text: string, params: unknown[] = []): Promise<T[]> =>
  (await tx.unsafe(text, params as never[])) as unknown as T[];
const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const key = (c: ListedColumn): string => `${c.table}.${c.column}`;

/** Every person-shaped column in the live database that none of the three lists classifies. */
export async function unclassifiedColumns(tx: Tx): Promise<string[]> {
  const found = await q<{ k: string }>(
    tx,
    `SELECT c.table_name || '.' || c.column_name AS k
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.udt_name IN ('text', 'uuid', 'varchar', '_uuid', '_text')
        AND c.column_name ~ $1
      ORDER BY 1`,
    [CANDIDATE_NAME_RE],
  );
  const listed = new Set([...SUB_COLUMNS.map(key), ...LEDGER_COLUMNS.map(key), ...Object.keys(NOT_SUB_COLUMNS)]);
  return found.map((r) => r.k).filter((k) => !listed.has(k));
}

/** SUB_COLUMNS + LEDGER_COLUMNS with their live type; refuses if one is missing or of an unhandled type. */
export async function resolveColumns(tx: Tx): Promise<ResolvedColumn[]> {
  const out: ResolvedColumn[] = [];
  for (const [list, ledger] of [
    [SUB_COLUMNS, false],
    [LEDGER_COLUMNS, true],
  ] as const) {
    for (const c of list) {
      const [r] = await q<{ udt: string }>(
        tx,
        `SELECT udt_name::text AS udt FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [c.table, c.column],
      );
      if (!r) throw new RemapRefused(`expected column ${key(c)} is missing — update scripts/remap-user-sub.ts`);
      const kind: Kind | null =
        r.udt === 'uuid' ? 'uuid' : r.udt === 'text' || r.udt === 'varchar' ? 'text' : r.udt === '_uuid' || r.udt === '_text' ? 'array' : null;
      if (!kind) throw new RemapRefused(`column ${key(c)} has unhandled type ${r.udt}`);
      out.push({ ...c, kind, ...(kind === 'array' ? { elem: r.udt === '_uuid' ? 'uuid' : 'text' } : {}), ledger } as ResolvedColumn);
    }
  }
  return out;
}

/** WHERE clause matching `sub` ($1) in column c. `sub` is a validated lowercase UUID. */
function matchSql(c: ResolvedColumn): string {
  const col = ident(c.column);
  if (c.kind === 'uuid') return `${col} = $1::uuid`;
  if (c.kind === 'array') return `$1::${c.elem} = ANY(${col})`;
  // text: the bare sub, or the tagged form `<kind>:<sub>` (priority_set_by)
  return `(${col} = $1 OR ${col} ~ ('^[A-Za-z_-]+:' || $1 || '$'))`;
}

async function countRefs(tx: Tx, cols: ResolvedColumn[], sub: string): Promise<ColumnCount[]> {
  const out: ColumnCount[] = [];
  for (const c of cols) {
    const [r] = await q<{ n: number }>(tx, `SELECT count(*)::int AS n FROM public.${ident(c.table)} WHERE ${matchSql(c)}`, [sub]);
    out.push({ ...c, rows: Number(r?.n ?? 0) });
  }
  return out;
}

async function jsonMentions(tx: Tx, sub: string): Promise<{ table: string; column: string; rows: number }[]> {
  const cols = await q<{ t: string; c: string }>(
    tx,
    `SELECT c.table_name::text AS t, c.column_name::text AS c FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.udt_name IN ('json', 'jsonb')
      ORDER BY 1, 2`,
  );
  const out: { table: string; column: string; rows: number }[] = [];
  for (const { t, c } of cols) {
    const [r] = await q<{ n: number }>(
      tx,
      `SELECT count(*)::int AS n FROM public.${ident(t)} WHERE strpos(${ident(c)}::text, $1) > 0`,
      [sub],
    );
    if (Number(r?.n ?? 0) > 0) out.push({ table: t, column: c, rows: Number(r!.n) });
  }
  return out;
}

/** Every email fr has on record for a sub (lowercased, distinct). */
export async function emailsOnRecord(tx: Tx, sub: string): Promise<string[]> {
  const r = await q<{ e: string }>(
    tx,
    `SELECT DISTINCT e FROM (
       SELECT lower(email) AS e FROM public.signup_approvals WHERE kc_user_id::text = $1::text AND email IS NOT NULL
       UNION ALL
       SELECT lower(target_email) FROM public.provisioning_audit WHERE target_user_id = $1::text AND target_email IS NOT NULL
       UNION ALL
       SELECT lower(address) FROM public.user_channel_prefs WHERE user_id = $1::text AND channel = 'email'
     ) x WHERE e <> '' ORDER BY 1`,
    [sub],
  );
  return r.map((x) => x.e);
}

async function inspectPreexisting(
  tx: Tx,
  from: string,
  refs: ColumnCount[],
  to: string,
  o: RemapOptions,
): Promise<Preexisting> {
  const blockers: string[] = [];
  const stubKeys = new Set(STUB_TABLES.map((s) => `${s.table}.${s.column}`));
  const other = refs.filter((c) => !stubKeys.has(key(c)));
  if (other.length) blockers.push(`--to is referenced outside the stub tables: ${fmt(other)}`);

  const [cut] = await q<{ cutoff: string }>(
    tx,
    `SELECT to_char((COALESCE($1::timestamptz, now() - interval '24 hours')) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cutoff`,
    [o.movedAfter ?? null],
  );
  const movedAfter = cut!.cutoff;
  const stubRows: { table: string; rows: number }[] = [];
  for (const s of STUB_TABLES) {
    const [r] = await q<{ n: number; old: number }>(
      tx,
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE ${ident(s.createdAt)} < $2::timestamptz)::int AS old
         FROM public.${ident(s.table)} WHERE ${ident(s.column)} = $1`,
      [to, movedAfter],
    );
    if (Number(r?.n ?? 0) > 0) stubRows.push({ table: s.table, rows: Number(r!.n) });
    if (Number(r?.old ?? 0) > 0) blockers.push(`${s.table}: ${r!.old} row(s) for --to created before --moved-after ${movedAfter}`);
  }

  const emails = { from: await emailsOnRecord(tx, from), to: await emailsOnRecord(tx, to) };
  const want = (o.email ?? '').trim().toLowerCase();
  if (!want) blockers.push('--email <addr> is required with --resolve-preexisting');
  else {
    const all = [...emails.from, ...emails.to];
    if (!all.length) blockers.push(`fr has no email on record for --from or --to — cannot prove they are one person`);
    const wrong = [...new Set(all.filter((e) => e !== want))];
    if (wrong.length) blockers.push(`email(s) on record differ from --email: ${wrong.join(', ')} — a DIFFERENT person`);
  }
  return { refs, emails, movedAfter, stubRows, blockers };
}

export function preexistingPlan(from: string, to: string, p: Preexisting): string {
  const head = `--to ${to} is already referenced (${fmt(p.refs)}) — the user used fr with the new sub before this ran.`;
  if (p.blockers.length) {
    return `${head} NOT a removable stub: ${p.blockers.join('; ')}. Merge by hand, then re-run.`;
  }
  return (
    `${head} Plan (one transaction): 1) DELETE --to's stub rows (${p.stubRows.map((s) => `${s.table}=${s.rows}`).join(', ')}; ` +
    `all created after ${p.movedAfter}, same email); 2) re-key ${from} → ${to}. ` +
    `Run with --resolve-preexisting for this dry run, add --apply to do it.`
  );
}

function fmt(cs: ColumnCount[]): string {
  return cs.map((c) => `${key(c)}=${c.rows}`).join(', ');
}

async function preflight(tx: Tx, from: string, to: string, o: RemapOptions): Promise<RemapPlan & { cols: ResolvedColumn[] }> {
  const unclassified = await unclassifiedColumns(tx);
  if (unclassified.length) {
    throw new RemapRefused(
      `unclassified person-shaped column(s): ${unclassified.join(', ')} — add each to SUB_COLUMNS, LEDGER_COLUMNS ` +
        `or NOT_SUB_COLUMNS in scripts/remap-user-sub.ts`,
    );
  }
  const cols = await resolveColumns(tx);
  const fromCounts = await countRefs(tx, cols, from);
  const toRefs = (await countRefs(tx, cols, to)).filter((c) => c.rows > 0);
  const subTotal = fromCounts.filter((c) => !c.ledger).reduce((s, c) => s + c.rows, 0);
  const ledgerRows = fromCounts.filter((c) => c.ledger).reduce((s, c) => s + c.rows, 0);
  const json = await jsonMentions(tx, from);
  if (subTotal === 0 && toRefs.length) {
    return { state: 'already_remapped', columns: fromCounts, total: 0, ledgerRows, json, cols };
  }
  if (subTotal === 0) throw new RemapRefused(`nothing in fr references --from ${from} (and nothing --to) — wrong sub?`);
  let preexisting: Preexisting | undefined;
  if (toRefs.length) {
    preexisting = await inspectPreexisting(tx, from, toRefs, to, o);
    if (!o.resolvePreexisting || preexisting.blockers.length) {
      throw new RemapRefused(preexistingPlan(from, to, preexisting));
    }
  }
  return { state: 'ready', columns: fromCounts, total: subTotal, ledgerRows, json, cols, ...(preexisting ? { preexisting } : {}) };
}

const strip = ({ cols: _c, ...p }: RemapPlan & { cols: ResolvedColumn[] }): RemapPlan => p;

/** The postgres.js client to use (scripts default to fr's pool; tests may inject). */
export type Sql = Pick<postgres.Sql, 'begin'>;

/** Dry run: the per-column counts, inside a READ ONLY transaction. */
export async function planRemap(sqlc: Sql, from: string, to: string, o: RemapOptions = {}): Promise<RemapPlan> {
  return (await sqlc.begin('read only', async (tx) => strip(await preflight(tx, from, to, o))))  as RemapPlan;
}

/** Apply: the whole re-key in ONE transaction; any failure (including the post-check) rolls it back. */
export async function applyRemap(sqlc: Sql, from: string, to: string, o: RemapOptions = {}): Promise<RemapPlan> {
  return (await sqlc.begin(async (tx) => {
    const plan = await preflight(tx, from, to, o);
    if (plan.state === 'already_remapped') return strip(plan);
    if (plan.preexisting) {
      for (const s of STUB_TABLES) {
        await q(tx, `DELETE FROM public.${ident(s.table)} WHERE ${ident(s.column)} = $1`, [to]);
      }
      const left = (await countRefs(tx, plan.cols, to)).filter((c) => c.rows > 0);
      if (left.length) throw new Error(`pre-existing --to rows were not all removed (${fmt(left)}) — rolled back`);
    }
    for (const c of plan.cols) {
      if (c.ledger) continue;
      const col = ident(c.column);
      const set =
        c.kind === 'uuid'
          ? `${col} = $2::uuid`
          : c.kind === 'array'
            ? `${col} = array_replace(${col}, $1::${c.elem}, $2::${c.elem})`
            : `${col} = CASE WHEN ${col} = $1 THEN $2 ELSE left(${col}, length(${col}) - length($1)) || $2 END`;
      await q(tx, `UPDATE public.${ident(c.table)} SET ${set} WHERE ${matchSql(c)}`, [from, to]);
    }
    const subCols = plan.cols.filter((c) => !c.ledger);
    const left = (await countRefs(tx, subCols, from)).filter((c) => c.rows > 0);
    if (left.length) throw new Error(`post-check: --from still referenced (${fmt(left)}) — rolled back`);
    const moved = await countRefs(tx, subCols, to);
    const before = new Map(plan.columns.map((c) => [key(c), c.rows]));
    const short = moved.filter((c) => c.rows < (before.get(key(c)) ?? 0));
    if (short.length) throw new Error(`post-check: rows lost (${fmt(short)}) — rolled back`);
    return strip(plan);
  })) as RemapPlan;
}

export interface Args {
  from: string;
  to: string;
  apply: boolean;
  resolvePreexisting: boolean;
  email: string | null;
  movedAfter: string | null;
}

export function parseArgs(argv: string[]): Args {
  const val = (flag: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? '') : '';
  };
  const from = val('--from').trim().toLowerCase();
  const to = val('--to').trim().toLowerCase();
  if (!UUID.test(from) || !UUID.test(to)) throw new RemapRefused('--from and --to must both be UUIDs (Keycloak subs)');
  if (from === to) throw new RemapRefused('--from and --to are the same');
  const movedAfterRaw = argv.includes('--moved-after') ? val('--moved-after').trim() : '';
  if (argv.includes('--moved-after') && (!movedAfterRaw || Number.isNaN(Date.parse(movedAfterRaw)))) {
    throw new RemapRefused('--moved-after must be an ISO timestamp (the realm-move run time)');
  }
  const email = argv.includes('--email') ? val('--email').trim().toLowerCase() : '';
  if (argv.includes('--email') && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new RemapRefused('--email must be an email address');
  return {
    from,
    to,
    apply: argv.includes('--apply'),
    resolvePreexisting: argv.includes('--resolve-preexisting'),
    email: email || null,
    movedAfter: movedAfterRaw ? new Date(movedAfterRaw).toISOString() : null,
  };
}

export function report(from: string, to: string, plan: RemapPlan, apply: boolean): string[] {
  const out: string[] = [];
  if (plan.state === 'already_remapped') {
    out.push(`[remap] ${from} → ${to}: already remapped (no SUB_COLUMNS row references --from).`);
  } else {
    if (plan.preexisting) out.push(`[remap] pre-existing --to: ${preexistingPlan(from, to, plan.preexisting)}`);
    for (const c of plan.columns) {
      if (c.rows > 0 || !c.ledger) out.push(`[remap] ${key(c)}${c.ledger ? ' (append-only ledger, NOT rewritten)' : ''}: ${c.rows}`);
    }
  }
  for (const j of plan.json) out.push(`[remap] jsonb ${j.table}.${j.column}: ${j.rows} row(s) mention --from — NOT rewritten`);
  if (plan.state === 'ready') {
    out.push(
      `[remap] ${from} → ${to} · ${plan.total} row(s) to re-key · ${plan.ledgerRows} ledger row(s) kept · ` +
        (apply ? 'COMMITTED' : 'DRY RUN — nothing written. Re-run with --apply.'),
    );
  }
  return out;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[remap] ${(e as Error).message}`);
    console.error(
      'usage: bun run scripts/remap-user-sub.ts --from <old sub> --to <new sub> ' +
        '[--resolve-preexisting --email <addr> [--moved-after <ISO>]] [--apply]',
    );
    return 1;
  }
  const { queryClient } = await import('../src/db/client');
  const o: RemapOptions = { resolvePreexisting: args.resolvePreexisting, email: args.email, movedAfter: args.movedAfter };
  try {
    const plan = args.apply
      ? await applyRemap(queryClient, args.from, args.to, o)
      : await planRemap(queryClient, args.from, args.to, o);
    for (const line of report(args.from, args.to, plan, args.apply)) console.log(line);
    return 0;
  } catch (e) {
    console.error(`[remap] REFUSED/ROLLED BACK — nothing written: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main();
  } finally {
    const { closeConnection } = await import('../src/db/client');
    await closeConnection();
  }
  process.exit(code);
}
