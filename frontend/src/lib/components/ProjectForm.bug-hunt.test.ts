// @vitest-environment jsdom
//
// ProjectForm — the "Hunt for bugs" checkbox is offered only where it can succeed.
// The backend (assertItExecIntakeInputs) 400s `bug_hunt_exec_only` unless the
// tenant the project is created in is EXEC. That tenant is the request's own
// tenant on /projects/requests/[id] (`ownerTenantId`); else, for a super-admin,
// the active workspace (X-Active-Tenant, persisted as `fr.active_tenant`); else
// the JWT tenant (the header is ignored for everyone else).
//
// Mount pattern as ProjectForm.rewrite-layout.test.ts (no @testing-library/svelte).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import ProjectForm, { type ProjectFormState } from './ProjectForm.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { EXECUTION_TENANT_ID } from './ProjectTypeAnalysisWarning.svelte';

const CONVEYOR = '0195f48b-d000-7000-8000-0000000000ff';
const BUG: Partial<ProjectFormState> = { project_type: 'it', it_flow: 'bug' };

function signIn(tenant_id: string, roles: string[] = []): void {
	auth.user = { id: 'u1', email: 'u@x', name: 'U', roles, tenant_id, tenant_name: null };
}
const superAdmin = (home: string) => signIn(home, ['super_admin']);

let instance: ReturnType<typeof mount> | null = null;
let target: HTMLElement | null = null;

function render(initial: Partial<ProjectFormState>, ownerTenantId?: string): HTMLElement {
	target = document.createElement('div');
	document.body.appendChild(target);
	instance = mount(ProjectForm, { target, props: { initial, ownerTenantId, onSubmit: async () => {} } });
	flushSync();
	return target;
}

afterEach(async () => {
	await vi.waitFor(() => expect(target?.querySelector('[data-testid="project-types-failed"]')).not.toBeNull());
	await new Promise((r) => setTimeout(r, 0));
	if (instance) unmount(instance);
	target?.remove();
	instance = null;
	target = null;
	localStorage.clear();
	auth.user = null;
});

const hunt = (root: HTMLElement) => root.querySelector('[data-testid="bug-hunt"]');
const huntCommand = (root: HTMLElement) => root.querySelector('[data-testid="bug-hunt-test-command"]');

describe('bug hunt checkbox', () => {
	it('is shown for a super-admin whose active workspace is EXEC', () => {
		superAdmin(CONVEYOR);
		localStorage.setItem('fr.active_tenant', EXECUTION_TENANT_ID);
		expect(hunt(render(BUG))).not.toBeNull();
	});

	it('is hidden for a super-admin switched into a non-EXEC workspace, and a preset hunt is cleared', () => {
		superAdmin(EXECUTION_TENANT_ID);
		localStorage.setItem('fr.active_tenant', CONVEYOR);
		const root = render({ ...BUG, bug_hunt: true });
		expect(hunt(root)).toBeNull();
		// Cleared, so the hunt-only command input is gone and no hunt is submitted.
		expect(huntCommand(root)).toBeNull();
	});

	it('follows the JWT tenant for a non-super-admin (their header is ignored)', () => {
		signIn(CONVEYOR);
		localStorage.setItem('fr.active_tenant', EXECUTION_TENANT_ID);
		expect(hunt(render(BUG))).toBeNull();
	});

	it('is shown for a non-super-admin whose own tenant is EXEC', () => {
		signIn(EXECUTION_TENANT_ID);
		expect(hunt(render(BUG))).not.toBeNull();
	});

	it('is hidden with no known tenant', () => {
		expect(hunt(render(BUG))).toBeNull();
	});

	it('follows ownerTenantId over the active workspace (request review)', () => {
		superAdmin(EXECUTION_TENANT_ID);
		localStorage.setItem('fr.active_tenant', EXECUTION_TENANT_ID);
		expect(hunt(render(BUG, CONVEYOR))).toBeNull();
	});

	it('is shown when ownerTenantId is EXEC, whatever the caller', () => {
		signIn(CONVEYOR);
		expect(hunt(render(BUG, EXECUTION_TENANT_ID))).not.toBeNull();
	});
});
