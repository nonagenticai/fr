<script lang="ts">
	// Structured editor for a project request's constraints, dependencies and risks.
	//
	// ⚠️ HONESTY RULE: every constraint shows which kind of promise it is.
	// Typed kinds are "Checkable rule" (a diff COULD be checked against them —
	// nothing checks them yet, so never say "enforced"). `custom` is passed to
	// the agent verbatim and checked by nothing, and the badge says exactly that.
	import {
		CONSTRAINT_KINDS,
		CUSTOM_CONSTRAINT_MAX,
		DEPENDENCY_KINDS,
		describeConstraint,
		isMachineCheckable,
		MACHINE_CHECKABLE_CONSTRAINT_KINDS,
		type ProjectConstraint,
		type ProjectConstraintKind,
		type ProjectDependency,
		type ProjectDependencyKind,
		type ProjectRisk
	} from '$lib/types/project-constraints';

	interface Props {
		constraints?: ProjectConstraint[];
		dependencies?: ProjectDependency[];
		risks?: ProjectRisk[];
	}

	let {
		constraints = $bindable([]),
		dependencies = $bindable([]),
		risks = $bindable([])
	}: Props = $props();

	const inputClass =
		'w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]';
	const labelClass =
		'block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]';
	const addBtnClass =
		'px-4 py-2 bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors';

	// ── Constraints ──────────────────────────────────────────────────────────
	let kind = $state<ProjectConstraintKind>('no_language_version_change');
	let language = $state('');
	let version = $state('');
	let globsText = $state('');
	let customText = $state('');
	let constraintError = $state<string | null>(null);

	const selectedIsCustom = $derived(kind === 'custom');
	// Same list the badge uses — must_keep_api_compatible is guidance, not checkable.
	const selectedIsCheckable = $derived(
		(MACHINE_CHECKABLE_CONSTRAINT_KINDS as readonly string[]).includes(kind)
	);

	// The backend gate fails closed for these: an unreadable dependency or
	// language-version file blocks. Installs in Dockerfiles / CI steps are out of scope.
	const selectedIsFailClosedRule = $derived(
		kind === 'no_new_dependencies' ||
			kind === 'no_dependency_upgrades' ||
			kind === 'no_language_version_change' ||
			kind === 'pin_language_version'
	);

	function buildConstraint(): ProjectConstraint | string {
		switch (kind) {
			case 'pin_language_version': {
				const l = language.trim();
				const v = version.trim();
				if (!l || !v) return 'Pinning needs both a language and a version.';
				return { kind, language: l, version: v };
			}
			case 'no_files_touched': {
				const globs = globsText
					.split(',')
					.map((g) => g.trim())
					.filter((g) => g !== '');
				if (globs.length === 0) return 'Name at least one path or glob.';
				return { kind, globs };
			}
			case 'custom': {
				const t = customText.trim();
				if (!t) return 'A custom rule needs text.';
				if (t.length > CUSTOM_CONSTRAINT_MAX)
					return `A custom rule may be at most ${CUSTOM_CONSTRAINT_MAX} characters.`;
				return { kind, text: t };
			}
			default:
				return { kind } as ProjectConstraint;
		}
	}

	function addConstraint() {
		const built = buildConstraint();
		if (typeof built === 'string') {
			constraintError = built;
			return;
		}
		constraintError = null;
		constraints = [...constraints, built];
		language = '';
		version = '';
		globsText = '';
		customText = '';
	}

	function removeConstraint(i: number) {
		constraints = constraints.filter((_, j) => j !== i);
	}

	// ── Dependencies ─────────────────────────────────────────────────────────
	let depName = $state('');
	let depKind = $state<ProjectDependencyKind>('service');
	let depNote = $state('');
	let dependencyError = $state<string | null>(null);

	function addDependency() {
		const name = depName.trim();
		if (!name) {
			dependencyError = 'A dependency needs a name.';
			return;
		}
		dependencyError = null;
		const note = depNote.trim();
		dependencies = [...dependencies, note ? { name, kind: depKind, note } : { name, kind: depKind }];
		depName = '';
		depNote = '';
	}

	function removeDependency(i: number) {
		dependencies = dependencies.filter((_, j) => j !== i);
	}

	// ── Risks ────────────────────────────────────────────────────────────────
	let riskDescription = $state('');
	let riskLikelihood = $state('');
	let riskImpact = $state('');
	let riskMitigation = $state('');
	let riskError = $state<string | null>(null);

	function addRisk() {
		const description = riskDescription.trim();
		if (!description) {
			riskError = 'A risk needs a description.';
			return;
		}
		riskError = null;
		const r: ProjectRisk = { description };
		if (riskLikelihood.trim()) r.likelihood = riskLikelihood.trim();
		if (riskImpact.trim()) r.impact = riskImpact.trim();
		if (riskMitigation.trim()) r.mitigation = riskMitigation.trim();
		risks = [...risks, r];
		riskDescription = '';
		riskLikelihood = '';
		riskImpact = '';
		riskMitigation = '';
	}

	function removeRisk(i: number) {
		risks = risks.filter((_, j) => j !== i);
	}
