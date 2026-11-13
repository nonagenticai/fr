// src/routes/katas.ts
//
// /api/katas — fr's kata record and the super-admin's one surface for fixing the system
// (docs/design/kata-super-admin.md §5, amended by the kata build contract). The state machine
// lives in services/katas/core.ts; the licence open in services/katas/open.ts.
//
// WHO (no tenant role — workspace-admin included — reaches any of these):
//   * a SUPER-ADMIN: the `super_admin` realm role on a human token (never a licence);
//   * the CONVEYOR LICENCE: a licence caller whose tenant is a conveyor tenant (v4 or AA). The
//     coach on the conveyor n8n and the wf_change flows on kata-n8n share it.
//
//   operationId    route                          caller
//   listKatas      GET   /api/katas               super-admin
//   getKata        GET   /api/katas/:id           super-admin, conveyor licence
//   openKata       POST  /api/katas               conveyor licence (opens) · super-admin (hand-open → coach)
//   updateKata     PATCH /api/katas/:id           conveyor licence
//   closeKata      POST  /api/katas/:id/close     conveyor licence
//   stopKata       POST  /api/katas/:id/stop      super-admin
//   rollbackKata   POST  /api/katas/:id/rollback  super-admin
//   releaseKata    POST  /api/katas/:id/release   super-admin (a FAILED kata's cord; George 2026-11-04)
//
// The licence-door rows are in lib/licence-route-allowlist.ts; the super-admin-only routes are
// NOT on it, so the server refuses a licence there before this module runs.
import { z } from 'zod';

import { KATA_STATES, type KataState } from '../db/schema';
import { validateAuth } from '../middleware/auth';
import { AA_CONVEYOR_TENANT_ID, V4_CONVEYOR_TENANT_ID } from '../middleware/internal-tenant-only';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { isUuidShape } from '../lib/uuid-shape';
import {
  closeKata,
  conveyorPause,
  failedHolderIds,
  holdingKata,
  kataCordView,
  kataStatsWindows,
  kataWindowStats,
  listKataRows,
  markRollbackDelivered,
  patchKata,
  readKata,
  readKataHolderSet,
  releaseFailedKata,
  requestKataRollback,
  stopKata,
  type KataRow,
} from '../services/katas/core';
import { openKataForLicence } from '../services/katas/open';
import { kataOpenWebhookUnconfigured, kataRollbackWebhookUnconfigured, postKataOpen, postKataRollback } from '../services/katas/webhooks';
import type { User } from '../types/api';
import { AppError, ForbiddenError, NotFoundError, handleError } from '../utils/errors';
import { jsonResponse } from '../utils/response';

// ── who ─────────────────────────────────────────────────────────────────────

export type KataCallerKind = 'super_admin' | 'conveyor_licence';

const CONVEYOR_TENANTS: ReadonlySet<string> = new Set([V4_CONVEYOR_TENANT_ID, AA_CONVEYOR_TENANT_ID]);

/** Pure: which kata caller `user` is, or null (every tenant role, any other licence). */
export function kataCallerKind(user: Pick<User, 'authKind' | 'roles' | 'tenantId'>): KataCallerKind | null {
  if (user.authKind === 'licence') {
    return user.tenantId && CONVEYOR_TENANTS.has(user.tenantId.toLowerCase()) ? 'conveyor_licence' : null;
  }
  return isSuperAdmin(user) ? 'super_admin' : null;
}

/** Each operation's admitted callers — the one table every handler reads. */
export const KATA_ROUTE_CALLERS: Readonly<Record<string, readonly KataCallerKind[]>> = {
  listKatas: ['super_admin'],
  getKata: ['super_admin', 'conveyor_licence'],
  openKata: ['super_admin', 'conveyor_licence'],
  updateKata: ['conveyor_licence'],
  closeKata: ['conveyor_licence'],
  stopKata: ['super_admin'],
  rollbackKata: ['super_admin'],
  releaseKata: ['super_admin'],
};

