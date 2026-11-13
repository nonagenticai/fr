// George 2026-10-31 — the restart copy: the confirmation says every card in scope runs again,
// finished ones included; refusals map to member text, never a raw code.
import { describe, expect, it } from 'vitest';

import { ProjectReadError } from '$lib/api/project-execution';
import {
	RESTART_TEXT,
	phaseLabel,
	restartConfirmText,
	restartErrorText,
	restartNotOfferedText
} from './start-again';

describe('restart copy', () => {
	it('the confirmation names the scope and says finished cards run again', () => {
		const project = restartConfirmText('project', 'execution');
		expect(project).toContain('the whole project');
		expect(project).toContain('including cards that are already finished');
		expect(project).toContain('open requests about its cards, will be withdrawn');
		const phase = restartConfirmText('phase', 'preliminary_design');
		expect(phase).toContain('the "Preliminary design" phase');
		expect(phase).toContain('Every card in this phase will run again, including cards that are already finished');
		// The phase's title, when the offer carries one, is what the member reads.
		expect(restartConfirmText('phase', 'preliminary', 'Preliminary phase')).toContain('the "Preliminary phase" phase');
		// A phase restart without a known phase reads as the whole project.
		expect(restartConfirmText('phase', null)).toContain('the whole project');
	});

	it('phaseLabel turns a phase name into words', () => {
		expect(phaseLabel('setup')).toBe('Setup');
		expect(phaseLabel('preliminary_design')).toBe('Preliminary design');
	});

	it('refusals map to member text', () => {
		expect(restartErrorText(new ProjectReadError(409, 'conveyor_restart_not_offered', 'x'))).toBe(RESTART_TEXT.notOffered);
		expect(restartErrorText(new ProjectReadError(409, 'restart_phase_invalid', 'x'))).toBe(RESTART_TEXT.phaseInvalid);
		expect(restartErrorText(new ProjectReadError(409, 'restart_phase_unknown', 'x'))).toBe(RESTART_TEXT.phaseUnknown);
		expect(restartErrorText(new ProjectReadError(409, 'conveyor_start_in_progress', 'x'))).toBe(RESTART_TEXT.inProgress);
		expect(restartErrorText(new ProjectReadError(409, 'project_archived', 'x'))).toBe(RESTART_TEXT.archived);
		expect(restartErrorText(new ProjectReadError(409, 'rm_project_missing', 'x'))).toBe(RESTART_TEXT.notSetUp);
		expect(restartErrorText(new ProjectReadError(409, 'board_missing', 'x'))).toBe(RESTART_TEXT.noBoard);
		expect(restartErrorText(new ProjectReadError(409, 'project_tenant_unknown', 'x'))).toBe(RESTART_TEXT.noWorkspace);
		expect(restartErrorText(new Error('boom'))).toBe(RESTART_TEXT.failed);
		// Customer copy: no internal system names in any restart text.
		for (const t of Object.values(RESTART_TEXT)) expect(t).not.toMatch(/conveyor|planka|requirements|tenant|rm_|n8n/i);
	});

	it('the not-offered line: none when offered, member text per reason otherwise', () => {
		expect(restartNotOfferedText({ available: true, phase: 'setup', phases: [], next_attempt_n: 1, next_idempotency_key: 'k' })).toBeNull();
		expect(restartNotOfferedText(null)).toBeNull();
		expect(restartNotOfferedText({ available: false, reason: 'delivered', phase: null, phases: [] })).toContain('delivered');
		expect(restartNotOfferedText({ available: false, reason: 'not_active', phase: null, phases: [] })).toContain('active project');
		expect(restartNotOfferedText({ available: false, reason: 'on_hold', phase: null, phases: [] })).toContain('on hold');
	});
});
