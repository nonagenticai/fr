// src/services/katas/open.ts
//
// `POST /api/katas` for the CONVEYOR LICENCE (the coach): open a kata from a symptom and start it
// (the kata build contract, amendments 5, 7, 10, 11). In order:
//
//   1. under the signature's advisory lock — ONE short transaction — decide (core.ts
//      decideOpenSelfHealing): link to the open kata, request rollback of a published / recently
//      closed one, or open. A running kata that is a dead open (project archived, or its first
//      card never reached READY) is failed + released in one transaction first, then decided again;
//   2. refuse while the operator's cord is engaged (assertGlobalAndonReleased), BEFORE anything
//      is created;
//   3. outside any transaction (RM, Planka: never hold a pooled connection across them): ensure
//      the `kata` tenant's RM catalogue (amendment 11), create the kata PROJECT through the one
//      create engine (routes/projects.ts createSingleProject) under the kata's own id, and its
//      first card in TODO (`card_type = wf_change`, description first line `kata-id:<id>`);
//   4. ONE short transaction: re-check the signature under its lock, insert the kata row in
//      `running` with its board + card, and join the cord (core.ts insertRunningKata). A lost
//      race (another open of the same signature won) archives the project just created and
//      answers the winner as `linked`;
//   5. move the card to READY, so the Planka→kata-n8n webhook fires `wf_change.READY`
//      (amendment 10), and stamp `card_ready_at`. A failure FAILS the kata (retried once) and
//      archives its project; the failed kata KEEPS the cord until a super-admin releases it
//      (George 2026-11-04).
//
// ⛔ A `running` kata — which pauses the WHOLE conveyor — is never committed before its first card
// exists, and every failure path that leaves a kata project behind archives it. If failing it
// fails too, the kata is left as a dead open, which step 1 of the next open of its signature
// clears instead of answering `linked`.
//
// What only a live run can prove (RM / Planka cannot be faked — backend/CLAUDE.md): the project
// create, the first card's creation and its move to READY, and the archive on each failure path.
import { db } from '../../db/client';
import { projects } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { importPmCatalogueDefaults } from '../../integrations/pm-catalogue';
import { assertGlobalAndonReleased } from '../../lib/global-andon-gate';
import { readN8nWorkerScale, type WorkerScaleReading } from '../../lib/k8s-scale';
import { KATA_TENANT_ID } from '../../middleware/internal-tenant-only';
import { createSingleProject } from '../../routes/projects';
import { ProjectCreateSchema } from '../../types/api';
import type { User } from '../../types/api';
import { AppError, NotFoundError } from '../../utils/errors';
import { CatalogueNotInitialised, invalidateTenantCatalogue, projectTypes } from '../catalogue/tenant-catalogue';
import { boardField, resolveBoardFieldGroups } from '../planka/custom-fields';
import { plankaAsAgent } from '../planka/with-auth';
import {
  archiveKataProjectRow,
  decideOpenSelfHealing,
  insertRunningKata,
  markKataCardReady,
  markRollbackDelivered,
  patchKata,
  type KataRow,
  type LinkCardInput,
  type RollbackRefusal,
} from './core';
import { postKataRollback, type KataWebhookOutcome } from './webhooks';

/** The kata project type in RM (RM's defaults carry `kata` and the `wf_change` card type). */
export const KATA_PROJECT_TYPE = 'kata';
export const KATA_FIRST_CARD_TYPE = 'wf_change';

export interface LicenceOpenInput {
  source_project_id: string;
  source_card_id?: string;
  source_execution_id?: string;
  source_board_id?: string;
  source_phase?: string;
  symptom: string;
  signature: string;
  root_cause_class?: string;
  target_flow?: string;
  target_flow_id?: string;
  base_version_id?: string;
  evidence: Record<string, unknown>;
}

/**
 * The cord join of a fresh open. `worker_replicas` is the LIVE Deployment reading taken after the
 * join, and a 201 (`action: 'opened'`) is only returned when it measured exactly 0 — so on this
 * path the conveyor IS stopped. A non-null `worker_scale_error` therefore means the PATCH itself
 * reported a problem (refused, threw, echoed a different count, or its follow-up read failed)
 * while the Deployment still measured 0; it is the actuator's own error, not a claim that the
 * worker is running.
 */
