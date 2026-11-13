// fr-agui SPEC §7.4 / §13 P3 — the Execution hub's reads (backend
// routes/project-execution.ts). Every route answers `{ data }`, and every
// `data` names the project it answers for (`project_id`): a body for another
// project is refused here too, never rendered. Free text (block reasons, card
// names, run fields) is passed through `redactForDisplay` before it reaches a
// component — the backend already scrubbed it; this is the render-side half.
import { authFetch } from './auth-fetch';
import { redactForDisplay } from './agent-redact';
import { logRawError } from '$lib/workers/wm-errors';

export interface ProjectRun {
	id: string;
	status: string | null;
	status_source: 'n8n' | 'pruned' | 'unavailable';
	started_at?: string;
	stopped_at?: string;
	duration_ms?: number;
	triggered_at: string | null;
	initiated_via: string;
	initiated_by: string | null;
	initiated_by_me: boolean;
	project_id: string;
}

export interface ProjectRuns {
	project_id: string;
	scope: 'all_members';
	runs: ProjectRun[];
	meta: { cursor: string | null; hasMore: boolean };
}

export interface WipPart {
	available: boolean;
	reason?: string;
	label?: string;
	[k: string]: unknown;
}

export interface ProjectWip {
	project_id: string;
	limit: WipPart & { effective_wip_limit?: number | null; source?: string; paused?: boolean };
	board_count: WipPart & { doing?: number };
	headroom: number | null;
	enforced_by: 'n8n';
}

export interface BlockedCard {
	id: string;
	name: string;
	list_name: string | null;
	blocked_since: string | null;
	block_reason: string | null;
	escalation: { approval_id: string; kind: string; description: string; created_at: string | null; url: string } | null;
	url: string;
}

export interface ProjectBlockedCards {
	project_id: string;
	available: boolean;
	reason?: string;
	cards: BlockedCard[];
}

export interface AgentAction {
	capability: string | null;
	actor: string | null;
	by_me: boolean;
	initiator: string;
	outcome: string;
	http_status: number | null;
	at: string | null;
}

export interface ProjectAgentActions {
	project_id: string;
	actions: AgentAction[];
}

export interface ProjectCardsByType {
	project_id: string;
	card_type: string;
	known: boolean;
	available?: boolean;
	reason?: string;
	cards: Array<{ id: string; name: string; list_name: string | null; phase: string; url: string }>;
}

export interface ProjectConveyorRuns {
	project_id: string;
	available: boolean;
	reason?: string;
	source?: string;
	runs?: Array<{ id: string; status: string | null; started_at: string | null; stopped_at: string | null; card_id: string | null }>;
	truncated?: boolean;
}

export class ProjectReadError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | undefined,
		message: string
	) {
		super(message);
		this.name = 'ProjectReadError';
	}
}

/** Neutral page copy for a failed read (fr#1409): what failed and fr's refusal code, never the raw status/body. */
function neutral(what: string, code: string | undefined): string {
	return `Couldn't read this project's ${what}${code ? ` (${code})` : ''}. Try again.`;
}

/** `what` names the read in copy; `url` is the route, spelled at each call site so the capability guard resolves it. */
/**
 * `quiet`: an optional read whose failure the caller shows as "nothing new" (the project
 * page's "Start again" banner) — refused the same way, but not logged as an app error.
 */
async function read<T extends { project_id: string }>(
	projectId: string,
	what: string,
	url: string,
	query: Record<string, string | undefined> = {},
	opts: { quiet?: boolean } = {}
): Promise<T> {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, v);
	const r = await authFetch(qs.size ? `${url}?${qs}` : url);
	const body = (await r.json().catch(() => null)) as { data?: T; error?: unknown; code?: unknown } | null;
	if (!r.ok) {
		const code = typeof body?.code === 'string' ? body.code : undefined;
		if (!opts.quiet) logRawError(`project-execution ${what}`, r.status, body);
		throw new ProjectReadError(r.status, code, neutral(what, code));
	}
	const data = body?.data;
	if (!data || data.project_id !== projectId) {
		throw new ProjectReadError(502, 'project_answer_mismatch', `${what}: the answer is not for this project`);
	}
	return redactForDisplay(data);
}

const enc = encodeURIComponent;
export const fetchProjectRuns = (projectId: string, opts: { since?: string; cursor?: string; limit?: number } = {}) =>
	read<ProjectRuns>(projectId, 'runs', `/api/projects/${enc(projectId)}/executions`, { since: opts.since, cursor: opts.cursor, limit: opts.limit?.toString() });
export const fetchProjectWip = (projectId: string, opts: { quiet?: boolean } = {}) =>
	read<ProjectWip>(projectId, 'WIP', `/api/projects/${enc(projectId)}/wip`, {}, opts);
export const fetchProjectBlockedCards = (projectId: string) =>
	read<ProjectBlockedCards>(projectId, 'blocked cards', `/api/projects/${enc(projectId)}/blocked-cards`);
