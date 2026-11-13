// /admin/onboarding helpers: what each row offers, its status line, the step table, the invite check.
import { describe, expect, it } from 'vitest';
import { canRemove, inviteFormError, removalRows, rowAction, statusLabel, stepRows } from './page-helpers';

const base = { status: 'pending' as const, email_state: 'waiting' as const, reject_repair: null, approving: false, removal: null };

describe('rowAction / statusLabel', () => {
	it('pending → decide; while an approve holds the claim → nothing', () => {
		expect(rowAction(base)).toBe('decide');
		expect(rowAction({ ...base, approving: true })).toBe('none');
		expect(statusLabel({ ...base, approving: true })).toBe('Being approved…');
	});
	it('approved with the email waiting → retry the steps; sent → nothing', () => {
		expect(rowAction({ ...base, status: 'approved' })).toBe('retry_steps');
		expect(statusLabel({ ...base, status: 'approved' })).toBe('Approved — email waiting');
		expect(rowAction({ ...base, status: 'approved', email_state: 'sent' })).toBe('none');
	});
	it('rejected: a pending cleanup can be retried, a failed / blocked one also closed by hand', () => {
		const rr = (state: 'pending' | 'failed' | 'blocked' | 'done') => ({
			state,
			attempts: 1,
			next_attempt_at: null,
			last_error: null,
			blockers: [],
			undid: [],
			note: null
		});
		expect(rowAction({ ...base, status: 'rejected', reject_repair: rr('pending') })).toBe('retry_cleanup');
		expect(rowAction({ ...base, status: 'rejected', reject_repair: rr('failed') })).toBe('resolve_cleanup');
		expect(rowAction({ ...base, status: 'rejected', reject_repair: rr('blocked') })).toBe('resolve_cleanup');
		expect(rowAction({ ...base, status: 'rejected', reject_repair: rr('done') })).toBe('none');
		expect(statusLabel({ ...base, status: 'rejected', reject_repair: rr('failed') })).toBe('Rejected — cleanup failed');
	});
});

describe('removal', () => {
	const rm = (state: 'pending' | 'failed' | 'blocked' | 'done' | 'resolved_manually') => ({
		state,
		tenant_id: 't',
		tenant_slug: 'acme',
		requested_by: 'g',
		requested_at: 'x',
		attempts: 1,
		last_attempt_at: null,
		last_error: null,
		blockers: [],
		steps: { provisioning: { status: 'ok' as const, at: 'x' }, licences: { status: 'failed' as const, at: 'x', code: 'licence_revoke_failed', error: '1 of 3' } },
		note: null
	});
	it('only an approved row with a workspace can be removed', () => {
		expect(canRemove({ status: 'approved', tenant_slug: 'acme' })).toBe(true);
		expect(canRemove({ status: 'approved', tenant_slug: null })).toBe(false);
		expect(canRemove({ status: 'removed', tenant_slug: 'acme' })).toBe(false);
	});
	it('a pending / failed / blocked removal offers Retry; done / closed offers nothing', () => {
		expect(rowAction({ ...base, status: 'removed', removal: rm('failed') })).toBe('retry_removal');
		expect(rowAction({ ...base, status: 'removed', removal: rm('blocked') })).toBe('retry_removal');
		expect(rowAction({ ...base, status: 'removed', removal: rm('done') })).toBe('none');
		expect(statusLabel({ ...base, status: 'removed', removal: rm('done') })).toBe('Removed');
		expect(statusLabel({ ...base, status: 'removed', removal: rm('failed') })).toBe('Removal failed');
	});
	it('lists every removal step in run order', () => {
		const rows = removalRows({ removal: rm('failed') });
		expect(rows.map((r) => r.step)).toEqual(['provisioning', 'licences', 'licences_tenant', 'workspace', 'grants', 'identity', 'finalize']);
		expect(rows[1]).toMatchObject({ status: 'failed', detail: 'licence_revoke_failed — 1 of 3' });
		expect(rows[2]!.status).toBe('pending');
		expect(removalRows({ removal: null })).toEqual([]);
	});
});

describe('stepRows', () => {
	it('lists every step in run order; a step that has not run is pending', () => {
		const rows = stepRows({ steps: { identity: { status: 'ok', at: 'x' }, bundle: { status: 'failed', at: 'x', code: 'bundle_failed_503', error: 'busy' } } });
		expect(rows.map((r) => r.step)).toEqual(['identity', 'provision', 'workspace', 'budget', 'catalogue', 'bundle', 'invite_email']);
		expect(rows[0]!.status).toBe('ok');
		expect(rows[1]!.status).toBe('pending');
		expect(rows[5]).toMatchObject({ status: 'failed', detail: 'bundle_failed_503 — busy' });
	});
});

describe('inviteFormError', () => {
	it('refuses a bad email, a missing name and a one-letter workspace name', () => {
		expect(inviteFormError({ email: 'nope', name: 'A' })).toMatch(/email/);
		expect(inviteFormError({ email: 'a@b.example', name: '  ' })).toMatch(/name/);
		expect(inviteFormError({ email: 'a@b.example', name: 'A', tenantName: 'x' })).toMatch(/2–120/);
		expect(inviteFormError({ email: 'a@b.example', name: 'A', tenantName: '', locale: 'de' })).toBeNull();
	});
});