export interface KataCordJoinView {
  worker_replicas: number | null;
  worker_scale_error: string | null;
}

export type OpenOutcome =
  | { action: 'opened'; kata: KataRow; cord_join: KataCordJoinView }
  | { action: 'linked'; kata: KataRow }
  | { action: 'rollback_requested'; kata: KataRow; rollback_webhook: KataWebhookOutcome }
  /** A repeat of a signature whose rollback was already delivered: kata-n8n has it; nothing sent. */
  | { action: 'rollback_pending'; kata: KataRow }
  /** A repeat whose rollback the guard refuses (no base / superseded): nothing requested, nothing sent. */
  | { action: 'rollback_refused'; kata: KataRow; reason: RollbackRefusal['code']; later_kata_id?: string };

function projectTenantTag(project: { project_data?: unknown }): string | null {
  const tag = (project.project_data as { keycloak_tenant_id?: unknown } | null | undefined)?.keycloak_tenant_id;
  return typeof tag === 'string' && tag.trim() !== '' ? tag.trim().toLowerCase() : null;
}

/** The source project, in ANY tenant (the conveyor already runs there: this exposes nothing new). */
async function loadSourceProject(id: string): Promise<{ id: string; tenantId: string }> {
  const [row] = await db.select({ id: projects.id, project_data: projects.project_data }).from(projects).where(eq(projects.id, id)).limit(1);
  const tenantId = row ? projectTenantTag(row) : null;
  if (!row || !tenantId) throw new NotFoundError('Source project not found').withCode('kata_source_project_not_found');
  return { id: row.id, tenantId };
}

/** Amendment 11: the kata tenant's RM catalogue exists before the first kata project. */
export async function ensureKataCatalogue(): Promise<void> {
  try {
    await projectTypes(KATA_TENANT_ID);
    return;
  } catch (err) {
    if (!(err instanceof CatalogueNotInitialised)) throw err;
  }
  try {
    await importPmCatalogueDefaults(KATA_TENANT_ID, undefined);
  } finally {
    invalidateTenantCatalogue(KATA_TENANT_ID);
  }
}

function oneLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The conveyor licence's open. `opened_by` is always `'coach'`: a licence caller cannot vouch for
 * a super-admin, so a `requested_by` it forwards is never recorded as provenance.
 */
