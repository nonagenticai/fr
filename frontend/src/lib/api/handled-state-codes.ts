/**
 * Typed error codes the backend uses for a STATE the UI renders, not for a
 * failure (fr#1385, `backend/src/routes/assets/workers.ts::providerModelsState`):
 *
 *   - `PROVIDER_NOT_ENABLED` (403): the workspace's LLM policy refuses the
 *     provider on purpose (the owner's commercial keys serve platform
 *     workspaces only).
 *   - `PROVIDER_UNAVAILABLE` (424): the provider's backend is down or dormant.
 *
 * The model picker shows these as a neutral line ($lib/workers/providers.ts
 * `ProviderStateError`). `authFetch` therefore does NOT report them to the
 * client-error sink: measured in prod (7d to 2026-10-05) they were the only
 * `client_error` rows for `/providers/:p/models`, i.e. a handled state was
 * being ranked as a frontend crash. The server-side `integration_error` line
 * for each one is unchanged, so the upstream outage is still visible to an
 * operator.
 *
 * Lives in `$lib/api` (not `$lib/workers`) because `providers.ts` imports
 * `authFetch`; the reverse import would be circular.
 */
export const HANDLED_STATE_CODES = [
  'PROVIDER_NOT_ENABLED',
  'PROVIDER_UNAVAILABLE',
] as const;
export type HandledStateCode = (typeof HANDLED_STATE_CODES)[number];

/** The only statuses the backend sends these codes with. */
export const HANDLED_STATE_STATUSES: ReadonlySet<number> = new Set([403, 424]);

/**
 * Refusals that are an EXPECTED BRANCH of a page, with the one status each comes
 * with: the page answers them with its next step, so they are not a frontend
 * failure and are not reported to the client-error sink either.
 *
 *   - `model_has_revisions` (409): a plain DELETE of an architecture model that
 *     has saved versions. The model page answers it by offering the delete
 *     WITH the versions (`?force=true`). Measured on prod 2026-10-28: every
 *     such delete was ranked as a `client_error`.
 */
export const EXPECTED_BRANCH_CODES: Readonly<Record<string, number>> = {
  model_has_revisions: 409,
};

export function isExpectedBranch(status: number, code: unknown): boolean {
  return typeof code === 'string' && Object.hasOwn(EXPECTED_BRANCH_CODES, code) && EXPECTED_BRANCH_CODES[code] === status;
}

export function isHandledStateCode(code: unknown): code is HandledStateCode {
  return (
    typeof code === 'string' &&
    (HANDLED_STATE_CODES as readonly string[]).includes(code)
  );
}

/**
 * Whether `response` carries one of the handled STATE codes in the backend's
 * `{ error: { code } }` envelope. Reads a CLONE, so the caller keeps the body.
 * Any parse failure reads as 'not a handled state' — it is then reported, which
 * is the fail-safe direction for a telemetry sink.
 */
export async function isHandledStateResponse(
  response: Response,
): Promise<boolean> {
  const expectedStatus = Object.values(EXPECTED_BRANCH_CODES).includes(response.status);
  if (!HANDLED_STATE_STATUSES.has(response.status) && !expectedStatus) return false;
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    } | null;
    const code = body?.error?.code;
    if (isExpectedBranch(response.status, code)) return true;
    return HANDLED_STATE_STATUSES.has(response.status) && isHandledStateCode(code);
  } catch {
    return false;
  }
}
