import { AssetError } from '$lib/api/assets';

export interface PollErrorHandlers {
  onSilentStop: () => void;
  onUserError: (message: string) => void;
}

/**
 * Decide whether a polling error should be surfaced to the user.
 * 404 = the job is gone (deleted, GC'd, never existed) → stop quietly.
 * Any other status (or non-AssetError) = show it.
 */
export function handlePollError(
  err: unknown,
  { onSilentStop, onUserError }: PollErrorHandlers,
): void {
  if (err instanceof AssetError && err.status === 404) {
    onSilentStop();
    return;
  }
  onUserError(err instanceof Error ? err.message : String(err));
}
