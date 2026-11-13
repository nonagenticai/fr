// src/lib/approvals/pushChannels.ts
//
// fr-agui P1-TEAM-b — which channels can reach a member who is NOT looking at fr.
// Mirror of the backend's `PUSH_CHANNELS` (`domain/engagement/approval-routing.ts`),
// pinned EQUAL by `backend/tests/unit/lib/tenant-member-arm-parity.test.ts`. Pure, no
// `$lib` imports, so that test can load it.
//
// `inapp` and `websocket` are deliberately absent: they reach you only while you are
// already looking at fr, which is why they cannot discharge a gate.

export const PUSH_CHANNELS: ReadonlySet<string> = new Set(['telegram', 'email', 'teams', 'voice', 'mcp']);

/** True iff at least one ENABLED pref is a push channel. */
export function hasEnabledPushChannel(
  prefs: ReadonlyArray<{ channel: string; enabled?: boolean | null }>,
): boolean {
  return prefs.some((p) => p.enabled !== false && PUSH_CHANNELS.has(p.channel));
}
