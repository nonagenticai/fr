<script lang="ts" module>
	export interface RepoRow {
		url: string;
		branch: string;
		name: string;
		is_primary: boolean;
		/**
		 * The exact version to take as input (George 2026-11-07): a full commit SHA or
		 * a GitHub PR. Empty/absent = the branch. The backend resolves a PR to its head
		 * commit and stores the commit as RM's `sha`. Optional so a row hydrated from a
		 * stored draft (which predates pins) still types.
		 */
		pin?: string;
	}

	export function emptyRepoRow(): RepoRow {
		return { url: '', branch: '', name: '', is_primary: false, pin: '' };
	}

	/** Exactly one primary when rows is non-empty: keep the first flagged, else the first row. */
	export function normalisePrimary(rows: RepoRow[]): RepoRow[] {
		if (rows.length === 0) return [];
		let idx = rows.findIndex((r) => r.is_primary);
		if (idx < 0) idx = 0;
		return rows.map((r, i) => ({ ...r, is_primary: i === idx }));
	}

	/**
	 * ⛔ `coherenceError()` WAS HERE AND IS DELETED (2026-09-30).
	 *
	 * It mirrored a bidirectional backend refine — "'multi_repo' needs >=2
	 * repositories" and ">1 repository needs 'multi_repo'" — and both halves are
	 * gone. `scope_level` is a GRANULARITY vocabulary (repo, app, module,
	 * component, file, class, function) and nothing in the backend ever branched
	 * on the literal `'multi_repo'`; the server now DERIVES multi-repo-ness from
	 * the repository count and keeps whatever granularity the user chose. So the
	 * rule's second half would REFUSE the ordinary case this form now exists to
	 * support: two repositories at granularity `module`.
	 *
	 * What a multi-repo project declares instead is a COORDINATION MODE
	 * (`coordinated` / `independent`), asked for in ProjectForm.svelte §5 once two
	 * rows carry a URL. There is no per-repo role: a flat list, exactly one
	 * primary — which is what `normalisePrimary` above is for.
	 */
</script>

<script lang="ts">
	// ⛔ `scopeLevel` WAS A PROP HERE and is gone with `coherenceError` — it fed
	// nothing else, so keeping it would leave a prop this component reads and
	// never uses. The parent no longer passes it.
	interface Props {
		repositories: RepoRow[];
		disabled?: boolean;
	}

	let { repositories = $bindable(), disabled = false }: Props = $props();

	// Immutable updates only: the parent may pass a non-proxied array, and a
	// reassignment is the one write that is reactive either way.
	if (!repositories || repositories.length === 0) {
		repositories = normalisePrimary([emptyRepoRow()]);
	}

	const inputClass =
		'w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]';
	const labelClass =
		'block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]';

	function setField(i: number, field: 'url' | 'branch' | 'name' | 'pin', value: string) {
		repositories = repositories.map((r, j) => (j === i ? { ...r, [field]: value } : r));
	}

	function setPrimary(i: number) {
		repositories = repositories.map((r, j) => ({ ...r, is_primary: j === i }));
	}

	function addRow() {
		repositories = normalisePrimary([...repositories, emptyRepoRow()]);
	}

	function removeRow(i: number) {
		if (repositories.length <= 1) return;
		repositories = normalisePrimary(repositories.filter((_, j) => j !== i));
	}
</script>

<div class="space-y-3" data-testid="repository-repeater">
	{#each repositories as repo, i (i)}
		<div
			class="rounded-lg border border-[var(--color-border)] p-4 space-y-3"
			data-testid="repo-row"
		>
			<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
				<div class="md:col-span-2">
					<label for="repo-url-{i}" class={labelClass}>
						Repository URL
					</label>
					<!-- Not `required`: a project's repository is OPTIONAL (George 2026-10-13);
					     a blank row is ignored on submit. Bug hunt / CVE sweep / rewrite name
					     their own requirement in ProjectForm. -->
					<input
						id="repo-url-{i}"
						type="url"
						{disabled}
						value={repo.url}
						oninput={(e) => setField(i, 'url', e.currentTarget.value)}
						class={inputClass}
						placeholder="https://github.com/owner/repo"
					/>
				</div>
				<div>
					<label for="repo-branch-{i}" class={labelClass}>Branch</label>
					<input
						id="repo-branch-{i}"
						type="text"
						{disabled}
						value={repo.branch}
						oninput={(e) => setField(i, 'branch', e.currentTarget.value)}
						class={inputClass}
						placeholder="main"
					/>
				</div>
			</div>
			<div>
				<label for="repo-pin-{i}" class={labelClass}>Pin (optional)</label>
				<input
					id="repo-pin-{i}"
					type="text"
					{disabled}
					value={repo.pin ?? ''}
					oninput={(e) => setField(i, 'pin', e.currentTarget.value)}
					class="{inputClass} font-mono"
					placeholder="40-character commit SHA or #123"
					spellcheck="false"
					autocomplete="off"
				/>
				<p class="mt-1 text-xs text-[var(--color-text-muted)]">
					Optional — take the repository at this exact version (a commit SHA or a pull
					request). Leave empty to use the branch.
				</p>
			</div>
			<div class="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
				<div class="md:col-span-2">
					<label for="repo-name-{i}" class={labelClass}>Name (optional)</label>
					<input
						id="repo-name-{i}"
						type="text"
						{disabled}
						value={repo.name}
						oninput={(e) => setField(i, 'name', e.currentTarget.value)}
						class={inputClass}
					/>
				</div>
				<div class="flex items-center justify-between gap-3">
					<label class="flex items-center gap-2 text-sm text-[var(--color-text)]">
						<input
							type="radio"
							name="repo-primary"
							data-testid="repo-primary-{i}"
							{disabled}
							checked={repo.is_primary}
							onchange={() => setPrimary(i)}
						/>
						Primary
					</label>
					<button
						type="button"
						data-testid="repo-remove-{i}"
						disabled={disabled || repositories.length <= 1}
						onclick={() => removeRow(i)}
						class="px-3 py-2 text-sm rounded-lg border border-[var(--color-border-strong)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] disabled:opacity-50 disabled:cursor-not-allowed"
						aria-label="Remove repository {i + 1}"
					>
						Remove
					</button>
				</div>
			</div>
		</div>
	{/each}

	<button
		type="button"
		data-testid="add-repository"
		{disabled}
		onclick={addRow}
		class="px-3 py-2 text-sm rounded-lg border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
	>
		+ Add repository
	</button>
</div>
