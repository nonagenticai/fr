// The per-card DOCUMENT lease shared by every route that read-modify-writes a
// project card's Planka description under fr's own serialisation:
//   - POST /api/cards/:cardId/scenario-evidence (scenario-evidence.ts) — appends
//     gherkin_scenarios pointers;
//   - POST /api/cards/:cardId/scenarios/freeze (scenarios-freeze.ts) — stamps the
//     scenario set's freeze hash.
//
// ⛔ ONE namespace + ONE key for BOTH routes. Both rewrite the WHOLE description
// they read; a second key would let a freeze and an append each hold "their"
// lease on the same card at once, and whichever PATCHes second silently drops
// the other's write (a lost update). The key keeps its historical name
// (`scenario-evidence:append`) so a lease row taken by a pre-refactor process
// during a rollout still serialises against the new code.
//
// Moved verbatim from scenario-evidence.ts (behaviour, error codes and the lease
// key unchanged); see that file's header for the pool-deadlock history that made
// the serialiser a lease ROW instead of a held connection.

import { REQUEST_TIMEOUT_MS as PLANKA_REQUEST_TIMEOUT_MS } from '../../services/planka/http';
import {
  claimCreateLease,
  createLeaseStillHeld,
  releaseCreateLease,
} from '../../services/improvement-cards/create-lease';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { PlankaError } from '../../services/planka/errors';
import { clientSafePlankaErrorMessage } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import { projectCardPlankaAgent } from './project';

export function body(status: number, code: string, rest: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: code, code, ...rest }, status);
}

export const cardNotFound = (cardId: string) => body(404, 'card_not_found', { card_id: cardId });

/**
 * Lease namespace (the `action_idempotency.user_id` column) for one card's
 * description read-modify-writes. Shared by scenario-evidence AND
 * scenarios-freeze — never fork it per route (see the file header).
 */
export function scenarioEvidenceLeaseNamespace(cardId: string): string {
  return `card:${cardId}`;
}
/** The ONE lease key for a card's description writers (append AND freeze). Do not add a second. */
export const SCENARIO_EVIDENCE_LEASE_KEY = 'scenario-evidence:append';

/**
 * Planka calls made WHILE the lease is held: the description re-read (a GET,
 * retried once by PlankaHttp on a transient failure) + the PATCH. The lease
 * must outlive a holder whose every call hangs to its own timeout, or a second
 * writer could take it mid read-modify-write (a lost update).
 */
const PLANKA_CALLS_UNDER_LEASE = 3;
export const SCENARIO_EVIDENCE_LEASE_TTL_SECS = Math.ceil(
  ((PLANKA_CALLS_UNDER_LEASE * PLANKA_REQUEST_TIMEOUT_MS) / 1000) * 1.15,
);
/**
 * Lease time that must REMAIN when the holder is about to PATCH: the PATCH is
 * one un-retried Planka call, so the lease must outlive it. With the TTL above
 * (3 calls × 1.15) a holder whose re-read took its full worst case (2 calls,
 * GET retry included) still has > 1 call left; one that has less has overrun.
 */
const SCENARIO_EVIDENCE_LEASE_MIN_REMAINING_SECS = Math.ceil(PLANKA_REQUEST_TIMEOUT_MS / 1000);
/** How long a contender waits for the card's lease before answering 503 (one Planka call's ceiling). */
export const SCENARIO_EVIDENCE_LEASE_WAIT_MS = PLANKA_REQUEST_TIMEOUT_MS;
const LEASE_POLL_MS = 25;

/** The wait budget in force (SCENARIO_EVIDENCE_LEASE_WAIT_MS). */
export function cardDocumentLeaseWaitMs(): number {
  return SCENARIO_EVIDENCE_LEASE_WAIT_MS;
}

/**
 * Take the card's lease, polling (no connection held between polls) until the
 * wait budget runs out. Returns the owner token, or null when another writer
 * still holds it.
 */
export async function acquireCardEvidenceLease(cardId: string): Promise<string | null> {
  const ns = scenarioEvidenceLeaseNamespace(cardId);
  const owner = crypto.randomUUID();
  const deadline = Date.now() + cardDocumentLeaseWaitMs();
  for (;;) {
    if (await claimCreateLease(ns, SCENARIO_EVIDENCE_LEASE_KEY, owner, SCENARIO_EVIDENCE_LEASE_TTL_SECS)) return owner;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, LEASE_POLL_MS + Math.floor(Math.random() * LEASE_POLL_MS)));
  }
}

/** Owner-scoped release that never throws: a failed DELETE leaves the lease to expire on its TTL. */
export async function releaseCardEvidenceLease(cardId: string, owner: string): Promise<void> {
  try {
    await releaseCreateLease(scenarioEvidenceLeaseNamespace(cardId), SCENARIO_EVIDENCE_LEASE_KEY, owner);
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr-db',
      method: 'releaseCardEvidenceLease',
      degradedTo: `card scenario-evidence lease expires on its ${SCENARIO_EVIDENCE_LEASE_TTL_SECS}s TTL`,
    });
  }
}

/**
 * True only when `owner` still holds the card's lease with enough time left for
 * the PATCH. A failed read is answered false (do not write Planka): writing on
 * an unknown lease state is the lost update this check exists to stop.
 * `degradedTo` names the caller's answer in the swallowed-failure report.
 */
export async function cardEvidenceLeaseStillHeld(
  cardId: string,
  owner: string,
  degradedTo = '503 scenario_evidence_lease_lost; no Planka write, this request\'s rows deleted',
): Promise<boolean> {
  try {
    return await createLeaseStillHeld(
      scenarioEvidenceLeaseNamespace(cardId),
      SCENARIO_EVIDENCE_LEASE_KEY,
      owner,
      SCENARIO_EVIDENCE_LEASE_MIN_REMAINING_SECS,
    );
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr-db',
      method: 'cardEvidenceLeaseStillHeld',
      degradedTo,
    });
    return false;
  }
}

interface ReadCardResult {
  boardId?: string | null;
  listId?: string | null;
  description?: string | null;
}

/** A Planka card read, mapped to the route's answers (404 / 502) or the card. */
export async function readCard(
  agent: ReturnType<typeof projectCardPlankaAgent>,
  cardId: string,
  context = 'cards/scenario-evidence card fetch',
): Promise<{ card: ReadCardResult } | { response: Response }> {
  try {
    return { card: ((await agent.cards.get(cardId)).item ?? {}) as ReadCardResult };
  } catch (err) {
    if (err instanceof PlankaError && (err.status === 404 || err.status === 403)) return { response: cardNotFound(cardId) };
    if (err instanceof PlankaError) {
      return {
        response: body(502, 'planka_card_fetch_failed', {
          message: clientSafePlankaErrorMessage(err, context),
          card_id: cardId,
        }),
      };
    }
    throw err;
  }
}
