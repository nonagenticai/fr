// commandPalette.svelte.ts
// ========================
// Transient UI state for the operator command palette (CmdK) plus a persisted
// "recents" history. Owning open/query in a store (rather than local to
// CmdK.svelte) lets any surface summon the palette, and lets recents survive a
// reload. The runnable command ITEMS (routes, actions, threads) are assembled
// in CmdK from the nav registry + stores — this store only holds the UI state
// and the recents list, keyed by a stable command id.

const RECENTS_KEY = 'fr.cmdk.recents';
const MAX_RECENTS = 6;

export interface RecentCommand {
  /** Stable id used to dedup + re-resolve, e.g. `route:workers`, `create:requirement`. */
  id: string;
  label: string;
  hint?: string;
}

/**
 * The persisted recents list.
 *
 * ⚠️ THE DEGRADE HERE IS LEGITIMATE, AND IT WAS STILL UNRECORDED. `[]` from this
 * function is not a claim about anything on the server — recents are a
 * per-browser convenience with no remote counterpart, and CmdK renders the list
 * of runnable commands from the nav registry regardless, so an empty recents
 * section tells the user nothing false. Giving it a third "unreadable" state
 * would be contortion.
 *
 * What was wrong is that a corrupt/quota-truncated payload silently DROPPED the
 * history and `persistRecents` then overwrote the evidence on the very next
 * command run. The catch records in band — `console.warn` naming the key — so
 * the loss is observable without inventing UI for it.
 */
export function loadRecents(): RecentCommand[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentCommand =>
          !!r &&
          typeof (r as RecentCommand).id === 'string' &&
          typeof (r as RecentCommand).label === 'string',
      )
      .slice(0, MAX_RECENTS);
  } catch (err) {
    // Legitimate degrade, recorded rather than silent — see the docstring.
    console.warn(
      `[commandPalette] discarding unreadable recents at "${RECENTS_KEY}"`,
      err,
    );
    return [];
  }
}

export function persistRecents(recents: RecentCommand[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // private mode / quota exceeded — recents are best-effort, never block.
  }
}

class CommandPaletteStore {
  open = $state(false);
  query = $state('');
  recents = $state<RecentCommand[]>(loadRecents());

  show(): void {
    this.query = '';
    this.open = true;
  }

  hide(): void {
    this.open = false;
  }

  toggle(): void {
    if (this.open) {
      this.hide();
    } else {
      this.show();
    }
  }

  /** Record a run at the top of recents (dedup by id, capped at MAX_RECENTS). */
  remember(cmd: RecentCommand): void {
    const next = [cmd, ...this.recents.filter((r) => r.id !== cmd.id)].slice(0, MAX_RECENTS);
    this.recents = next;
    persistRecents(next);
  }
}

export const commandPalette = new CommandPaletteStore();