export const fetchProjectAgentActions = (projectId: string) =>
	read<ProjectAgentActions>(projectId, 'agent activity', `/api/projects/${enc(projectId)}/agent-actions`);
export const fetchProjectCardsByType = (projectId: string, cardType: string) =>
	read<ProjectCardsByType>(projectId, 'cards', `/api/projects/${enc(projectId)}/cards-by-type`, { card_type: cardType });
export const fetchProjectConveyorRuns = (projectId: string) =>
	read<ProjectConveyorRuns>(projectId, 'conveyor runs', `/api/projects/${enc(projectId)}/conveyor-executions`);

// R311 PR 5 — what the conveyor REPORTED went wrong (start_failed / coach_failed) and the
// start retry fr offers from those records (backend routes/project-conveyor-start.ts).
export interface ConveyorNotice {
	id: string;
	kind: 'start_failed' | 'coach_failed';
	execution_id: string;
	idempotency_key: string | null;
	card_id: string | null;
	flow: string | null;
	node: string | null;
	error_class: string | null;
	error_text: string;
	created_at: string;
}

export interface ConveyorStartAttempt {
	attempt_n: number;
	idempotency_key: string;
	/** `restart`: a member's project or phase restart (George 2026-10-31). */
	trigger: 'create' | 'retry' | 'restart';
	outcome: 'pending' | 'delivered' | 'failed' | 'board_link_failed' | 'inert' | 'refused';
	outcome_detail: string | null;
	created_at: string | null;
	completed_at: string | null;
}

export type ConveyorRetryOffer =
	| {
			available: true;
			/**
			 * R319 `no_progress`: the start was accepted 10+ minutes ago but the project's first card is still waiting.
			 * R320 `stalled`: the project's first card has not moved for 30+ minutes.
			 */
			reason: 'start_failed' | 'no_board_link' | 'not_delivered' | 'no_progress' | 'stalled';
			next_attempt_n: number;
			next_idempotency_key: string;
	  }
	| {
			available: false;
			/** R319 `on_hold`: no progress, but the project is on hold — nothing is offered until it continues. */
			reason: 'start_in_flight' | 'started' | 'on_hold' | 'conveyor_not_configured' | 'no_start_recorded' | 'start_request_invalid';
	  }
	/** The conveyor declined the start; `message` is the member's text for `code`, shown as written. */
	| { available: false; reason: 'refused_by_conveyor'; code: string; message: string }
	/** R320: a "Start again" of a stalled project was not carried out; `message` is the member's text, shown as written. */
	| { available: false; reason: 'restart_not_done'; message: string };

/** The member's text for each retry-offer reason (the Execution hub's line under "Conveyor failures"). */
export const CONVEYOR_RETRY_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
	start_failed: 'The conveyor reported that the start failed.',
	no_board_link:
		"This project isn't connected to its work board yet, so its start was never sent. Retry, and if it fails again please contact support.",
	not_delivered: 'We could not deliver the start to the conveyor. Retry, and if it fails again please contact support.',
	no_progress:
		"This project was started more than 10 minutes ago, but its work hasn't begun yet. You can start it again; nothing that already happened is lost.",
	stalled:
		"This project's first step hasn't moved for more than 30 minutes. You can start it again; nothing that already happened is lost.",
	on_hold: "This project's work hasn't begun yet, but the project is on hold. Once it continues you can start it again if it still hasn't moved.",
	start_in_flight: 'A start is being sent right now.',
	started: 'The conveyor accepted the start and reported no failure.',
	conveyor_not_configured: 'The conveyor start is not configured for this workspace.',
	no_start_recorded: 'No conveyor start is on record for this project.',
	start_request_invalid: 'The start could not be sent because of a fault on our side. Please contact support.'
});

/**
 * The member's headline and text for each conveyor notice kind. Customer copy: the
 * conveyor's own fields (node, flow, card id, error class, error text) name internal
 * systems, so the hub shows them only under "Details for support".
 */
export const CONVEYOR_NOTICE_TEXT: Readonly<Record<ConveyorNotice['kind'], { title: string; text: string }>> = Object.freeze({
	start_failed: {
		title: 'The project could not be started',
		text: "The project's start did not complete. Retry it above, and if it fails again please contact support."
	},
	coach_failed: {
		title: 'A card could not be moved automatically',
		text: "One of this project's cards could not be moved on its own. Please move it, or start it again, by hand."
	}
});

/**
 * The retry offer as text. A conveyor refusal (`refused_by_conveyor`) carries fr's
 * own member text for the code (`message`), shown as written.
 */
export function conveyorRetryText(retry: ConveyorRetryOffer): string {
	if (retry.reason === 'refused_by_conveyor' || retry.reason === 'restart_not_done') return retry.message;
	return CONVEYOR_RETRY_REASON_TEXT[retry.reason] ?? retry.reason;
}

