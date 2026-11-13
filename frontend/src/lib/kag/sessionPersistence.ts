/**
 * sessionPersistence — SSR-safe localStorage backing for the KAG discovery
 * "working set" of sessions and the research page's single active session id.
 *
 * The Discovery Engine has NO session-list endpoint, so the client can only
 * remember the sessions it created/adopted. That working set (and the active
 * pointer) lived in volatile `$state` and vanished on reload. This module
 * persists it across visits.
 *
 * Everything degrades to a no-op under SSR (`typeof localStorage === 'undefined'`)
 * and swallows read/parse/quota errors — persistence is best-effort, never a
 * reason to break the surface. A corrupt payload reads back as an empty set.
 *
 * ⚠️ THE DEGRADE HERE IS LEGITIMATE, AND IT WAS STILL UNRECORDED.
 *
 * This is a LOCAL read: the empty set it returns is not a claim about server
 * state, and no surface renders "you have no sessions" as a fact about the
 * Discovery Engine on the strength of it — the DE has no session-list endpoint
 * at all, so the working set is only ever what this browser remembered. Losing
 * it is a degraded convenience, not a lie, and forcing a third "unreadable"
 * state onto the discover tab for it would be contortion.
 *
 * But it was silent, and the failure it swallows is real: a corrupt or
 * quota-truncated payload silently DELETES the user's remembered working set,
 * and the very next `saveSessions` overwrites the corruption, so the evidence is
 * gone before anyone can look at it. So the catch now records in band —
 * `console.warn` naming the key — which is the honest resolution for a degrade
 * that is correct but unobserved.
 */

/** A remembered discovery session (the minimal working-set entry). */
export interface PersistedSession {
  id: string;
  name: string;
}

// Distinct keys so the KAG discover tab and the research page never collide.
export const SESSIONS_KEY = 'kag:discover:sessions';
export const ACTIVE_KEY = 'kag:discover:activeId';
export const RESEARCH_KEY = 'research:sessionId';

function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

function loadScalar(key: string): string | null {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function saveScalar(key: string, value: string | null): void {
  if (!hasStorage()) return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // best-effort — ignore quota/serialization failures
  }
}

/** The persisted KAG discover working set (empty on SSR or corruption). */
export function loadSessions(): PersistedSession[] {
  if (!hasStorage()) return [];
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is { id: string; name?: unknown } =>
          !!s &&
          typeof s === 'object' &&
          typeof (s as { id?: unknown }).id === 'string' &&
          (s as { id: string }).id.length > 0,
      )
      .map((s) => ({
        id: s.id,
        name: typeof s.name === 'string' ? s.name : s.id,
      }));
  } catch (err) {
    // Legitimate degrade, recorded rather than silent — see the module header.
    // Reading a corrupt payload is the ONLY chance to observe it: the next save
    // overwrites it.
    console.warn(
      `[sessionPersistence] discarding unreadable working set at "${SESSIONS_KEY}"`,
      err,
    );
    return [];
  }
}

/** Persist the KAG discover working set (no-op on SSR). */
export function saveSessions(list: PersistedSession[]): void {
  if (!hasStorage()) return;
  try {
    const clean = list.map((s) => ({ id: s.id, name: s.name }));
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(clean));
  } catch {
    // best-effort — ignore quota/serialization failures
  }
}

/** The persisted active KAG discover session id (null if none/SSR). */
export function loadActiveId(): string | null {
  return loadScalar(ACTIVE_KEY);
}

/** Persist (or clear, when null) the active KAG discover session id. */
export function saveActiveId(id: string | null): void {
  saveScalar(ACTIVE_KEY, id);
}

/** The persisted research-page session id (null if none/SSR). */
export function loadResearchSessionId(): string | null {
  return loadScalar(RESEARCH_KEY);
}

/** Persist (or clear, when null) the research-page session id. */
export function saveResearchSessionId(id: string | null): void {
  saveScalar(RESEARCH_KEY, id);
}
