// src/services/katas/webhooks.ts
//
// fr's two outbound kata webhooks (the kata build contract, amendments 8 and 9).
//
//   kata.open      → the CONVEYOR n8n's coach (`${CONVEYOR_N8N_WEBHOOK_BASE}/webhook/kata.open`):
//                    a super-admin's hand-open. The coach computes the evidence and signature
//                    exactly as for an automatic block and then opens the kata with the
//                    licence (`POST /api/katas`), so there is one entry path and one evidence
//                    extractor (K2). Authenticated with the mechanism fr ALREADY uses for every
//                    fr→conveyor-n8n webhook (services/conveyor-start-webhook.ts): `X-FR-Signature: sha256=<HMAC of the
//                    raw body, key CONVEYOR_START_WEBHOOK_SECRET>` plus `X-Conveyor-Token:
//                    <the same secret>` (n8n's Header Auth credential).
//   kata.rollback  → kata-n8n (`${KATA_N8N_WEBHOOK_BASE}/webhook/kata.rollback`), body
//                    `{kata_id}` ONLY. The flow trusts nothing in it: it GETs
//                    `/api/katas/:id`, requires `rollback_requested_at` and state
//                    published|closed, restores `base_version_id`, reads it back and PATCHes
//                    `rolled_back`. fr has no existing fr→kata-n8n call, so this one carries
//                    `X-Kata-Rollback-Token: <KATA_ROLLBACK_WEBHOOK_TOKEN>`.
//
// ⛔ FAIL CLOSED: an unset base / secret answers `not_configured` and nothing is sent; the route
// turns it into 503 `kata_open_not_configured` / `kata_rollback_not_configured` BEFORE writing.
// ⛔ URL GUARD as the conveyor webhooks: plain fetch, `redirect: 'manual'` (a 3xx is a failure).
// One attempt per call, never throws.
import { config } from '../../config';
import { signConveyorStartBody } from '../conveyor-start-webhook';

const DEFAULT_KATA_N8N_WEBHOOK_BASE = 'http://kata-n8n.example.com:5678';

export type KataWebhookOutcome =
  | { kind: 'not_configured'; reason: string }
  | { kind: 'delivered'; status: number }
  | { kind: 'failed'; status: number | null; reason: string };

function usableBase(raw: string | undefined): string | null {
  const base = (raw ?? '').trim().replace(/\/+$/, '');
  if (!base) return null;
  try {
    const u = new URL(base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? base : null;
  } catch {
    return null;
  }
}

/** Read at call time (not import time), so the env a deploy sets is the env in force. */
function conveyorBase(): string | null {
  return usableBase(process.env.CONVEYOR_N8N_WEBHOOK_BASE);
}
function kataN8nBase(): string | null {
  const raw = process.env.KATA_N8N_WEBHOOK_BASE;
  return usableBase(raw === undefined || raw.trim() === '' ? DEFAULT_KATA_N8N_WEBHOOK_BASE : raw);
}

/** Why the hand-open webhook cannot be sent, or null when it can. */
export function kataOpenWebhookUnconfigured(): string | null {
  if (conveyorBase() === null) return 'CONVEYOR_N8N_WEBHOOK_BASE is unset or not an absolute http(s) URL';
  if (!config.services.n8n.conveyorStartWebhookSecret) return 'CONVEYOR_START_WEBHOOK_SECRET is unset';
  return null;
}

/** Why the rollback webhook cannot be sent, or null when it can. */
export function kataRollbackWebhookUnconfigured(): string | null {
  if (kataN8nBase() === null) return 'KATA_N8N_WEBHOOK_BASE is not an absolute http(s) URL';
  if (!(process.env.KATA_ROLLBACK_WEBHOOK_TOKEN ?? '').trim()) return 'KATA_ROLLBACK_WEBHOOK_TOKEN is unset';
  return null;
}

async function post(url: string, raw: string, headers: Record<string, string>): Promise<KataWebhookOutcome> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: raw,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    // The body is not needed; drain it so the connection is reusable.
    await res.text().catch(() => '');
    if (res.status >= 200 && res.status < 300) return { kind: 'delivered', status: res.status };
    return { kind: 'failed', status: res.status, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { kind: 'failed', status: null, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface KataOpenRequest {
  source: 'operator';
  source_project_id: string;
  source_card_id: string;
  source_execution_id?: string;
  symptom: string;
  /** The super-admin's sub. The coach passes it back as `requested_by` on POST /api/katas, which
   *  records `opened_by = 'super_admin:<sub>'`. */
  requested_by: string;
}

/** The super-admin's hand-open, to the conveyor coach's `kata.open` webhook. */
export async function postKataOpen(body: KataOpenRequest, idempotencyKey: string): Promise<KataWebhookOutcome> {
  const unconfigured = kataOpenWebhookUnconfigured();
  if (unconfigured) return { kind: 'not_configured', reason: unconfigured };
  const secret = config.services.n8n.conveyorStartWebhookSecret;
  const raw = JSON.stringify(body);
  return post(`${conveyorBase()}/webhook/kata.open`, raw, {
    'X-FR-Signature': signConveyorStartBody(raw, secret),
    'X-Conveyor-Token': secret,
    'Idempotency-Key': idempotencyKey,
  });
}

/** Ask kata-n8n to roll the kata back. The body is the id ONLY (the flow re-reads the row). */
export async function postKataRollback(kataId: string): Promise<KataWebhookOutcome> {
  const unconfigured = kataRollbackWebhookUnconfigured();
  if (unconfigured) return { kind: 'not_configured', reason: unconfigured };
  return post(`${kataN8nBase()}/webhook/kata.rollback`, JSON.stringify({ kata_id: kataId }), {
    'X-Kata-Rollback-Token': (process.env.KATA_ROLLBACK_WEBHOOK_TOKEN ?? '').trim(),
    'Idempotency-Key': `kata.rollback:${kataId}`,
  });
}
