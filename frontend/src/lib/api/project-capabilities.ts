// GET /api/projects/:id/capabilities — R271: the capabilities the PM selected
// for the project (R260, requirements_management rm#225) and WHY, plus the
// selection history. READ-ONLY: only the PM / n8n writes the selection; fr has
// no write path and this module has no write function.
//
// ⛔ A failed read is NOT an empty selection: it throws, and the caller renders
// "could not be read". `selected: []` is a real answer (the PM has not selected
// yet — every pre-R260 project).

import { authFetch } from './auth-fetch';
import { formatApiError } from './api-error';

/** R302 (rm#227): RM's vocabularies, read as plain strings (RM types them `str`). */
export type CapabilityInvolvement = 'none' | 'light' | 'standard' | 'heavy';
export type CapabilityLevel = 'low' | 'medium' | 'high';

export interface SelectedCapability {
  name: string;
  capability_id: string;
  reason: string;
  /**
   * R302 — the PM's capability-consult decision. Every field is absent on a
   * selection written before R302 (or without a consult): null / [] then, and
   * the UI renders nothing for it.
   */
  involvement: CapabilityInvolvement | string | null;
  purpose: string | null;
  rigor: CapabilityLevel | string | null;
  complexity: CapabilityLevel | string | null;
  /** Capability NAMES whose work must precede this one (the PM's ordering). */
  order_after: string[];
  /** The raw `cap.<c>.consult` answer (likely_card_types, operation_order, questions …). */
  consult: Record<string, unknown> | null;
  approval_id: string | null;
  selected_at: string;
}

export interface CapabilityEvent {
  id: string;
  project_id?: string;
  added: string[];
  removed: string[];
  approval_id: string | null;
  subject_id: string;
  created_at: string;
}

export interface ProjectCapabilities {
  project_type: string | null;
  selected: SelectedCapability[];
  implicit: string[];
  /** Newest first. */
  events: CapabilityEvent[];
  total_events: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function optString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Read the selection. Throws (with one sentence) on any failure. */
export async function getProjectCapabilities(projectId: string): Promise<ProjectCapabilities> {
  const r = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/capabilities`, {});
  if (!r.ok) {
    const body: unknown = await r.json().catch(() => null);
    throw new Error(formatApiError(body, `HTTP ${r.status}`));
  }
  const json: unknown = await r.json();
  const parsed = normalizeProjectCapabilities(isRecord(json) ? json.data : null);
  // A 200 without the shape is a broken answer, not "nothing selected".
  if (!parsed) throw new Error('The capability selection answer was malformed.');
  return parsed;
}

/**
 * The selection as the UI reads it, from the raw `{project_type, selected, implicit, events}` (the
 * capabilities route's `data`, or the cockpit's `capabilities` panel). null = malformed.
 */
export function normalizeProjectCapabilities(d: unknown): ProjectCapabilities | null {
  if (!isRecord(d) || !Array.isArray(d.selected) || !Array.isArray(d.events)) return null;
  const events = (d.events as unknown[]).filter(isRecord).map((e) => ({
    id: String(e.id ?? ''),
    project_id: typeof e.project_id === 'string' ? e.project_id : undefined,
    added: strings(e.added),
    removed: strings(e.removed),
    approval_id: typeof e.approval_id === 'string' ? e.approval_id : null,
    subject_id: typeof e.subject_id === 'string' ? e.subject_id : '',
    created_at: typeof e.created_at === 'string' ? e.created_at : '',
  }));
  return {
    project_type: typeof d.project_type === 'string' ? d.project_type : null,
    selected: (d.selected as unknown[]).filter(isRecord).map((c) => ({
      name: String(c.name ?? ''),
      capability_id: String(c.capability_id ?? ''),
      reason: typeof c.reason === 'string' ? c.reason : '',
      involvement: optString(c.involvement),
      purpose: optString(c.purpose),
      rigor: optString(c.rigor),
      complexity: optString(c.complexity),
      order_after: strings(c.order_after),
      consult: isRecord(c.consult) ? c.consult : null,
      approval_id: typeof c.approval_id === 'string' ? c.approval_id : null,
      selected_at: typeof c.selected_at === 'string' ? c.selected_at : '',
    })),
    implicit: strings(d.implicit),
    events,
    total_events: typeof d.total_events === 'number' ? d.total_events : events.length,
  };
}
