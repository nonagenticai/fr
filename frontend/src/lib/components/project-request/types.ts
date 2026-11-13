// Shapes of the two-stage project-request lifecycle endpoints
// (backend/src/routes/project-request-lifecycle.ts, table project_outlines).

import type { ProposedPlanView } from '$lib/types/plan';

// Mirrors backend OutlineDeliverableSchema (types/api.ts).
export interface OutlineDeliverable {
	kind: string;
	title: string;
	description?: string;
	acceptance_criteria: string[];
	checked_by?: string;
}

export interface OutlineMilestone {
	name: string;
	target_date?: string;
}

export interface Outline {
	id: string;
	request_id?: string;
	version: number;
	status: 'proposed' | 'superseded' | 'approved' | 'rejected';
	summary: string | null;
	deliverables: OutlineDeliverable[];
	intermediate_deliverables: OutlineDeliverable[];
	milestones: OutlineMilestone[];
	effort_estimate: { value: number; unit: 'hours' | 'days' | 'weeks'; note?: string } | null;
	// ⚠️ An ESTIMATE, never money spent — billing has no per-project cost data.
	cost_estimate: { currency: string; amount: number; basis?: string } | null;
	approval_id: string | null;
	/**
	 * Status of the linked approval (`approvals.status`), joined by
	 * GET /api/project-requests/:id/outlines. Null/absent when no approval is
	 * linked. A `proposed` outline whose approval is voided/rejected/expired
	 * cannot be decided.
	 */
	approval_status?: string | null;
	proposed_by?: string | null;
	proposed_at: string;
	decided_at: string | null;
	decision_note: string | null;
	/**
	 * fr#1484 — the server-built PROPOSED plan when this outline carries a
	 * phase_plan (null on a legacy outline). Rendered by ProjectPlanView
	 * mode="proposed"; the AT6 card count is the server's, never re-derived.
	 */
	plan_view?: ProposedPlanView | null;
	/** Set when the stored phase_plan no longer parses — said, never shown as an empty plan. */
	plan_view_error?: string;
}

/** POST /api/project-requests/:id/submit, unwrapped from `{ data }`. */
export interface SubmitProjectRequestResult {
	id: string;
	status: string;
	dispatched: boolean;
	dispatch_note?: string;
	[key: string]: unknown;
}

/** Request statuses in which an outline can exist (or is being produced). */
export const OUTLINE_STATUSES: readonly string[] = [
	'submitted',
	'analysing',
	'outline_proposed',
	'approved',
	'promoted'
];

/** Statuses from which the backend accepts a submit (EVENT_SOURCES.submit). */
export const SUBMITTABLE_STATUSES: readonly string[] = ['draft', 'failed'];
