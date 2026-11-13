// src/services/artifact-review-callback.ts
//
// Fire-and-forget callback to the producing n8n workflow when a human
// submits a review on an artifact it created. The callback URL/path comes
// from artifact_service (`artifacts.review_callback_url`) — set by the n8n
// custom node on upload. Empty/missing → no callback, the status update on
// the artifact is the source of truth.
//
// The callback is best-effort: we log failures but never fail the user's
// review request, because the upstream review row is already committed by
// the time we get here.
import { n8nClient } from './n8n';

export interface ArtifactReviewCallbackPayload {
  artifact_id: string;
  project_id: string;
  decision: 'approve' | 'reject' | 'revise';
  comment: string | null;
  reviewer_id: string;
  reviewer_tenant_id: string;
  reviewed_at: string;
}

/**
 * POST the review decision to the producer-supplied URL or n8n path.
 *
 * `callbackUrl` can be either:
 *   - A full http(s) URL (used verbatim)
 *   - A relative path (resolved against the n8n webhook base via
 *     `n8nClient.callWebhook`)
 *
 * Errors are logged and swallowed.
 */
export async function fireArtifactReviewCallback(
  callbackUrl: string | null | undefined,
  payload: ArtifactReviewCallbackPayload,
): Promise<void> {
  if (!callbackUrl || callbackUrl.trim().length === 0) return;

  try {
    if (/^https?:\/\//i.test(callbackUrl)) {
      // Full URL — POST directly with a short timeout. No callback secret;
      // the producer chose this URL and is on the hook for validating its
      // own inbound.
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      // Relative path — let the n8n client resolve it under the configured
      // webhook base and apply the standard approval-callback-secret
      // header so the universal receiver can authenticate.
      //
      // Attribution: the header project is pinned to the body's `project_id`
      // (the route's project, already checked by assertProjectAccess). Without
      // the explicit key the header would fall back to the request context —
      // a second, independently derived value — and could name a different
      // project from the body. If `project_id` is not a real uuid the header
      // is omitted rather than borrowed from context. The actor stays the
      // context default: the authenticated reviewer's Keycloak `sub`.
      await n8nClient.callWebhook(
        callbackUrl.replace(/^\/+/, ''),
        payload as unknown as Record<string, unknown>,
        { projectId: payload.project_id },
      );
    }
    console.log(
      `[artifact-review-callback] Sent ${payload.decision} decision for artifact ${payload.artifact_id} to ${callbackUrl}`,
    );
  } catch (err) {
    // Best-effort: log and move on. The artifact_reviews row is already
    // persisted; the producer can poll review history to recover.
    console.error(
      `[artifact-review-callback] Failed to POST review for artifact ${payload.artifact_id} to ${callbackUrl}:`,
      err,
    );
  }
}