export async function openKataForLicence(user: User, input: LicenceOpenInput): Promise<OpenOutcome> {
  const source = await loadSourceProject(input.source_project_id);
  const card: LinkCardInput | null = input.source_card_id
    ? { card_id: input.source_card_id, board_id: input.source_board_id ?? null, phase: input.source_phase ?? null }
    : null;

  const decision = await decideOpenSelfHealing(input.signature, card);
  if (decision.action === 'rollback_requested') return sendRepeatRollback(decision.kata);
  if (decision.action === 'rollback_refused') {
    console.warn(`[katas] repeat of signature on kata ${decision.kata.id}: rollback refused (${decision.refusal.code}): ${decision.refusal.message}`);
    return {
      action: 'rollback_refused',
      kata: decision.kata,
      reason: decision.refusal.code,
      ...(decision.refusal.later_kata_id ? { later_kata_id: decision.refusal.later_kata_id } : {}),
    };
  }
  if (decision.action === 'linked') return { action: 'linked', kata: decision.kata };

  // The operator's cord first: nothing is created while it is pulled.
  await assertGlobalAndonReleased();
  await ensureKataCatalogue();
  const kataId = crypto.randomUUID();
  const validated = ProjectCreateSchema.parse({
    name: `kata: ${oneLine(input.symptom, 80)}`,
    project_type: KATA_PROJECT_TYPE,
    description: `kata-id:${kataId}\n\n${input.symptom}`,
  });
  let planka: Awaited<ReturnType<typeof createSingleProject>>['planka'];
  try {
    // The kata tenant OWNS the project (repoGateTenantId names the owning tenant; the licence
    // caller acts in its own conveyor tenant and never names `kata` itself).
    ({ planka } = await createSingleProject({
      validated,
      user,
      repoGateTenantId: KATA_TENANT_ID,
      newProjectId: kataId,
      // fr's own first wf_change card (below) is the only first card: no conveyor start.
      startConveyor: false,
    }));
  } catch (err) {
    await archiveKataProject(kataId, 'the project create failed');
    throw err;
  }

  const lists = { boardId: planka.board.id, todoListId: planka.listIds.TODO, readyListId: planka.listIds.READY };
  let cardId: string;
  try {
    cardId = await createTodoCard({ kataId, ...lists, symptom: input.symptom });
  } catch (err) {
    const reason = errText(err);
    console.error(`[katas] kata ${kataId}: the first wf_change card could not be created; no kata was opened:`, reason);
    await archiveKataProject(kataId, 'its first card could not be created');
    throw new AppError(502, 'The kata project was created but its first card could not be; the project was archived and no kata opened', {
      kata_id: kataId,
    }).withCode('kata_first_card_failed');
  }

  let kata: KataRow;
  let cordJoin: KataCordJoinView;
  try {
    const joined = await insertRunningKata({
      id: kataId,
      source_project_id: source.id,
      source_tenant_id: source.tenantId,
      source_card_id: input.source_card_id ?? null,
      source_execution_id: input.source_execution_id ?? null,
      source_board_id: input.source_board_id ?? null,
      source_phase: input.source_phase ?? null,
      symptom: input.symptom,
      opened_by: 'coach',
      signature: input.signature,
      root_cause_class: input.root_cause_class ?? null,
      target_flow: input.target_flow ?? null,
      target_flow_id: input.target_flow_id ?? null,
      base_version_id: input.base_version_id ?? null,
      evidence: input.evidence,
      kata_board_id: lists.boardId,
      kata_card_id: cardId,
    });
    kata = joined.result;
    cordJoin = { worker_replicas: joined.worker_replicas, worker_scale_error: joined.worker_scale_error };
  } catch (err) {
    await archiveKataProject(kataId, 'its kata row could not be opened');
    if ((err as { code?: unknown })?.code === 'kata_signature_open') {
      // Another open of this signature won between the decision and here: answer the winner.
      const again = await decideOpenSelfHealing(input.signature, card);
      if (again.action === 'linked') return { action: 'linked', kata: again.kata };
    }
    throw err;
  }

  // ⭐ THE JOIN IS VERIFIED, NOT ASSUMED. `scaleN8nWorker` sets `error` when the write was
  // refused or threw, when an ACCEPTED patch echoed a count other than the one asked for, and
  // when its follow-up read failed — but on a clean write `replicas` is the PATCH RESPONSE's
  // echo, i.e. the API server's view at that instant, not a reading of the Deployment taken
  // afterwards. Anything that changes the count between the echo and this point (a
  // `kubectl scale`, another controller) therefore leaves `worker_scale_error` null while the
  // conveyor keeps running. Read the DEPLOYMENT before the card reaches READY, which is what
  // starts the kata: a kata that edits live flows while the conveyor keeps executing is the
  // failure this cord exists to prevent, and it is silent — the kata's own stages run on
  // kata-n8n, not here.
  // `replicas === null` is NOT MEASURED, never 0 (lib/k8s-scale.ts): unmeasured is a failure.
  // ⚠️ The replica count being absent from git does NOT protect this check: kustomize cannot
  // re-assert a field the manifest does not carry. The check guards against a LIVE divergence
  // from what the PATCH claimed, not against a git-driven re-apply.
  const liveCord = await readLiveCord();
  cordJoin = { worker_replicas: liveCord.replicas, worker_scale_error: cordJoin.worker_scale_error };
  await assertCordMeasuredAtZero(kataId, liveCord);

  try {
    await moveCardToReady(cardId, lists.readyListId);
  } catch (err) {
    await failOpenedKata(kataId, `its first wf_change card could not be moved to READY: ${oneLine(errText(err), 400)}`);
    throw new AppError(502, 'The kata opened but its first card could not be moved to READY; the kata was failed (it keeps the cord until a super-admin releases it) and the project archived', {
      kata_id: kataId,
    }).withCode('kata_first_card_failed');
  }
  try {
    await markKataCardReady(kataId);
  } catch (err) {
    // The card IS in READY (kata-n8n drives it); only the marker is missing, so a repeat of this
    // signature past the grace would clear a live kata. Loud, not fatal.
    console.error(`[katas] ⛔ kata ${kataId}: its card reached READY but card_ready_at could not be stamped:`, errText(err));
  }
  if (cordJoin.worker_scale_error !== null) {
    // The PATCH did not land cleanly, but the LIVE Deployment was measured at 0 just above, so
    // the conveyor IS stopped — this is the actuator's own error being reported, not a claim
    // that the worker is running. Answered in `cord_join` (201 stands) and logged.
    console.error(`[katas] ⚠️ kata ${kataId} opened and holds the cord; the scale PATCH reported an error but the worker was measured at 0:`, cordJoin.worker_scale_error);
  }
  return { action: 'opened', kata, cord_join: cordJoin };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Archive the kata project (best effort, logged): every failure path that leaves one behind. */
async function archiveKataProject(kataId: string, why: string): Promise<void> {
  try {
    const n = await archiveKataProjectRow(kataId);
    if (n > 0) console.warn(`[katas] kata project ${kataId} archived: ${why}`);
  } catch (err) {
    console.error(`[katas] kata project ${kataId} could NOT be archived (${why}):`, errText(err));
  }
}

/** Wait before the one retry of a failed transition (e.g. `andon_busy` after the lock timeout). */
const FAIL_RETRY_DELAY_MS = 2_000;

/**
 * The kata failed after it opened: state failed (retried once; it KEEPS the cord — only a
 * super-admin Release frees it, George 2026-11-04), project archived. If both attempts fail, the archived project marks it a dead open, which the
 * next open of its signature clears (core.ts decideOpenSelfHealing).
 */
async function failOpenedKata(kataId: string, detail: string): Promise<void> {
  console.error(`[katas] kata ${kataId}: ${detail}; failing the kata`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await patchKata(kataId, { state: 'failed', state_detail: detail });
      break;
    } catch (err) {
      console.error(`[katas] kata ${kataId}: could NOT be failed (attempt ${attempt}/2):`, errText(err));
      if (attempt < 2) await new Promise((r) => setTimeout(r, FAIL_RETRY_DELAY_MS));
    }
  }
  await archiveKataProject(kataId, 'the kata failed while opening');
}