/** Pure: refuse a caller the operation does not admit (403 `kata_caller_not_allowed`). */
export function assertKataCaller(user: Pick<User, 'authKind' | 'roles' | 'tenantId'>, operationId: keyof typeof KATA_ROUTE_CALLERS): KataCallerKind {
  const kind = kataCallerKind(user);
  const admitted = KATA_ROUTE_CALLERS[operationId] ?? [];
  if (kind === null || !admitted.includes(kind)) {
    throw new ForbiddenError(
      `Katas are a super-admin surface; ${operationId} admits ${admitted.join(' and ').replace(/_/g, ' ')} only. Nothing changed`,
    ).withCode('kata_caller_not_allowed');
  }
  return kind;
}

// ── view ────────────────────────────────────────────────────────────────────

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export function kataView(row: KataRow, holders: ReadonlySet<string>) {
  return {
    id: row.id,
    source_project_id: row.source_project_id,
    source_tenant_id: row.source_tenant_id,
    source_card_id: row.source_card_id,
    source_execution_id: row.source_execution_id,
    source_board_id: row.source_board_id,
    source_phase: row.source_phase,
    symptom: row.symptom,
    opened_by: row.opened_by,
    signature: row.signature,
    root_cause_class: row.root_cause_class,
    target_flow: row.target_flow,
    target_flow_id: row.target_flow_id,
    base_version_id: row.base_version_id,
    published_version_id: row.published_version_id,
    state: row.state,
    state_detail: row.state_detail,
    replay_passed: row.replay_passed,
    replay_total: row.replay_total,
    evidence: row.evidence,
    ops: row.ops ?? null,
    replays: row.replays ?? null,
    linked_cards: row.linked_cards,
    kata_board_id: row.kata_board_id,
    kata_card_id: row.kata_card_id,
    opened_at: row.opened_at.toISOString(),
    qa_at: iso(row.qa_at),
    published_at: iso(row.published_at),
    closed_at: iso(row.closed_at),
    failed_at: iso(row.failed_at),
    rollback_requested_at: iso(row.rollback_requested_at),
    rollback_delivered_at: iso(row.rollback_delivered_at),
    rollback_refused_at: iso(row.rollback_refused_at),
    rollback_refused_reason: row.rollback_refused_reason,
    rolled_back_at: iso(row.rolled_back_at),
    cord_engaged_at: iso(row.cord_engaged_at),
    cord_held_seconds: row.cord_held_seconds,
    cord_released_at: iso(row.cord_released_at),
    cord_released_by: row.cord_released_by,
    updated_at: row.updated_at.toISOString(),
    cord: kataCordView(row, holders),
  };
}

// ── input ───────────────────────────────────────────────────────────────────

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const LicenceOpenBody = z
  .object({
    source_project_id: z.string().uuid(),
    source_card_id: shortText(128).optional(),
    source_execution_id: shortText(128).optional(),
    source_board_id: shortText(128).optional(),
    source_phase: shortText(128).optional(),
    symptom: shortText(8000),
    signature: shortText(1024),
    root_cause_class: shortText(64).optional(),
    target_flow: shortText(256).optional(),
    target_flow_id: shortText(64).optional(),
    base_version_id: shortText(128).optional(),
    evidence: z.record(z.unknown()),
    /**
     * A hand-open the coach forwarded (the super-admin's sub from the `kata.open` payload). Accepted
     * and IGNORED: a licence cannot vouch for a super-admin, so the kata records `opened_by='coach'`.
     */
    requested_by: z.string().uuid().optional(),
  })
  .strict();

export const OperatorOpenBody = z
  .object({
    source: z.literal('operator'),
    source_project_id: z.string().uuid(),
    source_card_id: shortText(128),
    source_execution_id: shortText(128).optional(),
    symptom: shortText(8000),
  })
  .strict();

const nullableText = (max: number) => z.string().max(max).nullable().optional();
const count = z.number().int().min(0).max(1000).nullable().optional();

export const KataPatchBody = z
  .object({
    state: z.enum(KATA_STATES).optional(),
    state_detail: nullableText(4000),
    /** Immutable: the open set it. Present ⇒ must equal the current value (else 400). */
    signature: z.string().max(1024).optional(),
    root_cause_class: nullableText(64),
    target_flow: nullableText(256),
    target_flow_id: nullableText(64),
    base_version_id: nullableText(128),
    published_version_id: nullableText(128),
    replay_passed: count,
    replay_total: count,
    ops: z.array(z.record(z.unknown())).optional(),
    replays: z.array(z.record(z.unknown())).optional(),
    linked_card_rerun: z.array(shortText(128)).max(200).optional(),
  })
  .strict();

