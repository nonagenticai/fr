// @vitest-environment jsdom
//
// ExecutionToolResult.test.ts — fr-agui SPEC §5.3 / §13 P3: the inline
// rendering of the project agent's execution reads. It renders the READ (the
// state the agent answered from), redacted; a body for another project than the
// thread's is not rendered at all.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import ExecutionToolResult from './ExecutionToolResult.svelte';

const P = '0195f48b-d000-7000-8000-0000000e5b01';
const Q = '0195f48b-d000-7000-8000-0000000e5b02';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;
function render(action: string, output: unknown, projectId: string | null = P): HTMLElement {
	app = mount(ExecutionToolResult, { target: host, props: { action, output, projectId } });
	flushSync();
	return host;
}
beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

const blocked = (pid: string, reason: string | null) => ({
	data: {
		project_id: pid,
		available: true,
		cards: [{ id: 'c-1', name: 'Fix login timeout', block_reason: reason, escalation: { description: 'Decide the fix', approval_id: 'a-1', url: '/x' }, url: `/projects/${pid}/cards/c-1` }]
	}
});

describe('ExecutionToolResult', () => {
	it('blocked cards: the card, its stored reason and its escalation', () => {
		const el = render('projects.list_blocked_cards', blocked(P, 'tests fail on the login form'));
		const rows = el.querySelectorAll('[data-testid="agent-exec-row"]');
		expect(rows).toHaveLength(1);
		expect(rows[0]!.textContent).toContain('Fix login timeout');
		expect(rows[0]!.textContent).toContain('tests fail on the login form');
		expect(rows[0]!.textContent).toContain('escalation: Decide the fix');
	});

	it('a null reason says none was recorded (never invented)', () => {
		const el = render('projects.list_blocked_cards', blocked(P, null));
		expect(el.querySelector('[data-testid="agent-exec-row"]')!.textContent).toContain('no reason recorded');
	});

	it("another project's body is not rendered", () => {
		const el = render('projects.list_blocked_cards', blocked(Q, 'x'));
		expect(el.querySelector('[data-testid="agent-exec-result"]')).toBeNull();
	});

	it('secret-shaped text is redacted', () => {
		const el = render('projects.list_blocked_cards', blocked(P, 'log has password=aaaa1111'));
		expect(el.textContent).toContain('password=«redacted»');
		expect(el.textContent).not.toContain('aaaa1111');
	});

	it("WIP: the board count carries its label; conveyor runs say they are unavailable", () => {
		let el = render('projects.get_wip', {
			data: { project_id: P, limit: { available: true, effective_wip_limit: 3, label: "this project's own WIP limit" }, board_count: { available: true, doing: 2, label: "board count (Planka), not n8n's enforced count" }, headroom: 1, enforced_by: 'n8n' }
		});
		expect(el.textContent).toContain("not n8n's enforced count");
		expect(el.textContent).toContain('headroom 1');
		unmount(app!);
		app = null;
		el = render('projects.list_conveyor_executions', { data: { project_id: P, available: false, reason: 'conveyor_runs_untagged' } });
		expect(el.querySelector('[data-testid="agent-exec-note"]')!.textContent).toBe('not available (conveyor_runs_untagged)');
	});
});