/** Delays between the live-read attempts; its length is the retry count. */
const LIVE_CORD_RETRY_DELAYS_MS = [250, 500] as const;

/**
 * The live Deployment reading, retried. `readN8nWorkerScale` never throws — a failed read is
 * `replicas: null` — and `null` fails the kata and KEEPS the cord, so a single transient blip on
 * one 4 s fetch would cost a super-admin Release. Only the READ is retried: a successful read of
 * any value is a real answer and is returned at once (non-zero must fail immediately).
 */
async function readLiveCord(): Promise<WorkerScaleReading> {
  let reading = await readN8nWorkerScale();
  for (const delay of LIVE_CORD_RETRY_DELAYS_MS) {
    if (reading.replicas !== null) return reading;
    await new Promise((resolve) => setTimeout(resolve, delay));
    reading = await readN8nWorkerScale();
  }
  return reading;
}

/**
 * The join's PROOF: the live Deployment must measure EXACTLY 0 replicas before the kata starts.
 *
 * A non-zero count fails the kata here — and so does `null`, which is NOT MEASURED and never 0
 * (lib/k8s-scale.ts). The failed kata KEEPS the cord until a super-admin releases it (George
 * 2026-11-04), and the throw keeps the caller away from the card move that starts the kata.
 *
 * Takes the reading rather than fetching it, so the verdict is pinned against a real kata row
 * without a cluster: the live read itself cannot be faked (backend/CLAUDE.md bans test doubles).
 */