</script>

<div class="space-y-6">
	<!-- Constraints -->
	<section class="space-y-3" data-testid="constraints-section">
		<h3 class="text-sm font-semibold text-[var(--color-text)]">Constraints</h3>
		<p class="text-xs text-[var(--color-text-muted)]">
			Constraints are delivered to the agent. <strong>Checkable rules</strong> could be checked against the
			change; <strong>custom</strong> rules are passed along as guidance only and nothing checks them.
		</p>

		<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
			<div>
				<label for="constraint_kind" class={labelClass}>Rule</label>
				<select id="constraint_kind" data-testid="constraint-kind" bind:value={kind} class={inputClass}>
					{#each CONSTRAINT_KINDS as k (k.kind)}
						<option value={k.kind}>{k.label}</option>
					{/each}
				</select>
			</div>

			{#if kind === 'pin_language_version'}
				<div class="grid grid-cols-2 gap-2">
					<div>
						<label for="constraint_language" class={labelClass}>Language</label>
						<input id="constraint_language" data-testid="constraint-language" type="text" bind:value={language} class={inputClass} placeholder="python" />
					</div>
					<div>
						<label for="constraint_version" class={labelClass}>Version</label>
						<input id="constraint_version" data-testid="constraint-version" type="text" bind:value={version} class={inputClass} placeholder="3.12" />
					</div>
				</div>
			{:else if kind === 'no_files_touched'}
				<div>
					<label for="constraint_globs" class={labelClass}>Paths / globs (comma-separated)</label>
					<input id="constraint_globs" data-testid="constraint-globs" type="text" bind:value={globsText} class={inputClass} placeholder="migrations/**, src/legacy/*.py" />
				</div>
			{/if}
		</div>

		{#if kind === 'custom'}
			<div>
				<label for="constraint_custom" class={labelClass}>Custom rule</label>
				<textarea id="constraint_custom" data-testid="constraint-custom" bind:value={customText} rows="3" maxlength={CUSTOM_CONSTRAINT_MAX} class={inputClass} placeholder="Describe the rule in plain language"></textarea>
			</div>
		{/if}

		<p class="text-xs text-[var(--color-text-muted)]" data-testid="constraint-kind-hint">
			{#if selectedIsCustom}
				Passed to the agent as guidance — not enforced. Nothing checks a custom rule.
			{:else if !selectedIsCheckable}
				Passed to the agent as guidance — not enforced. No automated check can prove this rule.
			{:else if selectedIsFailClosedRule}
				Checked before merge. A dependency or language-version change we cannot read blocks the merge; installs inside Dockerfiles or CI steps are not checked.
			{:else}
				Checked before merge. A pull request that breaks this rule is not merged.
			{/if}
		</p>

		<div class="flex items-center gap-3">
			<button type="button" data-testid="add-constraint" onclick={addConstraint} class={addBtnClass}>Add constraint</button>
			{#if constraintError}
				<span class="text-sm text-[var(--color-danger)]" data-testid="constraint-error" role="alert">{constraintError}</span>
			{/if}
		</div>

		{#if constraints.length > 0}
			<ul class="space-y-2" data-testid="constraint-list">
				{#each constraints as c, i (i)}
					<li class="flex items-start justify-between gap-3 rounded-lg border border-[var(--color-border)] p-3" data-testid="constraint-item-{i}">
						<div class="flex-1 space-y-1">
							<p class="text-sm text-[var(--color-text)] break-words" data-testid="constraint-text-{i}">{describeConstraint(c)}</p>
							{#if isMachineCheckable(c)}
								<span data-testid="constraint-badge-{i}" class="inline-block px-2 py-0.5 text-xs rounded border border-[var(--color-info-border)] bg-[var(--color-info-bg)] text-[var(--color-info-text)]">Checkable rule</span>
							{:else}
								<span data-testid="constraint-badge-{i}" title="Passed to the agent as guidance — not enforced" class="inline-block px-2 py-0.5 text-xs rounded border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]">Guidance — not enforced</span>
							{/if}
						</div>
						<button type="button" data-testid="remove-constraint-{i}" onclick={() => removeConstraint(i)} class="text-[var(--color-accent)]" aria-label="Remove constraint">&times;</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- Dependencies -->
	<section class="space-y-3" data-testid="dependencies-section">
		<h3 class="text-sm font-semibold text-[var(--color-text)]">Dependencies</h3>
		<p class="text-xs text-[var(--color-text-muted)]">Things this project must keep working with.</p>
		<div class="grid grid-cols-1 md:grid-cols-3 gap-2">
			<div>
				<label for="dependency_name" class={labelClass}>Name</label>
				<input id="dependency_name" data-testid="dependency-name" type="text" bind:value={depName} maxlength="200" class={inputClass} placeholder="billing-service" />
			</div>
			<div>
				<label for="dependency_kind" class={labelClass}>Kind</label>
				<select id="dependency_kind" data-testid="dependency-kind" bind:value={depKind} class={inputClass}>
					{#each DEPENDENCY_KINDS as k (k)}
						<option value={k}>{k}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="dependency_note" class={labelClass}>Note</label>
				<input id="dependency_note" data-testid="dependency-note" type="text" bind:value={depNote} maxlength="2000" class={inputClass} placeholder="optional" />
			</div>
		</div>
		<div class="flex items-center gap-3">
			<button type="button" data-testid="add-dependency" onclick={addDependency} class={addBtnClass}>Add dependency</button>
			{#if dependencyError}
				<span class="text-sm text-[var(--color-danger)]" data-testid="dependency-error" role="alert">{dependencyError}</span>
			{/if}
		</div>
		{#if dependencies.length > 0}
			<ul class="flex flex-wrap gap-2" data-testid="dependency-list">
				{#each dependencies as d, i (i)}
					<li class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-[var(--color-surface)] text-[var(--color-text)]" data-testid="dependency-item-{i}">
						<span>{d.name} ({d.kind}){d.note ? ` — ${d.note}` : ''}</span>
						<button type="button" data-testid="remove-dependency-{i}" onclick={() => removeDependency(i)} class="text-[var(--color-accent)]" aria-label="Remove {d.name}">&times;</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- Risks -->
	<section class="space-y-3" data-testid="risks-section">
		<h3 class="text-sm font-semibold text-[var(--color-text)]">Risks</h3>
		<div>
			<label for="risk_description" class={labelClass}>Description <span class="text-[var(--color-danger)]">*</span></label>
			<input id="risk_description" data-testid="risk-description" type="text" bind:value={riskDescription} class={inputClass} placeholder="What could go wrong" />
		</div>
		<div class="grid grid-cols-1 md:grid-cols-3 gap-2">
			<div>
				<label for="risk_likelihood" class={labelClass}>Likelihood</label>
				<input id="risk_likelihood" data-testid="risk-likelihood" type="text" bind:value={riskLikelihood} class={inputClass} placeholder="low / medium / high" />
			</div>
			<div>
				<label for="risk_impact" class={labelClass}>Impact</label>
				<input id="risk_impact" data-testid="risk-impact" type="text" bind:value={riskImpact} class={inputClass} placeholder="low / medium / high" />
			</div>
			<div>
				<label for="risk_mitigation" class={labelClass}>Mitigation</label>
				<input id="risk_mitigation" data-testid="risk-mitigation" type="text" bind:value={riskMitigation} class={inputClass} placeholder="optional" />
			</div>
		</div>
		<div class="flex items-center gap-3">
			<button type="button" data-testid="add-risk" onclick={addRisk} class={addBtnClass}>Add risk</button>
			{#if riskError}
				<span class="text-sm text-[var(--color-danger)]" data-testid="risk-error" role="alert">{riskError}</span>
			{/if}
		</div>
		{#if risks.length > 0}
			<ul class="space-y-2" data-testid="risk-list">
				{#each risks as r, i (i)}
					<li class="flex items-start justify-between gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm text-[var(--color-text)]" data-testid="risk-item-{i}">
						<div class="flex-1">
							<p class="break-words">{r.description}</p>
							{#if r.likelihood || r.impact || r.mitigation}
								<p class="text-xs text-[var(--color-text-muted)]">
									{#if r.likelihood}Likelihood: {r.likelihood}. {/if}{#if r.impact}Impact: {r.impact}. {/if}{#if r.mitigation}Mitigation: {r.mitigation}{/if}
								</p>
							{/if}
						</div>
						<button type="button" data-testid="remove-risk-{i}" onclick={() => removeRisk(i)} class="text-[var(--color-accent)]" aria-label="Remove risk">&times;</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
