// src/routes/me/notification-prefs.ts
//
// WS1 Phase 1A — per-user notification-type preferences (the WHAT layer). The
// GET returns the full (event_type × channel) matrix merged with code defaults
// so the UI always renders a complete grid; the PUT is a replace-all upsert.
// Scoped to the authed caller's user.id.
import { validateAuth } from '../../middleware/auth';
import { jsonResponse } from '../../utils/response';
import {
  getNotificationPrefsMatrix,
  replaceNotificationPrefs,
} from '../../domain/engagement/notification-prefs';
// The body schema lives in ./notification-prefs-schemas (side-effect free), shared
// with the capability declaration (fr-agui P4b part 3, capabilities/account/notifications.ts).
import { ReplaceBodySchema } from './notification-prefs-schemas';

/** GET /api/me/notification-prefs — full matrix (stored merged over defaults). */
export async function handleListMyNotificationPrefs(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const matrix = await getNotificationPrefsMatrix(user.id);
  return jsonResponse({ data: matrix });
}

/** PUT /api/me/notification-prefs — replace-all upsert of explicit prefs. */
export async function handleReplaceMyNotificationPrefs(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = await req.json();
  const parsed = ReplaceBodySchema.parse(body);
  const matrix = await replaceNotificationPrefs(user.id, parsed.prefs);
  return jsonResponse({ data: matrix });
}
