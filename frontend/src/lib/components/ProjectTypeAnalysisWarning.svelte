<script lang="ts" module>
	// Faithful mirror of the backend gate `shouldOrchestrateProjectStart`
	// (backend/src/routes/projects.ts). Keep the two in lockstep — the drift
	// between them is exactly the bug this replaced:
	//
	//   The old version hardcoded ORCHESTRATED_PROJECT_TYPES = {feature, it} and
	//   told the user to "choose feature or it below". Neither value existed in
	//   ProjectForm's project_type <select>, so the instruction was unfollowable —
	//   and the set itself had been stale since the 2026-07-07 widening, which made
	//   EVERY EXEC-tenant project orchestrate regardless of its type. Net result:
	//   a false "this won't run the analysis" warning on every project George could
	//   actually create, while orchestration was in fact firing.
	//
	// The backend has one exclusion and exactly two entries:
	//   0. `system_ops` NEVER orchestrates, on any tenant (fr#1487). This mirror
	//      missed that clause until fr#1476, so it would have claimed a SYSTEM-ops
	//      project runs the analysis on EXEC — the same drift in a new direction.
	//   1. an `it` project with cve_sweep=true, on ANY tenant (customer self-serve
	//      CVE-sweep readiness);
	//   2. EVERY project on the EXEC tenant (the internal AA pipeline) — any
	//      project_type of the tenant's catalogue (requirements_management),
	//      including undefined.
	export const EXECUTION_TENANT_ID = '0195f48b-d000-7000-8000-000000000003';

	export interface OrchestrationParams {
		projectType?: string | null;
		cveSweep?: boolean | null;
		tenantId?: string | null;
	}

	/** Mirrors backend shouldOrchestrateProjectStart exactly. */
	export function orchestratesProjectStart(params: OrchestrationParams): boolean {
		const { projectType, cveSweep, tenantId } = params;
		if ((projectType ?? '').trim() === 'system_ops') return false;
		if ((projectType ?? '').trim() === 'it' && cveSweep === true) return true;
		return (tenantId ?? '') === EXECUTION_TENANT_ID;
	}

	/**
	 * True when we can affirmatively say the start-request analysis will NOT run.
	 *
	 * We only warn when the tenant is KNOWN — with no tenant we cannot evaluate the
	 * gate, and a warning we can't stand behind is worse than none (that is how the
	 * previous version misled).
	 */
	export function warnsAnalysisSkipped(params: OrchestrationParams): boolean {
		if (!(params.tenantId ?? '').trim()) return false;
		return !orchestratesProjectStart(params);
	}
</script>

<script lang="ts">
	import { auth } from '$lib/stores/auth.svelte';

	let {
		projectType,
		cveSweep = false
	}: {
		projectType?: string | null;
		cveSweep?: boolean | null;
	} = $props();

	const effectiveTenantId = $derived(auth.user?.tenant_id ?? '');
	const show = $derived(
		warnsAnalysisSkipped({ projectType, cveSweep, tenantId: effectiveTenantId })
	);
</script>

{#if show}
	<div
		class="rounded-[var(--radius-md)] border border-[var(--color-warning,#b7791f)] bg-[var(--color-warning-subtle,transparent)] px-4 py-3 text-sm text-[var(--color-warning,#b7791f)]"
		role="status"
		data-testid="analysis-warning"
	>
		{#if (projectType ?? '').trim() === 'system_ops'}
			A <strong>system operations</strong> project never runs the start-request analysis
			(IO-Map) — it records attribution only.
		{:else}
			This project will not run the start-request analysis (IO-Map). On this workspace the
			analysis runs only for an <strong>IT remediation</strong> project with
			<strong>CVE sweep</strong> enabled.
		{/if}
	</div>
{/if}
