/**
 * fr-agui SPEC §13 P1c — the ONE switch for the `capability-invoke` confirm card.
 *
 * P1c-a shipped the backend half: `POST /api/capabilities/:id/invoke` and the
 * proposal path for the project agent's agent-native writes (the three toc
 * builds), with this switch OFF so a proposal nobody could confirm was never
 * shown (the builds PARKED instead).
 *
 * P1c-b ships the renderer (frontend/src/lib/components/agent/CapabilityInvokeCard.svelte,
 * routed by chat/MessageList.svelte) and turns it ON: the project agent's toc
 * build is now a `proposal` (no approval row, nothing run); the human's Confirm
 * calls the invoke route under their own session, which runs the action with
 * `initiator:'human'` and its declared approval policy — so the project-owner
 * policy still parks THERE, as the UI click would.
 */
export const CAPABILITY_INVOKE_CARD_SHIPPED = true;

/** Whether agent-native writes are proposed as `capability-invoke` confirm cards. */
export function capabilityInvokeCardEnabled(): boolean {
  return CAPABILITY_INVOKE_CARD_SHIPPED;
}

/**
 * fr-agui P1c / P2 — make `action` an agent-native write the project agent
 * PROPOSES as a `capability-invoke` confirm card, confirmed through
 * POST /api/capabilities/:id/invoke under the human's session. Gated on
 * `capabilityInvokeCardEnabled()`, read at registration time. The action must
 * name its project in `projectParam` — its own, or its PROJECT_BINDING row's
 * (agui/agent-surface.ts) — because the invoke route requires it in the body.
 */
export function withInvokeCard<A extends { name: string; confirm?: unknown }>(action: A): A {
  if (!capabilityInvokeCardEnabled()) return action;
  return {
    ...action,
    confirm: { http: { method: 'POST' as const, path: `/api/capabilities/${action.name}/invoke` }, card: 'capability-invoke' as const },
  };
}
