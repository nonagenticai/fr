// The standalone GET /api/projects/:id/conveyor-history route still answers read-model Blocks
// (`{data, meta}`); the components render cockpit Panels. One conversion, used only off the cockpit.
import type { Block } from '$lib/types/read-model';
import type { Panel } from '$lib/types/panel';

export function panelFromLegacyBlock<T>(b: Block<T>): Panel<T> {
  const src = String(b.meta.source).replace(/-/g, '_');
  if (b.meta.available && b.data !== null) {
    return b.meta.note
      ? { data: b.data, as_of: b.meta.fetched_at, health: 'degraded', detail_code: `${src}_partial` }
      : { data: b.data, as_of: b.meta.fetched_at, health: 'ok' };
  }
  const kind = b.meta.unavailable_kind ?? 'error';
  return kind === 'error'
    ? { data: null, as_of: null, health: 'down', detail_code: `${src}_error` }
    : { data: null, as_of: b.meta.fetched_at, health: 'ok', detail_code: `${src}_${kind}` };
}
