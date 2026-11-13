// R319 (2026-10-21) — "Start again" on the project page: a start the conveyor accepted 10+
// minutes ago whose first card is still waiting (backend retry offer `no_progress`), and
// (R320) a project whose first card has not moved for 30+ minutes (`stalled`). The
// same retry the Execution hub sends (POST /api/projects/:id/conveyor-start/retry); fr
// decides nothing — it offers what the backend says is offered, and a member chooses.
//
// ⛔ Customer copy: plain words, no internal system or card names (early-access members).
import {
	ProjectReadError,
	type ConveyorRestartOffer,
	type ConveyorRestartScope,
	type ConveyorRetryOffer
} from '$lib/api/project-execution';

export const START_AGAIN_TEXT = Object.freeze({
	headline: "This project hasn't started moving yet",
	body: 'It was started more than 10 minutes ago, but its work has not begun. You can start it again; nothing that already happened is lost.',
	button: 'Start again',
	busy: 'Starting again…',
	sent: 'Started again. It can take a few minutes for the work to appear on the board.',
	notOffered: "This project can't be started again right now. Refresh the page to see where it stands.",
	inProgress: 'Someone in your workspace is starting this project again right now.',
	failed: "We couldn't start the project again. Try again in a moment, and if it keeps failing please contact support."
});

/** R320: the banner's words for a project whose first step stopped moving (`stalled`). */
export const START_AGAIN_STALLED_TEXT = Object.freeze({
	headline: 'This project seems to have stopped moving',
	body: "Its first step hasn't moved for more than 30 minutes. You can start it again; nothing that already happened is lost."
});

/**
 * The project page offers "Start again" only for a delivered start that made no progress
 * (`no_progress`) or whose first step stalled (`stalled`, R320).
 */
export function startAgainOffered(retry: ConveyorRetryOffer | null | undefined): boolean {
	return !!retry && retry.available && (retry.reason === 'no_progress' || retry.reason === 'stalled');
}

/** The banner's headline and text for an offered "Start again" (null when none is offered). */
export function startAgainCopy(retry: ConveyorRetryOffer | null | undefined): { headline: string; body: string } | null {
	if (!startAgainOffered(retry)) return null;
	return retry!.reason === 'stalled' ? START_AGAIN_STALLED_TEXT : { headline: START_AGAIN_TEXT.headline, body: START_AGAIN_TEXT.body };
}

/**
 * R320: the member's text when a "Start again" was not carried out (the backend's
 * `restart_not_done` message, shown as written), else null.
 */
export function startAgainNotDoneText(retry: ConveyorRetryOffer | null | undefined): string | null {
	return retry && !retry.available && retry.reason === 'restart_not_done' ? retry.message : null;
}

/** The member's text for a failed "Start again" (never fr's raw code). */
export function startAgainErrorText(err: unknown): string {
	if (err instanceof ProjectReadError) {
		if (err.code === 'conveyor_retry_not_offered') return START_AGAIN_TEXT.notOffered;
		if (err.code === 'conveyor_start_in_progress') return START_AGAIN_TEXT.inProgress;
	}
	return START_AGAIN_TEXT.failed;
}

// ── George 2026-10-31 / R349 2026-11-04: "Start again" as a RESTART of the whole project or one phase ──
// Offered for every active project (backend `restart` offer). Every card in the chosen scope runs
// again, finished ones included; the conveyor's open questions on this project, plus open requests about its cards, are withdrawn.

export const RESTART_TEXT = Object.freeze({
	heading: 'Start again',
	body: 'Run this project again from the start, or run one of its phases again — the current one, or an earlier one where a problem began.',
	projectOption: 'Restart the whole project',
	phaseOption: 'Restart a phase',
	phaseSelect: 'Phase to restart',
	currentSuffix: ' (current)',
	commentLabel: 'Comment (optional)',
	commentHint: 'Tell the work what to do differently this time. Prefilled with the comment given when this phase was started.',
	button: 'Start again…',
	busy: 'Starting again…',
	sent: 'Started again. It can take a few minutes for the work to appear on the board.',
	notOffered: "This project can't be started again right now. Refresh the page to see where it stands.",
	inProgress: 'Someone in your workspace is starting this project again right now.',
	phaseInvalid: 'That phase can no longer be restarted. Refresh the page and choose again.',
	phaseUnknown: "This project's current phase isn't known, so only the whole project can be started again.",
	failed: "We couldn't start the project again. Try again in a moment, and if it keeps failing please contact support.",
	archived: 'This project is archived, so it cannot be started again.',
	notSetUp: "This project's work hasn't been set up yet, so it can't be started again.",
	noBoard: "This project doesn't have its work board yet, so it can't be started again.",
	noWorkspace: "This project isn't linked to a workspace, so it can't be started again. Please contact support."
});

/** The member's text for a restart that is not offered (null when it is offered). */
export const RESTART_NOT_OFFERED_TEXT: Readonly<Record<string, string>> = Object.freeze({
	not_active: 'Only an active project can be started again.',
	delivered: 'This project has been delivered, so it cannot be started again.',
	start_in_flight: 'The project is being started right now.',
	conveyor_not_configured: 'Starting again is not available for this workspace.',
	not_on_conveyor: "This project's work hasn't been set up yet, so it can't be started again.",
	on_hold: 'This project is on hold. Once it continues you can start it again.'
});

export function restartNotOfferedText(restart: ConveyorRestartOffer | null | undefined): string | null {
	if (!restart || restart.available) return null;
	return RESTART_NOT_OFFERED_TEXT[restart.reason] ?? RESTART_TEXT.notOffered;
}

/** A phase name as words ("preliminary_design" → "Preliminary design"). */
export function phaseLabel(phase: string): string {
	const words = phase.replace(/[_-]+/g, ' ').trim();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : phase;
}

/** The confirmation the member must accept: every card in scope, finished ones included, runs again. */
export function restartConfirmText(scope: ConveyorRestartScope, phase: string | null, phaseTitle?: string | null): string {
	const what = scope === 'phase' && phase ? `the "${phaseTitle?.trim() || phaseLabel(phase)}" phase` : 'the whole project';
	return (
		`Start ${what} again?\n\n` +
		`Every card in ${scope === 'phase' ? 'this phase' : 'this project'} will run again, including cards that are already finished. ` +
		"Open questions from this project's automated work, and open requests about its cards, will be withdrawn."
	);
}

/** The member's text for a failed restart (never fr's raw code). */
export function restartErrorText(err: unknown): string {
	if (err instanceof ProjectReadError) {
		if (err.code === 'conveyor_restart_not_offered') return RESTART_TEXT.notOffered;
		if (err.code === 'conveyor_start_in_progress') return RESTART_TEXT.inProgress;
		if (err.code === 'restart_phase_invalid') return RESTART_TEXT.phaseInvalid;
		if (err.code === 'restart_phase_unknown') return RESTART_TEXT.phaseUnknown;
		if (err.code === 'project_archived') return RESTART_TEXT.archived;
		if (err.code === 'rm_project_missing') return RESTART_TEXT.notSetUp;
		if (err.code === 'board_missing') return RESTART_TEXT.noBoard;
		if (err.code === 'project_tenant_unknown') return RESTART_TEXT.noWorkspace;
	}
	return RESTART_TEXT.failed;
}
