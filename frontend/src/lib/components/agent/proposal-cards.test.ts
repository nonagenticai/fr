// proposal-cards.test.ts — fr-agui SPEC §5.2 / §5.6 / §6.0 pure helpers.
import { describe, expect, it } from 'vitest';
import {
	isFullApprovalId,
	isProjectRequestAction,
	proposalToFormInitial,
	requestCardBody,
	requestCardCanConfirm,
	requestCardInitialValues,
	requestCardResultLink,
	verbatimErrorText
} from './proposal-cards';
import { isDoorwayPath } from '$lib/agent/doorway';

describe('proposalToFormInitial', () => {
	it('maps title → name and never carries a secret', () => {
		expect(
			proposalToFormInitial({ title: 'T', project_type: 'it', description: 'd', github_access_token: 'ghp_x' })
		).toEqual({ name: 'T', project_type: 'it', description: 'd' });
	});
	it('carries the problem statement and desired outcome the agent drafted', () => {
		expect(proposalToFormInitial({ title: 'T', problem_statement: 'p', desired_outcome: 'o' })).toEqual({
			name: 'T',
			problem_statement: 'p',
			desired_outcome: 'o'
		});
	});
	it('a repository url becomes the primary repository row', () => {
		expect(proposalToFormInitial({ title: 'T', repository_url: 'https://github.com/a/b' }).repositories).toEqual([
			{ url: 'https://github.com/a/b', branch: '', name: '', is_primary: true }
		]);
	});
	it('carries a valid approval_mode; an unknown one is dropped so the form default applies', () => {
		expect(proposalToFormInitial({ title: 'T', approval_mode: 'all' }).approval_mode).toBe('all');
		expect('approval_mode' in proposalToFormInitial({ title: 'T', approval_mode: 'never' })).toBe(false);
	});
});

describe('verbatimErrorText (SPEC §5.6: refusals arrive verbatim)', () => {
	it('503 conveyor_not_configured', () => {
		expect(verbatimErrorText({ status: 503, data: { error: 'conveyor_not_configured', code: 'conveyor_not_configured' } })).toBe(
			'conveyor_not_configured'
		);
	});
	it('422 with the allowed list', () => {
		expect(
			verbatimErrorText({ status: 422, data: { error: 'project_type_not_startable', message: 'nope', allowed: ['it', 'feature'] } })
		).toBe('project_type_not_startable: nope (allowed: it, feature)');
	});
	it('no body falls back to the status, never to an empty string', () => {
		expect(verbatimErrorText({ status: 403, message: '' })).toBe('http_403');
		expect(verbatimErrorText(undefined)).toBe('The request failed');
	});
});

describe('isFullApprovalId', () => {
	it('only a full UUID is loadable', () => {
		expect(isFullApprovalId('1a2b3c4d-0000-4000-8000-00000000abcd')).toBe(true);
		expect(isFullApprovalId('1a2b3c4d')).toBe(false);
	});
});

describe('isDoorwayPath (SPEC §6.0)', () => {
	it('the four doorway pages', () => {
		for (const p of ['/projects/new', '/projects/intake', '/projects/requests', '/projects/requests/abc', '/projects/new/']) {
			expect(isDoorwayPath(p)).toBe(true);
		}
	});
	it('nothing else — not the project list, not a project, not a tenant page', () => {
		for (const p of ['/projects', '/projects/123', '/projects/123/brief', '/approvals', '/', '/projects/requests/a/b']) {
			expect(isDoorwayPath(p)).toBe(false);
		}
	});
});

describe('project-request card helpers (fr-agui SPEC §6.0, P1b)', () => {
	it('the body is the edited string fields, blanks dropped; the path id is never a field', () => {
		expect(requestCardBody('project_requests.patch', { name: ' New ', description: '', id: 'x' } as never)).toEqual({ name: 'New' });
		expect(requestCardInitialValues('project_requests.draft_from_text', { text: 'T', name: 3 })).toEqual({ name: '', text: 'T' });
		expect(requestCardBody('project_requests.submit', { text: 'ignored' })).toEqual({});
	});

	it('required fields gate Confirm', () => {
		expect(requestCardCanConfirm('project_requests.reject', { reason: '  ' })).toBe(false);
		expect(requestCardCanConfirm('project_requests.reject', { reason: 'no' })).toBe(true);
		expect(requestCardCanConfirm('project_requests.approve', {})).toBe(true);
	});

	it('an approve leads INTO the project shell; a response without a project leads nowhere', () => {
		expect(requestCardResultLink('project_requests.approve', 'r', { project: { id: 'p1' } })?.href).toBe('/projects/p1');
		expect(requestCardResultLink('project_requests.approve', 'r', { id: 'r' })).toBeNull();
		expect(requestCardResultLink('project_requests.draft_from_text', null, { project_request_id: 'r2' })?.href).toBe('/projects/requests/r2');
		expect(requestCardResultLink('project_requests.submit', 'r3', {})?.href).toBe('/projects/requests/r3');
	});

	it('the bridge intake is not a card action', () => {
		expect(isProjectRequestAction('project_requests.create')).toBe(false);
		expect(isProjectRequestAction('project_requests.approve')).toBe(true);
	});
});
