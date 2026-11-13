<script lang="ts" module>
	import type { ProjectRepositoryListItem, Repository } from '$lib/types/api';

	// ── Two scopes, one tab ─────────────────────────────────────────────────────
	//
	// ⛔ THE DEFECT THIS PROP CLOSES. `/projects/[id]/repositories` rendered this
	// component with NO projectId, so it listed `GET /api/repositories` — filtered
	// by `user_id` ALONE (backend/src/routes/repositories.ts
	// `buildListRepositoriesConditions`) — and edited and DELETED through that
	// same global scope, while the page's subtitle claimed "The code repositories
	// this project's cards build against". Visiting project A's Repositories page
	// showed, and let you destroy, every repository the signed-in user owns in
	// EVERY project. The project-scoped API (migration 072,
	// `backend/src/routes/project-repositories.ts`) and its client
	// (`apiClient.projects.repositories.*`) both already existed and had zero
	// frontend callers.
	//
	// The prop is OPTIONAL and its ABSENCE preserves today's behaviour exactly —
	// `/repositories` is the global surface and must keep working unchanged.

	/**
	 * The row shape the template renders, in BOTH scopes.
	 *
	 * The two backends do NOT agree on shape, which is why this exists:
	 *
	 *   GET /api/repositories            → { items: Repository[], total }
	 *       Repository = { id, user_id, name?, url, branch?, path?, description?,
	 *                      secret_id?, created_at, updated_at }
	 *
	 *   GET /api/projects/:id/repositories → { items: ProjectRepositoryListItem[],
	 *                                          total, primary_repository_id }
	 *       item = { repo_id, url, branch, name, container_name, is_primary,
	 *                added_at }
	 *
	 * Differences that matter: the id is `repo_id`, not `id`; there is no `path`,
	 * `description`, `secret_id`, `created_at` or `updated_at`; and there are two
	 * fields the global shape has never had (`is_primary`, `container_name`).
	 * Normalising in the COMPONENT rather than reshaping the backend keeps every
	 * existing consumer of both routes untouched.
	 *
	 * ⚠️ `added_at` is NOT `created_at` and is deliberately kept in its own field.
	 * Rendering "Attached: <added_at>" under a "Created:" label would swap one
	 * false on-screen claim for another.
	 */
	export interface RepositoryRow {
		id: string;
		name: string | null;
		url: string;
		branch: string | null;
		/** `undefined` in project scope: that route does not return the field. */
		path?: string | null;
		description?: string | null;
		secret_id?: string | null;
		created_at?: string | Date | null;
		/** Project scope only. */
		added_at?: string | null;
		is_primary?: boolean;
		container_name?: string | null;
	}

	/** `GET /api/repositories` item → row. Identity apart from the widened type. */
	export function normaliseGlobalRepositoryRow(repo: Repository): RepositoryRow {
		return {
			id: repo.id,
			name: repo.name ?? null,
			url: repo.url,
			branch: repo.branch ?? null,
			path: repo.path ?? null,
			description: repo.description ?? null,
			secret_id: repo.secret_id ?? null,
			created_at: repo.created_at ?? null
		};
	}

	/**
	 * `GET /api/projects/:id/repositories` item → row.
	 *
	 * ⛔ The four absent detail fields are left `undefined`, NOT `null`. The
	 * distinction is load-bearing: `undefined` means "this scope never told us",
	 * and the edit form refuses to submit a row it has not fetched in full, so it
	 * can never PUT a blank over a real `path` / `description` / `secret_id`.
	 * `null` would read as "the user cleared it".
	 */
	export function normaliseProjectRepositoryRow(
		item: ProjectRepositoryListItem
	): RepositoryRow {
		return {
			id: item.repo_id,
			name: item.name,
			url: item.url,
			branch: item.branch,
			added_at: item.added_at,
			is_primary: item.is_primary,
			container_name: item.container_name
		};
	}

	// ── Repository name: never blank ────────────────────────────────────────────
	//
	// `repositories.name` is NOT NULL + `CHECK (btrim(name) <> '')` as of backend
	// migration 133, and the backend derives the name from the url when the caller
	// omits it (`backend/src/lib/repository-name.ts`). This form therefore has to
	// answer the SAME question client-side, or a user who leaves Name empty on a
	// url with no `owner/repo` in it gets an opaque 400 instead of a field message.
	//
	// ⚠️ MIRROR, not a shared module: the frontend cannot import from backend/src.
	// The backend is the authority — this only decides which message to show and
	// whether to bother sending. Keep the two in step; the canonical shapes are
	// pinned in `RepositoriesTab.name-required.test.ts`.
	const MAX_NAME_LENGTH = 255;

	/** `owner/repo` from a repository url, or null when the url carries no pair. */
	export function deriveRepositoryNameFromUrl(url: string | null | undefined): string | null {
		if (typeof url !== 'string') return null;
		const raw = url.trim();
		if (!raw) return null;

		let path: string;
		const scp = /^[^\s/@]+@[^\s/:]+:(.+)$/.exec(raw);
		if (scp) {
			path = scp[1] ?? '';
		} else {
			let parsed: URL | null = null;
			for (const candidate of [raw, `https://${raw}`]) {
				try {
					parsed = new URL(candidate);
					break;
				} catch {
					// try the next form
				}
			}
			if (!parsed) return null;
			path = parsed.pathname;
		}

		const segments = path.split('/').filter((s) => s.length > 0);
		const owner = segments[0];
		let repo = segments[1];
		if (!owner || !repo) return null;
		if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
		if (!repo || owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;

		const name = `${owner}/${repo}`;
		return name.length <= MAX_NAME_LENGTH ? name : null;
	}

	export interface RepositoryFormFields {
		name: string;
		url: string;
	}

	export interface RepositoryFormErrors {
		name: string;
		url: string;
	}

	/**
	 * Field-level errors for the add/edit form. Returns one entry per offending
	 * field, `{}`-equivalent (both blank) when the form may be submitted.
	 *
	 *  · url blank                       → url is required
	 *  · name blank AND underivable url  → name is required (the backend would 400)
	 *
	 * A blank name over a derivable url is VALID: the backend fills in
	 * `owner/repo`, which is the whole point of not requiring the field.
	 */
	export function validateRepositoryForm(fields: RepositoryFormFields): RepositoryFormErrors {
		const errors: RepositoryFormErrors = { name: '', url: '' };
		const url = fields.url.trim();
		const name = fields.name.trim();

		if (!url) {
			errors.url = 'URL is required';
		}
		if (!name && (!url || deriveRepositoryNameFromUrl(url) === null)) {
			errors.name =
				'Name is required — it could not be derived from the URL (expected owner/repo).';
		}
		return errors;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { apiClient, ApiError } from '$lib/api/unified-client';
	import type { RepositoryCreate, RepositoryUpdate, Secret } from '$lib/types/api';
	import { Skeleton, EmptyState, ErrorState } from '$lib/components/ui';
	import { shortId } from '$lib/utils/shortId';
	import { repoLabelFromUrl } from '$lib/projects/repo-view';

	interface Props {
		/**
		 * When supplied, every list/attach/detach/primary call goes through
		 * `/api/projects/<projectId>/repositories`. When ABSENT the component is
		 * the unchanged global `/repositories` surface. See the module script.
		 */
		projectId?: string;
	}

	let { projectId }: Props = $props();

	// `!!projectId`, not `projectId !== undefined`: an empty-string projectId would
	// build `/api/projects//repositories`, which is not a project scope at all. The
	// route param can only be `''` when `$page.params.id` is missing, and falling
	// back to the global scope there is the same behaviour as today, not a new one.
	const isProjectScoped = $derived(!!projectId);

	// State management
	let repositories = $state<RepositoryRow[]>([]);
	let primaryRepositoryId = $state<string | null>(null);
	let secrets = $state<Secret[]>([]);
	let isLoading = $state(false);
	let error = $state<unknown>(null);
	// Separate from `error`: the repository list can load fine while the secrets
	// list fails. Kept apart so a dead <select> is reported at the select instead
	// of blanking the whole page.
	let secretsError = $state('');

	// Modal state
	let showModal = $state(false);
	let showDeleteConfirm = $state(false);
	let editingRepo = $state<RepositoryRow | null>(null);
	let deletingRepo = $state<RepositoryRow | null>(null);
	// Set when the edit modal could not load the full repository record. The form
	// is then refused rather than shown half-populated — see openEditModal.
	let editLoadError = $state('');
	// A SUCCESSFUL attach that carries the backend's soft-validator warning. Kept
	// apart from `error` so a success is never reported under an error heading.
	let attachWarning = $state('');
	// Set when `DELETE /api/projects/:id/repositories/:repo_id` refuses with 409
	// `cannot_detach_primary_repository`.
	let detachError = $state('');

	// Form state
	let formData = $state({
		name: '',
		url: '',
		branch: 'main',
		path: '',
		description: '',
		secret_id: ''
	});

	let formErrors = $state<RepositoryFormErrors>({
		name: '',
		url: ''
	});

	let isSubmitting = $state(false);

	// Load data on mount
	onMount(() => {
		loadRepositories();
		loadSecrets();
	});

	async function loadRepositories() {
		isLoading = true;
		error = null;

		try {
			if (projectId) {
				// ⛔ THE FIX. `GET /api/projects/:id/repositories` joins through
				// `project_repositories` (migration 072) and is the only list in the
				// codebase that answers "which repositories does THIS project build
				// against". `GET /api/repositories` cannot: it has no project column
				// to filter on.
				const response = await apiClient.projects.repositories.list(projectId);
				repositories = (response.items ?? []).map(normaliseProjectRepositoryRow);
				primaryRepositoryId = response.primary_repository_id ?? null;
			} else {
				const response = await apiClient.repositories.list();
				repositories = (response.items ?? []).map(normaliseGlobalRepositoryRow);
				primaryRepositoryId = null;
			}
		} catch (err) {
			if (err instanceof ApiError) {
				error = err.message;
			} else {
				error = 'Failed to load repositories';
			}
			console.error('Error loading repositories:', err);
		} finally {
			isLoading = false;
		}
	}

	async function loadSecrets() {
		secretsError = '';

		try {
			const response = await apiClient.secrets.list();
			secrets = response.items || [];
		} catch (err) {
			secretsError = err instanceof ApiError ? err.message : 'Failed to load secrets';
			secrets = [];
			console.error('Error loading secrets:', err);
		}
	}

	function openCreateModal() {
		editingRepo = null;
		editLoadError = '';
		formData = {
			name: '',
			url: '',
			branch: 'main',
			path: '',
			description: '',
			secret_id: ''
		};
		formErrors = { name: '', url: '' };
		showModal = true;
	}

	/**
	 * Populate the edit form.
	 *
	 * ⚠️ In project scope the list row carries NO `path` / `description` /
	 * `secret_id` (see `normaliseProjectRepositoryRow`), and `submitForm` sends
	 * all six fields. Populating from the row alone would therefore PUT empty
	 * strings over three real columns — a data-destroying regression introduced
	 * BY the scoping fix. So project scope fetches the full record first
	 * (`GET /api/repositories/:id`, owner-scoped, 404s a repo that is not the
	 * caller's) and refuses the form if that fetch fails.
	 */
	async function openEditModal(repo: RepositoryRow) {
		editingRepo = repo;
		editLoadError = '';
		formErrors = { name: '', url: '' };

		showModal = true;
		let full: RepositoryRow = repo;
		if (repo.path === undefined) {
			try {
				full = normaliseGlobalRepositoryRow(await apiClient.repositories.get(repo.id));
			} catch (err) {
				editLoadError =
					err instanceof ApiError
						? err.message
						: 'Could not load this repository’s details.';
				console.error('Error loading repository detail:', err);
				return;
			}
		}

		formData = {
			name: full.name || '',
			url: full.url,
			branch: full.branch || 'main',
			path: full.path || '',
			description: full.description || '',
			secret_id: full.secret_id || ''
		};
	}

	function validateForm(): boolean {
		formErrors = validateRepositoryForm({ name: formData.name, url: formData.url });
		return !formErrors.name && !formErrors.url;
	}

	async function submitForm() {
		if (!validateForm()) return;
		// Refuse rather than submit a form whose detail fields never loaded.
		if (editingRepo && editLoadError) return;

		isSubmitting = true;
		error = null;
		attachWarning = '';

		try {
			if (!editingRepo && projectId) {
				// ATTACH, not create. `POST /api/projects/:id/repositories` accepts
				// `{repo_id}` or `{url, branch, name}` ONLY — it upserts the
				// `repositories` row on (user_id, url) and inserts the join row with
				// `is_primary: false` (promote is its own route and never silently
				// demotes). It has no `path` / `description` / `secret_id`, which is
				// why the form hides those three in project scope instead of
				// collecting them and letting the backend drop them on the floor.
				const res = await apiClient.projects.repositories.attach(projectId, {
					name: formData.name.trim() || undefined,
					url: formData.url,
					branch: formData.branch || undefined
				});
				// The SOFT validator hop. A 200 with a warning is not a success worth
				// hiding: `container_not_bound_to_project` means the attach landed but
				// nothing in this project's architecture binds the container, so the
				// repo cannot yet be promoted to primary.
				// NOT `error`: the attach SUCCEEDED, and the page's error banner is
				// titled "Error loading repositories". Reporting a warning there would
				// be a third false on-screen claim in the same component.
				attachWarning =
					res.warning === null
						? ''
						: res.warning === 'container_not_bound_to_project'
							? 'Attached, but no architecture element in this project binds its container — model the architecture before promoting it to primary.'
							: `Attached, but the container-binding validator was unavailable (${res.warning}).`;
				await loadRepositories();
				closeModal();
				return;
			}

			if (editingRepo) {
				const updateData: RepositoryUpdate = {
					// `.trim()`: the backend rejects a whitespace-only name (422) rather
					// than storing it, so never send one.
					name: formData.name.trim() || undefined,
					url: formData.url,
					branch: formData.branch || undefined,
					path: formData.path || undefined,
					description: formData.description || undefined,
					secret_id: formData.secret_id || null
				};
				await apiClient.repositories.update(editingRepo.id, updateData);
			} else {
				const createData: RepositoryCreate = {
					// Omitted when blank — the backend derives `owner/repo` from the url.
					name: formData.name.trim() || undefined,
					url: formData.url,
					branch: formData.branch || undefined,
					path: formData.path || undefined,
					description: formData.description || undefined,
					secret_id: formData.secret_id || undefined
				};
				await apiClient.repositories.create(createData);
			}

			await loadRepositories();
			closeModal();
		} catch (err) {
			if (err instanceof ApiError) {
				error = err.message;
			} else {
				error = editingRepo
					? 'Failed to update repository'
					: projectId
						? 'Failed to attach repository'
						: 'Failed to create repository';
			}
			console.error('Error submitting repository:', err);
		} finally {
			isSubmitting = false;
		}
	}

	function closeModal() {
		showModal = false;
		editingRepo = null;
		editLoadError = '';
	}

	function openDeleteConfirm(repo: RepositoryRow) {
		deletingRepo = repo;
		detachError = '';
		showDeleteConfirm = true;
	}

	function closeDeleteConfirm() {
		showDeleteConfirm = false;
		deletingRepo = null;
		detachError = '';
	}

	/**
	 * Project scope DETACHES; global scope DELETES.
	 *
	 * ⛔ These are not the same act and must never share a button. `DELETE
	 * /api/repositories/:id` destroys the repository row for the user in every
	 * project; `DELETE /api/projects/:id/repositories/:repo_id` removes one join
	 * row and leaves the repository intact. The pre-fix page ran the FIRST one
	 * from a page captioned as project-scoped, which is how "manage this
	 * project's repositories" could delete another project's.
	 */
	async function deleteRepository() {
		if (!deletingRepo) return;

		isSubmitting = true;
		error = null;
		detachError = '';

		try {
			if (projectId) {
				await apiClient.projects.repositories.detach(projectId, deletingRepo.id);
			} else {
				await apiClient.repositories.delete(deletingRepo.id);
			}
			await loadRepositories();
			closeDeleteConfirm();
		} catch (err) {
			// The backend refuses to detach the primary (409) because the project
			// carries a denormalised copy of it on `projects.repository_url`. Say what
			// to do instead, at the confirm dialog, rather than as a page-level error.
			if (err instanceof ApiError && err.status === 409) {
				detachError =
					'This is the primary repository. Promote another repository to primary first.';
			} else if (err instanceof ApiError) {
				error = err.message;
			} else {
				error = projectId ? 'Failed to detach repository' : 'Failed to delete repository';
			}
			console.error('Error removing repository:', err);
		} finally {
			isSubmitting = false;
		}
	}

	/**
	 * Promote to primary — project scope only; there is no global equivalent.
	 *
	 * The backend does a transactional swap of the `is_primary` flag AND re-stamps
	 * `projects.repository_url/branch/container_name`, and it is a HARD validator
	 * hop: 422 when the repo has no container, 409 when no architecture element in
	 * the project binds that container. Both are reported verbatim — they name the
	 * next action, and flattening them into "failed" would hide it.
	 */
	async function promoteToPrimary(repo: RepositoryRow) {
		if (!projectId || repo.is_primary) return;

		isSubmitting = true;
		error = null;

		try {
			const res = await apiClient.projects.repositories.promote(projectId, repo.id);
			repositories = (res.items ?? []).map(normaliseProjectRepositoryRow);
			primaryRepositoryId = res.primary_repository_id ?? null;
		} catch (err) {
			if (err instanceof ApiError) {
				error = err.message;
			} else {
				error = 'Failed to promote repository to primary';
			}
			console.error('Error promoting repository:', err);
		} finally {
			isSubmitting = false;
		}
	}

	function formatDate(date: string | Date | null | undefined): string {
		if (!date) return 'N/A';
		const d = typeof date === 'string' ? new Date(date) : date;
		return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
	}

	function getSecretName(secretId: string | null | undefined): string {
		if (!secretId) return '';
		const secret = secrets.find(s => s.id === secretId);
		if (secret) return secret.name;
		// Never render a bare 'Unknown' — that is indistinguishable from a secret
		// genuinely named "Unknown". Parenthesised (not a legal display name here)
		// and it says WHY: the list never loaded vs. the secret is really gone.
		// `shortId`, not `<EntityRef>`: this function returns a STRING into a text
		// interpolation, so a component cannot go here. TAIL 8 (fr#1203/#1205) —
		// secrets minted in one batch shared a leading-8, which made two missing
		// secrets read identically.
		return secretsError
			? '(secret name unavailable)'
			: `(missing secret ${shortId(secretId)})`;
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-[var(--color-text)] dark:text-[var(--color-text)]">
				{isProjectScoped ? 'Project Repositories' : 'Repository Management'}
			</h1>
			<p class="mt-2 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
				{#if isProjectScoped}
					Repositories attached to this project. Attaching and detaching affect this
					project only — <strong>Edit</strong> changes the repository record itself,
					everywhere it is attached.
				{:else}
					Manage your code repositories and their credentials
				{/if}
			</p>
		</div>
		<button
			onclick={openCreateModal}
			class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			disabled={isLoading}
			data-testid="repo-add-button"
		>
			{isProjectScoped ? '+ Attach Repository' : '+ Add Repository'}
		</button>
	</div>

	<!-- Error Alert -->
	{#if error}
		<ErrorState error={error} title="Error loading repositories" onRetry={() => { error = null; void loadRepositories(); }} />
	{/if}

	<!-- A SUCCESSFUL attach carrying the backend's soft-validator warning. -->
	{#if attachWarning}
		<div
			class="rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-4 py-3 text-sm text-[var(--color-warning-text)]"
			data-testid="repo-attach-warning"
		>
			{attachWarning}
		</div>
	{/if}

	<!-- Loading State -->
	{#if isLoading}
		<div class="bg-[var(--color-bg)] rounded-lg shadow p-6 dark:bg-[var(--color-surface)]">
			<Skeleton variant="text" count={5} height="3rem" />
		</div>
	{:else}
		<!-- Repositories List -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]">
			<div class="px-6 py-4 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h2 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]" data-testid="repo-list-heading">
					{isProjectScoped
						? `Attached to this project (${repositories.length})`
						: `Your Repositories (${repositories.length})`}
				</h2>
				<!-- `primary_repository_id` is a top-level field of the project list
				     response, and a null one with rows present is a real state, not a
				     rendering gap: nothing has been promoted, so
				     `projects.repository_url` does not point at any attached row and the
				     coding adapter has no repository to dispatch from. -->
				{#if isProjectScoped && repositories.length > 0 && primaryRepositoryId === null}
					<p class="mt-1 text-xs text-[var(--color-warning-text)]" data-testid="repo-no-primary">
						No primary repository set — promote one so this project's cards have a
						repository to build against.
					</p>
				{/if}
			</div>

			{#if repositories.length === 0}
				<EmptyState
					title={isProjectScoped ? 'No repositories attached yet' : 'No repositories yet'}
					body={isProjectScoped
						? "Attach a repository so this project's cards have something to build against"
						: 'Add your first repository to get started'}
					actionLabel={isProjectScoped ? '+ Attach Repository' : '+ Add Repository'}
					onAction={openCreateModal}
				/>
			{:else}
				<div class="divide-y divide-[var(--color-border)] dark:divide-[var(--color-border-strong)]">
					{#each repositories as repo}
						<div class="px-6 py-4 hover:bg-[var(--color-surface)] transition-colors dark:hover:bg-[var(--color-surface-strong)]">
							<div class="flex items-center justify-between">
								<div class="flex items-center gap-4 flex-1">
									<span class="text-3xl">&#128230;</span>
									<div class="flex-1">
										<div class="flex items-center gap-3">
											<!-- UI review 2026-10-07: label from the URL — shared rows were named after another project. -->
											<p class="font-medium text-[var(--color-text)] dark:text-[var(--color-text)]" title={repo.url}>{repoLabelFromUrl(repo.url, repo.name)}</p>
											{#if repo.branch}
												<span class="px-2 py-1 text-xs font-medium rounded-full bg-[var(--color-info-bg)] text-[var(--color-info-text)]">
													{repo.branch}
												</span>
											{/if}
											{#if repo.secret_id}
												<span class="px-2 py-1 text-xs font-medium rounded-full bg-[var(--color-success-bg)] text-[var(--color-success-text)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]">
													&#128274; {getSecretName(repo.secret_id)}
												</span>
											{/if}
											{#if repo.is_primary}
												<span
													class="px-2 py-1 text-xs font-medium rounded-full bg-[var(--color-accent)] text-[var(--color-on-primary)]"
													title="This project's primary repository — projects.repository_url points here"
													data-testid="repo-primary-badge"
												>
													Primary
												</span>
											{/if}
											{#if repo.container_name}
												<span class="px-2 py-1 text-xs font-medium rounded-full bg-[var(--color-surface-strong)] text-[var(--color-text-muted)]">
													{repo.container_name}
												</span>
											{/if}
										</div>
										<p class="text-sm text-[var(--color-text)] mt-1 truncate dark:text-[var(--color-text-muted)]">{repo.url}</p>
										{#if repo.description}
											<p class="text-sm text-[var(--color-text-muted)] mt-1 dark:text-[var(--color-text-muted)]">{repo.description}</p>
										{/if}
										<div class="flex items-center gap-4 mt-2 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
											<!-- ⚠️ Two different dates behind two different labels. The
											     project route returns `added_at` (when it was attached to
											     THIS project) and no `created_at` at all; printing one
											     under the other's label would be a fresh false claim. -->
											{#if repo.added_at}
												<span>Attached: {formatDate(repo.added_at)}</span>
											{:else}
												<span>Created: {formatDate(repo.created_at)}</span>
											{/if}
											{#if repo.path}
												<span>Path: {repo.path}</span>
											{/if}
										</div>
									</div>
								</div>
								<div class="flex gap-2">
									{#if isProjectScoped && !repo.is_primary}
										<button
											onclick={() => promoteToPrimary(repo)}
											disabled={isSubmitting}
											class="px-3 py-1 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-on-primary)] rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
											data-testid="repo-make-primary"
										>
											Make primary
										</button>
									{/if}
									<button
										onclick={() => openEditModal(repo)}
										class="px-3 py-1 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-on-primary)] rounded transition-colors"
										title={isProjectScoped
											? 'Edits the repository record itself — the change is visible in every project it is attached to'
											: undefined}
									>
										Edit
									</button>
									<button
										onclick={() => openDeleteConfirm(repo)}
										class="px-3 py-1 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] rounded transition-colors"
										data-testid="repo-remove-button"
									>
										{isProjectScoped ? 'Detach' : 'Delete'}
									</button>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Create/Edit Modal -->
{#if showModal}
	<div class="fixed inset-0 bg-[var(--color-bg)] bg-opacity-50 flex items-center justify-center z-50 p-4">
		<div class="bg-[var(--color-bg)] rounded-lg max-w-md w-full shadow-xl dark:bg-[var(--color-surface)]">
			<div class="px-6 py-4 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h3 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">
					{editingRepo
						? 'Edit Repository'
						: isProjectScoped
							? 'Attach Repository'
							: 'Add New Repository'}
				</h3>
				{#if editingRepo && isProjectScoped}
					<p class="mt-1 text-xs text-[var(--color-text-muted)]">
						This edits the repository record, not its attachment — the change shows up
						in every project this repository is attached to.
					</p>
				{:else if isProjectScoped}
					<p class="mt-1 text-xs text-[var(--color-text-muted)]">
						Attaches a repository you own to this project, creating it if the URL is new.
						Path, description and linked secret belong to the repository itself — set
						them with <strong>Edit</strong> once it is attached.
					</p>
				{/if}
			</div>

			{#if editLoadError}
				<div
					class="mx-6 mt-4 rounded border border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger-text)]"
					data-testid="repo-edit-load-error"
				>
					{editLoadError} The form is disabled rather than submit blank values over the
					fields it could not read.
				</div>
			{/if}

			<form onsubmit={(e) => { e.preventDefault(); submitForm(); }} class="px-6 py-4 space-y-4">
				<!-- Name -->
				<div>
					<label for="repo-name" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Name</label>
					<input
						id="repo-name"
						type="text"
						bind:value={formData.name}
						class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
						placeholder="Leave blank to use owner/repo from the URL"
					/>
					{#if formErrors.name}
						<p class="text-[var(--color-danger)] text-xs mt-1">{formErrors.name}</p>
					{/if}
				</div>

				<!-- URL -->
				<div>
					<label for="repo-url" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
						URL <span class="text-[var(--color-danger)]">*</span>
					</label>
					<input
						id="repo-url"
						type="text"
						bind:value={formData.url}
						class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
						placeholder="https://github.com/user/repo.git"
						required
					/>
					{#if formErrors.url}
						<p class="text-[var(--color-danger)] text-xs mt-1">{formErrors.url}</p>
					{/if}
				</div>

				<!-- Branch -->
				<div>
					<label for="repo-branch" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Branch</label>
					<input
						id="repo-branch"
						type="text"
						bind:value={formData.branch}
						class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
						placeholder="main"
					/>
				</div>

				<!--
					⛔ Path / Description / Linked Secret are HIDDEN on a project ATTACH.
					`POST /api/projects/:id/repositories` accepts only `{repo_id}` or
					`{url, branch, name}`; collecting the other three here would let the
					user fill fields the request silently discards — the same class of
					false-affordance defect this change exists to remove. They are still
					editable: Edit goes to `PUT /api/repositories/:id`, which owns them.
				-->
				{#if editingRepo || !isProjectScoped}
				<!-- Path -->
				<div>
					<label for="repo-path" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Path</label>
					<input
						id="repo-path"
						type="text"
						bind:value={formData.path}
						class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
						placeholder="e.g., /src"
					/>
				</div>

				<!-- Description -->
				<div>
					<label for="repo-description" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Description</label>
					<textarea
						id="repo-description"
						bind:value={formData.description}
						rows="2"
						class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
						placeholder="Optional description"
					></textarea>
				</div>

				<!-- Secret -->
				<div>
					<label for="repo-secret" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Linked Secret</label>
					<select
						id="repo-secret"
						bind:value={formData.secret_id}
						class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
					>
						<option value="">None</option>
						{#each secrets as secret}
							<option value={secret.id}>{secret.name} ({secret.secret_type})</option>
						{/each}
					</select>
					{#if secretsError}
						<p class="text-[var(--color-danger)] text-xs mt-1">
							Could not load secrets: {secretsError} — no credential can be attached.
						</p>
					{/if}
				</div>
				{/if}

				<!-- Actions -->
				<div class="flex gap-3 pt-2">
					<button
						type="submit"
						disabled={isSubmitting || !!editLoadError}
						class="flex-1 px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						data-testid="repo-submit-button"
					>
						{#if isSubmitting}
							<span class="flex items-center justify-center gap-2">
								<span class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-border)]"></span>
								{editingRepo ? 'Updating...' : isProjectScoped ? 'Attaching...' : 'Creating...'}
							</span>
						{:else}
							{editingRepo
								? 'Update Repository'
								: isProjectScoped
									? 'Attach Repository'
									: 'Add Repository'}
						{/if}
					</button>
					<button
						type="button"
						onclick={closeModal}
						disabled={isSubmitting}
						class="px-4 py-2 bg-[var(--color-surface-strong)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed dark:bg-[var(--color-surface-strong)] dark:text-[var(--color-text-muted)]"
					>
						Cancel
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- Delete Confirmation Modal -->
{#if showDeleteConfirm && deletingRepo}
	<div class="fixed inset-0 bg-[var(--color-bg)] bg-opacity-50 flex items-center justify-center z-50 p-4">
		<div class="bg-[var(--color-bg)] rounded-lg max-w-md w-full shadow-xl dark:bg-[var(--color-surface)]">
			<div class="px-6 py-4 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h3 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">
					{isProjectScoped ? 'Detach Repository' : 'Delete Repository'}
				</h3>
			</div>

			<div class="px-6 py-4">
				{#if isProjectScoped}
					<p class="text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
						Remove <strong>"{deletingRepo.name || deletingRepo.url}"</strong> from this
						project?
					</p>
					<p class="text-sm mt-2 text-[var(--color-text-muted)]">
						The repository itself is <strong>not</strong> deleted — only its attachment
						to this project. It stays available to your other projects.
					</p>
				{:else}
					<p class="text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
						Are you sure you want to delete the repository <strong>"{deletingRepo.name || deletingRepo.url}"</strong>?
					</p>
					<p class="text-[var(--color-danger)] text-sm mt-2">
						This action cannot be undone.
					</p>
				{/if}
				{#if detachError}
					<p class="text-[var(--color-danger)] text-sm mt-3" data-testid="repo-detach-error">
						{detachError}
					</p>
				{/if}
			</div>

			<div class="px-6 py-4 bg-[var(--color-surface)] flex gap-3 rounded-b-lg dark:bg-[var(--color-bg)]">
				<button
					onclick={deleteRepository}
					disabled={isSubmitting}
					class="flex-1 px-4 py-2 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					data-testid="repo-remove-confirm"
				>
					{#if isSubmitting}
						<span class="flex items-center justify-center gap-2">
							<span class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-border)]"></span>
							{isProjectScoped ? 'Detaching...' : 'Deleting...'}
						</span>
					{:else}
						{isProjectScoped ? 'Detach Repository' : 'Delete Repository'}
					{/if}
				</button>
				<button
					onclick={closeDeleteConfirm}
					disabled={isSubmitting}
					class="px-4 py-2 bg-[var(--color-surface-strong)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed dark:bg-[var(--color-surface-strong)] dark:text-[var(--color-text-muted)]"
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}
