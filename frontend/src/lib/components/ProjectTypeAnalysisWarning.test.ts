// @vitest-environment jsdom
//
// ProjectTypeAnalysisWarning — the banner that warns when a project will NOT fire
// the *_start_request_analysis card.
//
// This component previously hardcoded ORCHESTRATED_PROJECT_TYPES = {feature, it}
// and told the user to "choose feature or it below" — but neither value existed in
// ProjectForm's project_type <select>, and the set had been stale since the
// 2026-07-07 widening that made EVERY EXEC-tenant project orchestrate. So it warned
// on every project that could actually be created, while orchestration was in fact
// firing. It was wrong in both directions.
//
// ORCHESTRATION_MATRIX below is the SAME table asserted against the real backend
// gate in backend/tests/unit/routes/project-orchestration-gate.test.ts. Keep the two
// in lockstep: if either implementation drifts from the rule, its own suite fails.
// Backend authority: backend/src/routes/projects.ts `shouldOrchestrateProjectStart`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Warning, {
	warnsAnalysisSkipped,
	orchestratesProjectStart,
	EXECUTION_TENANT_ID
} from './ProjectTypeAnalysisWarning.svelte';

const EXEC = EXECUTION_TENANT_ID;
const CUSTOMER = '0195f48b-d000-7000-8000-0000000000ff';

/** [projectType, cveSweep, tenantId, orchestrates?] */
export const ORCHESTRATION_MATRIX: Array<
	[string | undefined, boolean | undefined, string, boolean]
> = [
	// Exclusion — system_ops NEVER orchestrates, on any tenant (fr#1487).
	['system_ops', false, EXEC, false],
	['system_ops', true, EXEC, false],
	['system_ops', true, CUSTOMER, false],

	// Entry 2 — EVERY project on the EXEC tenant orchestrates, any project_type
	// of the closed vocabulary (fr#1476).
	['feature', false, EXEC, true],
	['it', false, EXEC, true],
	['program', false, EXEC, true],
	[undefined, false, EXEC, true],
	['it', true, EXEC, true],

	// Entry 1 — an `it` project with cve_sweep=true orchestrates on ANY tenant.
	['it', true, CUSTOMER, true],

	// Everything else on a non-EXEC tenant does NOT orchestrate.
	['it', false, CUSTOMER, false],
	['feature', false, CUSTOMER, false],
	['program', false, CUSTOMER, false],
	[undefined, false, CUSTOMER, false],
	['feature', true, CUSTOMER, false] // cve_sweep only counts for `it`
];

describe('orchestratesProjectStart — parity with the backend gate', () => {
	for (const [projectType, cveSweep, tenantId, expected] of ORCHESTRATION_MATRIX) {
		const tenant = tenantId === EXEC ? 'EXEC' : 'customer';
		it(`${String(projectType)} + cve_sweep=${String(cveSweep)} on ${tenant} → ${expected}`, () => {
			expect(orchestratesProjectStart({ projectType, cveSweep, tenantId })).toBe(expected);
		});
	}
});

describe('warnsAnalysisSkipped', () => {
	it('warns for system_ops even on EXEC — it never orchestrates (fr#1487 parity)', () => {
		expect(warnsAnalysisSkipped({ projectType: 'system_ops', tenantId: EXEC })).toBe(true);
	});

	it('never warns on the EXEC tenant — every other project there orchestrates', () => {
		for (const t of ['feature', 'it', 'program', '', undefined]) {
			expect(warnsAnalysisSkipped({ projectType: t, tenantId: EXEC })).toBe(false);
		}
	});

	it('warns on a customer tenant unless it is an it+cve_sweep project', () => {
		expect(warnsAnalysisSkipped({ projectType: 'program', tenantId: CUSTOMER })).toBe(true);
		expect(warnsAnalysisSkipped({ projectType: 'it', tenantId: CUSTOMER })).toBe(true);
		expect(
			warnsAnalysisSkipped({ projectType: 'it', cveSweep: true, tenantId: CUSTOMER })
		).toBe(false);
	});

	it('does NOT warn when the tenant is unknown — a warning we cannot stand behind misleads', () => {
		expect(warnsAnalysisSkipped({ projectType: 'program', tenantId: '' })).toBe(false);
		expect(warnsAnalysisSkipped({ projectType: 'program', tenantId: undefined })).toBe(false);
		expect(warnsAnalysisSkipped({ projectType: 'program', tenantId: '  ' })).toBe(false);
	});
});

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) {
		unmount(app);
		app = null;
	}
	host.remove();
});

// The banner reads the signed-in user's tenant (no injection seam). With no
// session the tenant is unknown, and an unknown tenant never warns. The
// tenant-dependent decisions are pinned on `warnsAnalysisSkipped` above.
describe('ProjectTypeAnalysisWarning render', () => {
	it('renders nothing when there is no signed-in tenant', () => {
		app = mount(Warning, { target: host, props: { projectType: 'program' } });
		flushSync();
		expect(host.querySelector('[data-testid="analysis-warning"]')).toBeNull();
	});
});
