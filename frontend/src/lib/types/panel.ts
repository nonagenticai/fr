// panel.ts — the cockpit read model v2 envelope (backend services/cockpit/panel.ts, R-CK8).
//
//   Panel<T> = { data, as_of, health: ok | degraded | down, down_since?, detail_code? }
//
// ok       data is current.
// degraded data is shown but stale (the last known value) or partial; `down_since` says since when.
// down     nothing is known; `data` is null.
// ok + data null + detail_code   = not applicable to this project (no board, no RM link, …).
//
// ⛔ `detail_code` is a machine code. It is shown ONLY behind a "Details" disclosure — the main view
// says it in plain words via `panelSentence`. There is no field a raw upstream message travels in.

export type PanelHealth = 'ok' | 'degraded' | 'down';

export interface Panel<T> {
  data: T | null;
  as_of: string | null;
  health: PanelHealth;
  down_since?: string;
  detail_code?: string;
}

/** Narrow a panel to one whose data is present (ok OR degraded). */
export function hasData<T>(p: Panel<T> | null | undefined): p is Panel<T> & { data: T } {
  return !!p && p.data !== null && p.data !== undefined;
}

const SOURCE_WORDS: ReadonlyArray<[string, string]> = [
  ['conveyor_history', 'the conveyor history'],
  ['planka', 'the board'],
  ['rm', 'requirements'],
  ['fr_db', 'the project database'],
  ['artifacts', 'the artifact store'],
  ['billing', 'billing'],
  ['n8n', 'the workflow engine'],
  ['workers', 'the worker service'],
  ['flow', 'the flow record'],
];

/** Plain words for a few known not-applicable / gap codes. */
const CODE_SENTENCES: Readonly<Record<string, string>> = {
  flow_data_not_connected: 'Flow data not connected yet.',
  planka_no_board: 'This project has no board.',
  billing_project_not_attributable: "This project's spend cannot be attributed to it.",
  conveyor_not_linked: 'This project is not run by the conveyor.',
};

/** Which source a detail code names, in words ("the board"), or null. */
export function sourceWords(code: string | undefined): string | null {
  if (!code) return null;
  for (const [prefix, words] of SOURCE_WORDS) if (code === prefix || code.startsWith(`${prefix}_`)) return words;
  return null;
}

function clock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
}

/**
 * One plain sentence for a panel that is not simply ok-with-data, or null when it is. Never
 * contains the detail code.
 */
export function panelSentence<T>(p: Panel<T>, what = 'This'): string | null {
  const known = p.detail_code ? CODE_SENTENCES[p.detail_code] : undefined;
  if (p.health === 'ok') {
    if (hasData(p)) return null;
    return known ?? 'Nothing to show for this project.';
  }
  if (known) return known;
  const src = sourceWords(p.detail_code);
  const since = clock(p.down_since);
  if (p.health === 'down') {
    return `${what} couldn't be loaded${src ? ` (${src} is not answering)` : ''}${since ? ` since ${since}` : ''}.`;
  }
  const asOf = clock(p.as_of);
  if (p.down_since) {
    return `Showing what was known${asOf ? ` at ${asOf}` : ''}; ${src ?? 'a source'} has not answered${since ? ` since ${since}` : ''}.`;
  }
  return `Partly unavailable${src ? `: ${src} could not be read` : ''}.`;
}
