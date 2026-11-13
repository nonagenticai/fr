// @vitest-environment jsdom
//
// OutlinePanel.test.ts — the outline half of the two-stage project request.
// Mounted, not snapshot: what a reviewer can actually SEE and CLICK.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';

import OutlinePanel from './OutlinePanel.svelte';
import type { Outline } from './types';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

async function mountIt(outlines: Outline[]) {
	app = mount(OutlinePanel, { target: host, props: { outlines } });
	await tick();
	flushSync();
}

function outline(over: Partial<Outline> = {}): Outline {
	return {
		id: 'o-1',
		version: 1,
		status: 'proposed',
		summary: 'Build the API',
		deliverables: [
			{
				kind: 'code_change',
				title: 'REST API',
				description: 'CRUD endpoints',
				acceptance_criteria: ['GET /items returns 200']
			}
		],
		intermediate_deliverables: [{ kind: 'document', title: 'Schema draft', acceptance_criteria: [] }],
		milestones: [{ name: 'Alpha', target_date: '2026-10-01' }],
		effort_estimate: { value: 3, unit: 'weeks' },
		cost_estimate: null,
		approval_id: 'appr-123',
		proposed_at: '2026-09-20T10:00:00Z',
		decided_at: null,
		decision_note: null,
		...over
	};
}

describe('OutlinePanel', () => {
	it('shows the empty state when there is no outline', async () => {
		await mountIt([]);
		expect(host.querySelector('[data-testid="outline-empty"]')?.textContent).toBe('No outline yet.');
		expect(host.querySelector('[data-testid="decide-outline"]')).toBeNull();
	});

	it('renders the proposed outline with its deliverables and the decide link', async () => {
		await mountIt([outline()]);
		const current = host.querySelector('[data-testid="outline-current"]')!;
		expect(current).not.toBeNull();
		expect(current.textContent).toContain('Build the API');
		expect(host.querySelector('[data-testid="outline-deliverables"]')?.textContent).toContain('REST API');
		expect(host.querySelector('[data-testid="outline-deliverables"]')?.textContent).toContain('[code_change]');
		expect(host.querySelector('[data-testid="deliverable-acceptance"]')?.textContent).toContain(
			'GET /items returns 200'
		);
		expect(host.querySelector('[data-testid="outline-intermediate"]')?.textContent).toContain('Schema draft');
		expect(host.querySelector('[data-testid="outline-milestones"]')?.textContent).toContain('Alpha');
		expect(host.querySelector('[data-testid="outline-effort"]')?.textContent).toContain('3 weeks');
		const link = host.querySelector<HTMLAnchorElement>('[data-testid="decide-outline"]')!;
		expect(link.textContent).toContain('Decide this outline');
		expect(link.getAttribute('href')).toBe('/approvals/appr-123');
	});

	it('a proposed outline whose approval is still pending keeps the decide link', async () => {
		await mountIt([outline({ approval_status: 'pending' })]);
		expect(host.querySelector('[data-testid="decide-outline"]')?.getAttribute('href')).toBe(
			'/approvals/appr-123'
		);
		expect(host.querySelector('[data-testid="outline-approval-closed"]')).toBeNull();
	});

	it.each([
		['voided', /withdrawn — resubmit to decide/],
		['withdrawn', /withdrawn — resubmit to decide/],
		['rejected', /rejected — resubmit to decide/],
		['expired', /expired unanswered — resubmit to decide/]
	])('a %s linked approval shows the state instead of "Decide this outline"', async (status, text) => {
		await mountIt([outline({ approval_status: status })]);
		expect(host.querySelector('[data-testid="decide-outline"]')).toBeNull();
		expect(host.textContent).not.toContain('Decide this outline');
		expect(host.querySelector('[data-testid="outline-approval-closed"]')?.textContent).toMatch(text);
	});

	it('labels the cost estimate as not tracked spend', async () => {
		await mountIt([outline({ cost_estimate: { currency: 'EUR', amount: 12000, basis: 'rate card' } })]);
		const cost = host.querySelector('[data-testid="outline-cost"]')!;
		expect(cost).not.toBeNull();
		expect(cost.textContent).toContain('Estimate — not tracked spend');
		expect(cost.textContent).toContain('rate card');
	});

	it('renders superseded versions as older, below the current proposal', async () => {
		await mountIt([
			outline({ id: 'o-1', version: 1, status: 'superseded', summary: 'Old plan', approval_id: null }),
			outline({ id: 'o-2', version: 2, status: 'proposed', summary: 'New plan' })
		]);
		const current = host.querySelector('[data-testid="outline-current"]')!;
		expect(current.textContent).toContain('Version 2');
		expect(current.textContent).toContain('New plan');
		expect(current.textContent).not.toContain('Old plan');
		const older = host.querySelectorAll('[data-testid="outline-older-item"]');
		expect(older).toHaveLength(1);
		expect(older[0].tagName).toBe('DETAILS');
		expect(older[0].textContent).toContain('Version 1');
		expect(older[0].textContent).toContain('superseded');
	});
});

// fr#1484 — the outline embeds the PROPOSED plan the approval agrees to.
describe('OutlinePanel — proposed plan (fr#1484)', () => {
	it('an outline with plan_view embeds ProjectPlanView mode=proposed with the server card count', async () => {
		await mountIt([
			outline({
				plan_view: {
					template: { id: 'it.bug_hunt', hash: 'h' },
					phase_plan_hash: 'p',
					card_count_at_commit: 1,
					deliverable_count: 3,
					checks: null,
					phases: [{ phase: 'deep_analysis', label: 'Deep analysis', gate_kinds: ['ready_signoff'], deliverables: [] }]
				}
			})
		]);
		const plan = host.querySelector('[data-testid="outline-plan"] [data-testid="project-plan-view"]')!;
		expect(plan.getAttribute('data-mode')).toBe('proposed');
		expect(plan.querySelector('[data-testid="plan-checks-pending"]')).toBeTruthy();
	});

	it('a legacy outline shows no plan; a broken stored plan is SAID, not shown empty', async () => {
		await mountIt([outline({ plan_view: null })]);
		expect(host.querySelector('[data-testid="outline-plan"]')).toBeNull();
		unmount(app!);
		app = null;
		await mountIt([outline({ plan_view: null, plan_view_error: 'stored phase_plan is invalid: x' })]);
		expect(host.querySelector('[data-testid="outline-plan-error"]')!.textContent).toContain('invalid');
	});
});
