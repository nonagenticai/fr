// Spec 2 §13.2 — suggestion-detection heuristic.
// Closes §15 #1: emits suggested_schedules candidates when a user fires
// the same project's manual intake at the same time-of-day on three
// distinct days within the lookback window.
//
// Window selection: ±15 min around the modal hour (UTC). The lookback
// horizon is wide enough to catch weekly cadences (3 weeks ≥ 3 same-DOW
// hits) while narrow enough to avoid stale candidates.

export interface RunRow {
  tenant_id: string;
  project_id: string;
  triggered_by_user_id: string | null;
  kind: 'cron' | 'manual' | 'webhook';
  fired_at: Date;
}

export interface Candidate {
  tenant_id: string;
  project_id: string;
  user_id: string;
  hour_utc: number;          // 0-23
  example_run_count: number; // ≥ 3
  hint_summary: string;
}

interface BucketKey {
  tenant_id: string;
  project_id: string;
  user_id: string;
  hour_utc: number;
}

const WINDOW_MIN = 15;
const REQUIRED_DAYS = 3;

function bucketKey(r: RunRow): BucketKey | null {
  if (r.triggered_by_user_id === null) return null;
  if (r.kind !== 'manual') return null;
  return {
    tenant_id: r.tenant_id,
    project_id: r.project_id,
    user_id: r.triggered_by_user_id,
    hour_utc: r.fired_at.getUTCHours(),
  };
}

function keyString(k: BucketKey): string {
  return `${k.tenant_id}|${k.project_id}|${k.user_id}|${k.hour_utc}`;
}

/**
 * True if `d` falls within ±WINDOW_MIN minutes of the start of `hour:00` UTC.
 * Handles boundary at midnight by checking the adjacent hours' margins.
 */
function withinWindow(d: Date, hour: number): boolean {
  const dh = d.getUTCHours();
  const dm = d.getUTCMinutes();
  if (dh === hour) return dm <= WINDOW_MIN || dm >= 60 - WINDOW_MIN;
  if (dh === (hour + 1) % 24) return dm < WINDOW_MIN;
  if (dh === (hour + 23) % 24) return dm >= 60 - WINDOW_MIN;
  return false;
}

export function detectCandidates(
  runs: RunRow[],
  andonedProjectIds: ReadonlySet<string> = new Set(),
): Candidate[] {
  const buckets = new Map<string, { key: BucketKey; days: Set<string>; count: number }>();
  for (const r of runs) {
    // Andon-cord (migration 050): skip runs whose project has the cord
    // pulled. Caller passes in the set of project_ids with andon_engaged=true.
    if (andonedProjectIds.has(r.project_id)) continue;
    const k = bucketKey(r);
    if (!k) continue;
    if (!withinWindow(r.fired_at, k.hour_utc)) continue;
    const ks = keyString(k);
    const day = r.fired_at.toISOString().slice(0, 10);
    const b = buckets.get(ks) ?? { key: k, days: new Set(), count: 0 };
    b.days.add(day);
    b.count += 1;
    buckets.set(ks, b);
  }

  const out: Candidate[] = [];
  for (const b of buckets.values()) {
    if (b.days.size >= REQUIRED_DAYS) {
      out.push({
        tenant_id: b.key.tenant_id,
        project_id: b.key.project_id,
        user_id: b.key.user_id,
        hour_utc: b.key.hour_utc,
        example_run_count: b.count,
        hint_summary: `${b.count} manual runs at ~${String(b.key.hour_utc).padStart(2, '0')}:00 UTC across ${b.days.size} distinct days`,
      });
    }
  }
  return out;
}
