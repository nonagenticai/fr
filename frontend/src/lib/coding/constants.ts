/**
 * How often the page re-fetches an in-flight job's status. Smaller is
 * snappier; larger reduces backend load. Backend analyses run for
 * seconds-to-minutes — 3s is a reasonable middle ground.
 */
export const POLL_INTERVAL_MS = 3_000;

/**
 * Window the frontend uses to derive a fallback `client_idempotency_key`
 * when the caller doesn't already have a stable key (e.g. repoHeadSha).
 * MUST stay <= the backend dedup window in
 * `backend/src/integrations/coding.ts` (currently 10 minutes); tighter
 * is fine, looser would let the backend dedup hits get split across
 * frontend buckets.
 */
export const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1_000;