export async function assertCordMeasuredAtZero(kataId: string, liveCord: WorkerScaleReading): Promise<void> {
  if (liveCord.replicas === 0) return;
  const measured = liveCord.replicas === null ? `unmeasurable (${liveCord.error ?? 'no reading'})` : String(liveCord.replicas);
  await failOpenedKata(kataId, `the cord joined but n8n-worker measured ${measured}, not 0: the conveyor may still run, so the kata must not start`);
  throw new AppError(502, `The kata could not verify that the conveyor stopped (n8n-worker at ${measured}, not 0). The kata was failed and did not start; it keeps its hold until a super-admin releases it.`, {
    kata_id: kataId,
  }).withCode('kata_cord_not_effective');
}

/**
 * The coach's repeat signature requested a rollback (amendment 7): post `kata.rollback` AFTER the
 * request committed (as routes/katas.ts's Rollback does), while it is not yet delivered. A failed
 * post is answered honestly (503 not configured / 502 not accepted) with `rollback_requested_at`
 * kept and `rollback_delivered_at` still NULL, so the next repeat resends it.
 */
async function sendRepeatRollback(kata: KataRow): Promise<OpenOutcome> {
  if (kata.rollback_delivered_at !== null) {
    console.warn(`[katas] repeat of signature on kata ${kata.id}: its rollback is already delivered and pending in kata-n8n`);
    return { action: 'rollback_pending', kata };
  }
  const out = await postKataRollback(kata.id);
  if (out.kind === 'not_configured') {
    throw new AppError(503, `The rollback was requested but cannot be sent: ${out.reason}; rollback_requested_at is kept, retry`, {
      kata_id: kata.id,
    }).withCode('kata_rollback_not_configured');
  }
  if (out.kind !== 'delivered') {
    console.error(`[katas] rollback of ${kata.id} requested but not delivered: ${out.reason}`);
    throw new AppError(502, `kata-n8n did not accept the rollback (${out.reason}); rollback_requested_at is kept, retry`, {
      kata_id: kata.id,
    }).withCode('kata_rollback_webhook_failed');
  }
  return { action: 'rollback_requested', kata: await markRollbackDelivered(kata.id), rollback_webhook: out };
}

/** The kata's first card, in TODO, stamped `card_type = wf_change` (+ project / tenant). Not moved. */
async function createTodoCard(input: {
  kataId: string;
  boardId: string;
  todoListId: string | undefined;
  readyListId: string | undefined;
  symptom: string;
}): Promise<string> {
  if (!input.todoListId || !input.readyListId) {
    throw new Error(`the kata board ${input.boardId} has no TODO and READY lists`);
  }
  const agent = plankaAsAgent();
  const groups = await resolveBoardFieldGroups(agent, input.boardId);
  const cardTypeField = boardField(groups, { boardId: input.boardId, group: 'Metadata', field: 'card_type', context: 'katas.first_card' });
  if (!cardTypeField) throw new Error(`the kata board ${input.boardId} has no Metadata.card_type field`);
  const card = await agent.cards.create({
    listId: input.todoListId,
    name: `wf_change: ${oneLine(input.symptom, 80)}`,
    description: `kata-id:${input.kataId}\n\n${input.symptom}`,
    position: 65536,
    type: 'project',
  });
  const stamps: Array<[string, string]> = [
    ['card_type', KATA_FIRST_CARD_TYPE],
    ['project_id', input.kataId],
    ['keycloak_tenant_id', KATA_TENANT_ID],
  ];
  for (const [field, content] of stamps) {
    const f = field === 'card_type' ? cardTypeField : boardField(groups, { boardId: input.boardId, group: 'Metadata', field, context: 'katas.first_card', cardId: card.id });
    if (!f) continue;
    await agent.customFields.setCardCustomFieldValue({ cardId: card.id, customFieldGroupId: f.groupId, customFieldId: f.fieldId, content });
  }
  return card.id;
}

/** TODO → READY: fires `wf_change.READY` on kata-n8n. */
async function moveCardToReady(cardId: string, readyListId: string | undefined): Promise<void> {
  if (!readyListId) throw new Error('the kata board has no READY list');
  await plankaAsAgent().cards.move(cardId, { listId: readyListId, position: 65536 });
}