async function readBody(req: Request): Promise<unknown> {
  const text = req.body === null ? '' : await req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, 'Invalid JSON request body; nothing changed').withCode('BAD_REQUEST');
  }
}

function kataId(raw: string): string {
  if (!isUuidShape(raw)) throw new NotFoundError('Kata not found').withCode('kata_not_found');
  return raw.toLowerCase();
}

function callerLabel(user: User): string {
  return user.email || user.id;
}

// ── handlers ────────────────────────────────────────────────────────────────

export async function handleListKatas(req: Request): Promise<Response> {
  try {
    assertKataCaller(await validateAuth(req), 'listKatas');
    const url = new URL(req.url);
    const state = url.searchParams.get('state');
    const project = url.searchParams.get('project');
    if (state !== null && state !== '' && !(KATA_STATES as readonly string[]).includes(state)) {
      throw new AppError(422, `state must be one of ${KATA_STATES.join(', ')}`).withCode('validation_failed');
    }
    if (project !== null && project !== '' && !isUuidShape(project)) {
      throw new AppError(422, 'project must be a project uuid').withCode('validation_failed');
    }
    const [rows, holders] = await Promise.all([
      listKataRows({ ...(state ? { state: state as KataState } : {}), ...(project ? { project } : {}) }),
      readKataHolderSet(),
    ]);
    const windows = kataStatsWindows();
    const [today, last7d, holding, failed_holders] = await Promise.all([
      kataWindowStats(windows.today),
      kataWindowStats(windows.last7d),
      holdingKata(holders),
      failedHolderIds(holders),
    ]);
    return jsonResponse({ items: rows.map((r) => kataView(r, holders)), stats: { today, last7d }, holding, failed_holders });
  } catch (err) {
    return handleError(err);
  }
}

export async function handleGetKata(req: Request, id: string): Promise<Response> {
  try {
    assertKataCaller(await validateAuth(req), 'getKata');
    const row = await readKata(kataId(id));
    if (!row) throw new NotFoundError('Kata not found').withCode('kata_not_found');
    return jsonResponse(kataView(row, await readKataHolderSet()));
  } catch (err) {
    return handleError(err);
  }
}

export async function handleOpenKata(req: Request): Promise<Response> {
  try {
    const user = await validateAuth(req);
    const kind = assertKataCaller(user, 'openKata');
    const body = await readBody(req);
    if (kind === 'super_admin') {
      // Amendment 8: a hand-open goes through the conveyor coach (one entry path, one evidence
      // extractor). fr only forwards it; the coach opens the kata with the licence.
      const input = OperatorOpenBody.parse(body);
      // kata.open would only queue behind worker=0 while anybody holds the cord: refuse honestly.
      const paused = await conveyorPause();
      if (paused) {
        throw new AppError(
          409,
          paused.operator
            ? 'The conveyor is paused (the andon cord is engaged); a kata cannot be opened by hand now. Nothing was sent'
            : `The conveyor is paused by kata ${paused.kata_holders.join(', ')}; a kata cannot be opened by hand now. Nothing was sent`,
          paused,
        ).withCode('conveyor_paused');
      }
      const unconfigured = kataOpenWebhookUnconfigured();
      if (unconfigured) {
        throw new AppError(503, `The hand-open cannot be sent: ${unconfigured}. Nothing was sent`).withCode('kata_open_not_configured');
      }
      const out = await postKataOpen(
        {
          source: 'operator',
          source_project_id: input.source_project_id,
          source_card_id: input.source_card_id,
          ...(input.source_execution_id ? { source_execution_id: input.source_execution_id } : {}),
          symptom: input.symptom,
          requested_by: user.id,
        },
        crypto.randomUUID(),
      );
      if (out.kind !== 'delivered') {
        throw new AppError(502, `The conveyor coach did not accept the hand-open (${out.reason})`).withCode(
          'kata_open_webhook_failed',
        );
      }
      console.log(`[katas] hand-open of a kata on project ${input.source_project_id} sent to the coach by ${callerLabel(user)}`);
      return jsonResponse({ status: 'requested' }, 202);
    }
    // `requested_by` is a licence caller's claim, never provenance: dropped (opened_by = 'coach').
    const { requested_by: _claimed, ...input } = LicenceOpenBody.parse(body);
    const out = await openKataForLicence(user, input);
    const holders = await readKataHolderSet();
    const kata = kataView(out.kata, holders);
    if (out.action === 'opened') return jsonResponse({ kata, action: 'opened', cord_join: out.cord_join }, 201);
    if (out.action === 'linked') return jsonResponse({ kata, action: 'linked' });
    if (out.action === 'rollback_pending') return jsonResponse({ kata, action: 'rollback_pending' });
    if (out.action === 'rollback_refused') {
      return jsonResponse({ kata, action: 'rollback_refused', reason: out.reason, ...(out.later_kata_id ? { later_kata_id: out.later_kata_id } : {}) });
    }
    return jsonResponse({ kata, action: 'rollback_requested', rollback_webhook: { kind: out.rollback_webhook.kind } });
  } catch (err) {
    return handleError(err);
  }
}