/**
 * One phase a member may restart (R349): RM's name and title, and `default_comment` — the comment
 * given when that phase's start was signed off (null when none), offered as the restart's comment.
 */
export interface ConveyorRestartPhase {
	name: string;
	title: string;
	default_comment: string | null;
}

/**
 * George 2026-10-31 / R349 2026-11-04: whether the project may be RESTARTED — the whole project,
 * or one phase. `phase` is the current phase (null = unknown, so only the whole project);
 * `phases` the phases that may be restarted (the current one and earlier, in order). Every card
 * in that scope runs again, finished ones included. Offered for every active, undelivered project.
 */
export type ConveyorRestartOffer =
	| { available: true; phase: string | null; phases: ConveyorRestartPhase[]; next_attempt_n: number; next_idempotency_key: string }
	| {
			available: false;
			reason: 'not_active' | 'delivered' | 'start_in_flight' | 'conveyor_not_configured' | 'not_on_conveyor' | 'on_hold';
			phase: string | null;
			phases: ConveyorRestartPhase[];
	  };

/** What a member asks for: the whole project, or one phase, with an optional steering comment. */
export type ConveyorRestartRequest = { scope: ConveyorRestartScope; phase?: string; comment?: string };

export type ConveyorRestartScope = 'project' | 'phase';

export interface ProjectConveyorNotices {
	project_id: string;
	retry: ConveyorRetryOffer;
	/** Absent from a backend that predates the restart. */
	restart?: ConveyorRestartOffer;
	notices: ConveyorNotice[];
	attempts: ConveyorStartAttempt[];
}

export const fetchProjectConveyorNotices = (projectId: string, opts: { quiet?: boolean } = {}) =>
	read<ProjectConveyorNotices>(projectId, 'conveyor notices', `/api/projects/${enc(projectId)}/conveyor-notices`, {}, opts);

export interface ConveyorRetryStarted {
	project_id: string;
	attempt_n: number;
	idempotency_key: string;
	offered_because?: string;
	/** A restart: its scope, (scope phase) the phase restarted, and the comment sent. */
	restart?: { scope: ConveyorRestartScope; phase: string | null; comment: string | null };
	/** A restart: how many of the conveyor's open questions on this project, plus open requests about its cards, it withdrew. */
	voided_asks?: number;
	status: 'pending';
}

/**
 * The member's "Retry the conveyor start" (POST, 202). A refusal (409
 * `conveyor_retry_not_offered`, …) is thrown with fr's code — shown, never swallowed.
 */
export async function retryProjectConveyorStart(
	projectId: string,
	restart?: ConveyorRestartRequest
): Promise<ConveyorRetryStarted> {
	// No restart ⇒ no body: the start retry, exactly as before. A restart sends `{scope, phase?, comment?}`.
	const init: RequestInit = restart
		? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(restart) }
		: { method: 'POST' };
	const r = await authFetch(`/api/projects/${enc(projectId)}/conveyor-start/retry`, init);
	const body = (await r.json().catch(() => null)) as { data?: ConveyorRetryStarted; error?: unknown; code?: unknown } | null;
	if (!r.ok) {
		const code = typeof body?.code === 'string' ? body.code : undefined;
		logRawError('project-execution conveyor retry', r.status, body);
		throw new ProjectReadError(r.status, code, `Couldn't retry the conveyor start${code ? ` (${code})` : ''}.`);
	}
	const data = body?.data;
	if (!data || data.project_id !== projectId) {
		throw new ProjectReadError(502, 'project_answer_mismatch', 'conveyor retry: the answer is not for this project');
	}
	return data;
}

export interface PhaseRailNode {
	phase: string;
	label: string;
	state: 'done' | 'active' | 'gate' | 'upcoming';
	isGate: boolean;
}

export interface ProjectPhaseRail {
	project_id: string;
	phase: string | null;
	next_gate: string | null;
	nodes: PhaseRailNode[];
}

/** `GET /api/projects/:id/phase` (RM-owned, read-only) — the hub's phase rail. Not `{ data }`-enveloped. */
export async function fetchProjectPhaseRail(projectId: string): Promise<ProjectPhaseRail> {
	const r = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/phase`);
	const body = (await r.json().catch(() => null)) as (ProjectPhaseRail & { error?: unknown; code?: unknown }) | null;
	if (!r.ok) {
		const code = typeof body?.code === 'string' ? body.code : undefined;
		logRawError('project-execution phase', r.status, body);
		throw new ProjectReadError(r.status, code, neutral('phase', code));
	}
	if (!body || body.project_id !== projectId) throw new ProjectReadError(502, 'project_answer_mismatch', 'phase: the answer is not for this project');
	return redactForDisplay({ ...body, nodes: Array.isArray(body.nodes) ? body.nodes : [] });
}