export async function handleUpdateKata(req: Request, id: string): Promise<Response> {
  try {
    assertKataCaller(await validateAuth(req), 'updateKata');
    const patch = KataPatchBody.parse(await readBody(req));
    const out = await patchKata(kataId(id), patch);
    return jsonResponse({ kata: kataView(out.kata, await readKataHolderSet()), ...(out.cord ? { cord_release: out.cord } : {}) });
  } catch (err) {
    return handleError(err);
  }
}

export async function handleCloseKata(req: Request, id: string): Promise<Response> {
  try {
    assertKataCaller(await validateAuth(req), 'closeKata');
    const row = await closeKata(kataId(id));
    return jsonResponse({ kata: kataView(row, await readKataHolderSet()) });
  } catch (err) {
    return handleError(err);
  }
}

export async function handleStopKata(req: Request, id: string): Promise<Response> {
  try {
    const user = await validateAuth(req);
    assertKataCaller(user, 'stopKata');
    const out = await stopKata(kataId(id), callerLabel(user));
    console.log(`[katas] kata ${out.kata.id} stopped by ${callerLabel(user)}`);
    return jsonResponse({ kata: kataView(out.kata, await readKataHolderSet()), ...(out.cord ? { cord_release: out.cord } : {}) });
  } catch (err) {
    return handleError(err);
  }
}

export async function handleReleaseKata(req: Request, id: string): Promise<Response> {
  try {
    const user = await validateAuth(req);
    assertKataCaller(user, 'releaseKata');
    const out = await releaseFailedKata(kataId(id), `super_admin:${user.id}`);
    console.log(`[katas] failed kata ${out.kata.id} released its cord by ${callerLabel(user)} (worker_scaled_up=${out.cord?.worker_scaled_up})`);
    return jsonResponse({ kata: kataView(out.kata, await readKataHolderSet()), ...(out.cord ? { cord_release: out.cord } : {}) });
  } catch (err) {
    return handleError(err);
  }
}

export async function handleRollbackKata(req: Request, id: string): Promise<Response> {
  try {
    const user = await validateAuth(req);
    assertKataCaller(user, 'rollbackKata');
    const unconfigured = kataRollbackWebhookUnconfigured();
    if (unconfigured) {
      throw new AppError(503, `The rollback cannot be sent: ${unconfigured}. Nothing changed`).withCode('kata_rollback_not_configured');
    }
    const { kata } = await requestKataRollback(kataId(id));
    // Sent on every explicit Rollback (the flow is idempotent; a retry re-sends after a failure).
    const out = await postKataRollback(kata.id);
    if (out.kind !== 'delivered') {
      throw new AppError(502, `kata-n8n did not accept the rollback (${out.reason}); rollback_requested_at is kept, retry`, {
        kata_id: kata.id,
      }).withCode('kata_rollback_webhook_failed');
    }
    const delivered = await markRollbackDelivered(kata.id);
    console.log(`[katas] rollback of kata ${kata.id} requested by ${callerLabel(user)}`);
    return jsonResponse({ status: 'requested', kata: kataView(delivered, await readKataHolderSet()) }, 202);
  } catch (err) {
    return handleError(err);
  }
}
