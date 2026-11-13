<script lang="ts">
	import { onMount } from 'svelte';
	import { apiClient, ApiError } from '$lib/api/unified-client';
	import { fetchWithBudget, BudgetExceededError } from '$lib/net/fetchWithBudget';
	import type {
		URLCredential,
		URLCredentialCreate,
		URLCredentialUpdate,
		CredentialAuthType,
		Credentials,
		BasicAuthCredentials,
		BearerTokenCredentials,
		ApiKeyCredentials,
		CookieCredentials,
		CustomHeadersCredentials
	} from '$lib/types/api';

	// State management
	let credentials = $state<URLCredential[]>([]);
	let isLoading = $state(false);
	let error = $state<string | null>(null);

	// Modal state
	let showModal = $state(false);
	let showDeleteConfirm = $state(false);
	let editingCredential = $state<URLCredential | null>(null);
	let deletingCredential = $state<URLCredential | null>(null);

	// Form state
	let formData = $state({
		identifier: '',
		url: '',
		auth_type: 'basic' as CredentialAuthType,
		// Basic auth
		username: '',
		password: '',
		// Bearer token
		auth_token: '',
		// API key
		api_key: '',
		api_key_header: 'X-API-Key',
		// Cookie
		cookies: {} as Record<string, string>,
		cookieKey: '',
		cookieValue: '',
		// Custom headers
		custom_headers: {} as Record<string, string>,
		headerKey: '',
		headerValue: '',
		// Metadata
		metadata: {} as Record<string, any>,
		ttl: 0
	});

	let formErrors = $state({
		identifier: '',
		url: '',
		auth: ''
	});

	let isSubmitting = $state(false);
	let testingConnection = $state(false);
	let testResult = $state<{ success: boolean; message: string } | null>(null);

	// Edit-modal secret hydration. See openEditModal.
	let loadingSecrets = $state(false);
	let secretsUnavailable = $state(false);
	// Monotonic token so a slow GET for a credential the user has already closed
	// or switched away from cannot land in the form (same guard shape as the
	// provider/model effect in routes/workers/[name]).
	let editLoadToken = 0;

	/**
	 * The shape `GET /api/url-credentials/:id` actually returns. The backend
	 * returns the upstream retrieve response VERBATIM
	 * (backend/src/routes/urlCredentials.ts:117 `jsonResponse(credential)`), and
	 * that model requires a plaintext `credentials` object
	 * (tooling/openapi/specs/secrets.json — URLCredentialRetrieveResponse), which
	 * `URLCredential` does not declare. Declared locally rather than widening
	 * `URLCredential`: the LIST shape genuinely has no credentials, and saying
	 * otherwise there would invite blind reads of a field that is never present.
	 */
	type URLCredentialDetail = URLCredential & {
		credentials?: Record<string, unknown> | null;
	};

	// Auth type options
	const authTypes: { value: CredentialAuthType; label: string; description: string }[] = [
		{ value: 'basic', label: 'Basic Authentication', description: 'Username and password' },
		{ value: 'bearer', label: 'Bearer Token', description: 'JWT or OAuth token' },
		{ value: 'api_key', label: 'API Key', description: 'API key in header' },
		{ value: 'cookie', label: 'Cookie Authentication', description: 'Session cookies' },
		{ value: 'custom', label: 'Custom Headers', description: 'Custom HTTP headers' }
	];

	/**
	 * Narrow an arbitrary stored value to an auth type this form can actually
	 * render, or null. The backend's union has SIX members — it also admits
	 * `form` — while this select offers five, and an `auth_type` with no matching
	 * <option> renders no auth fields at all, walks past every `validateForm`
	 * case, and makes `buildCredentials()` return undefined. Unrepresentable is a
	 * null to be reported, never a value to be coerced to 'basic' silently.
	 */
	function knownAuthType(value: unknown): CredentialAuthType | null {
		return typeof value === 'string' && authTypes.some((t) => t.value === value)
			? (value as CredentialAuthType)
			: null;
	}

	// Load credentials on mount
	onMount(() => {
		loadCredentials();
	});

	/**
	 * Load all URL credentials from API
	 */
	async function loadCredentials() {
		isLoading = true;
		error = null;

		try {
			const response = await apiClient.urlCredentials.list();
			credentials = response.items || [];
		} catch (err) {
			if (err instanceof ApiError) {
				error = err.message;
			} else {
				error = 'Failed to load credentials';
			}
			console.error('Error loading credentials:', err);
		} finally {
			isLoading = false;
		}
	}

	/**
	 * Open modal for creating a new credential
	 */
	function openCreateModal() {
		editingCredential = null;
		resetFormData();
		showModal = true;
	}

	/**
	 * Open modal for editing an existing credential
	 */
	async function openEditModal(credential: URLCredential) {
		editingCredential = credential;
		// ⛔ `auth_type` used to be hard-coded to 'basic' here, with the comment
		// "Default - will be overridden by user selection". NOTHING overrode it: the
		// select simply opened on Basic, `buildCredentials()` built
		// `{auth_type:'basic', username:'', password:''}` out of the blank fields
		// below, and `submitForm` PUT that over the stored secret. Editing only the
		// URL of a working bearer/api-key/cookie credential DESTROYED it.
		//
		// `metadata.auth_type` is trustworthy: the backend FORCE-WRITES it from the
		// submitted credential on both create and update
		// (backend/src/routes/urlCredentials.ts:85 and :153), so it always describes
		// what is actually stored. It is seeded synchronously so the correct auth
		// section is on screen before the GET below resolves.
		formData = {
			identifier: credential.identifier,
			url: credential.url,
			auth_type: knownAuthType(credential.metadata?.auth_type) ?? 'basic',
			username: '',
			password: '',
			auth_token: '',
			api_key: '',
			api_key_header: 'X-API-Key',
			cookies: {},
			cookieKey: '',
			cookieValue: '',
			custom_headers: {},
			headerKey: '',
			headerValue: '',
			metadata: credential.metadata || {},
			ttl: 0
		};
		formErrors = { identifier: '', url: '', auth: '' };
		testResult = null;
		secretsUnavailable = false;
		showModal = true;

		// ⛔ The PUT is a FULL REPLACE and `credentials` is REQUIRED on it: the
		// backend parses the update body with `URLCredentialCreateSchema`
		// (urlCredentials.ts:135), so omitting `credentials` is a 422 on every edit,
		// and sending it built from blank fields is the data loss above. The only
		// way to edit a URL without destroying the secret is therefore to REPLAY the
		// stored secret — which `GET /api/url-credentials/:id` can give us, because
		// it returns the upstream retrieve model verbatim and that model carries the
		// plaintext `credentials` (ownership-checked at urlCredentials.ts:113).
		const token = ++editLoadToken;
		loadingSecrets = true;
		try {
			const detail = (await apiClient.urlCredentials.get(
				credential.credential_id
			)) as URLCredentialDetail;
			// Discard a response for a credential the user has closed or switched away
			// from — otherwise a slow GET drops one credential's secret into another's
			// form and the next save writes it to the wrong row.
			if (token !== editLoadToken) return;
			secretsUnavailable = !applyStoredCredentials(detail?.credentials);
		} catch (err) {
			if (token !== editLoadToken) return;
			secretsUnavailable = true;
			console.error('Error loading stored credential secret:', err);
		} finally {
			if (token === editLoadToken) loadingSecrets = false;
		}
	}

	/**
	 * Copy a stored credentials object into the form.
	 *
	 * Returns false — meaning "the stored secret is NOT in the form" — whenever any
	 * part of it is missing or of an unexpected shape, including an `auth_type` this
	 * UI cannot represent (the backend union also admits `form`, which these five
	 * options do not). A false return must never be treated as "close enough": it is
	 * what makes the difference between replaying the secret and silently rewriting
	 * the credential into something else.
	 */
	function applyStoredCredentials(stored: Record<string, unknown> | null | undefined): boolean {
		if (!stored || typeof stored !== 'object') return false;

		const authType = knownAuthType(stored.auth_type);
		if (!authType) return false;
		formData.auth_type = authType;

		const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
		const map = (v: unknown): Record<string, string> | null =>
			v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0
				? { ...(v as Record<string, string>) }
				: null;

		switch (authType) {
			case 'basic': {
				const username = str(stored.username);
				const password = str(stored.password);
				if (!username || !password) return false;
				formData.username = username;
				formData.password = password;
				return true;
			}
			case 'bearer': {
				const token = str(stored.auth_token);
				if (!token) return false;
				formData.auth_token = token;
				return true;
			}
			case 'api_key': {
				const key = str(stored.api_key);
				if (!key) return false;
				formData.api_key = key;
				formData.api_key_header = str(stored.api_key_header) ?? 'X-API-Key';
				return true;
			}
			case 'cookie': {
				const cookies = map(stored.cookies);
				if (!cookies) return false;
				formData.cookies = cookies;
				return true;
			}
			case 'custom': {
				const headers = map(stored.custom_headers);
				if (!headers) return false;
				formData.custom_headers = headers;
				return true;
			}
		}
		return false;
	}

	/**
	 * Reset form data
	 */
	function resetFormData() {
		formData = {
			identifier: '',
			url: '',
			auth_type: 'basic',
			username: '',
			password: '',
			auth_token: '',
			api_key: '',
			api_key_header: 'X-API-Key',
			cookies: {},
			cookieKey: '',
			cookieValue: '',
			custom_headers: {},
			headerKey: '',
			headerValue: '',
			metadata: {},
			ttl: 0
		};
		formErrors = { identifier: '', url: '', auth: '' };
		testResult = null;
		// Invalidate any in-flight edit hydration: without the bump, a GET issued for
		// the credential we just closed would still apply its secret to this form.
		editLoadToken += 1;
		loadingSecrets = false;
		secretsUnavailable = false;
	}

	/**
	 * Validate form data
	 */
	function validateForm(): boolean {
		formErrors = { identifier: '', url: '', auth: '' };
		let isValid = true;

		if (!formData.identifier.trim()) {
			formErrors.identifier = 'Identifier is required';
			isValid = false;
		}

		if (!formData.url.trim()) {
			formErrors.url = 'URL is required';
			isValid = false;
		} else {
			// Basic URL validation
			try {
				new URL(formData.url);
			} catch {
				formErrors.url = 'Invalid URL format';
				isValid = false;
			}
		}

		// Validate auth-specific fields
		switch (formData.auth_type) {
			case 'basic':
				if (!formData.username.trim() || !formData.password.trim()) {
					formErrors.auth = 'Username and password are required';
					isValid = false;
				}
				break;
			case 'bearer':
				if (!formData.auth_token.trim()) {
					formErrors.auth = 'Bearer token is required';
					isValid = false;
				}
				break;
			case 'api_key':
				if (!formData.api_key.trim()) {
					formErrors.auth = 'API key is required';
					isValid = false;
				}
				break;
			case 'cookie':
				if (Object.keys(formData.cookies).length === 0) {
					formErrors.auth = 'At least one cookie is required';
					isValid = false;
				}
				break;
			case 'custom':
				if (Object.keys(formData.custom_headers).length === 0) {
					formErrors.auth = 'At least one custom header is required';
					isValid = false;
				}
				break;
		}

		return isValid;
	}

	/**
	 * Build credentials object based on auth type
	 */
	function buildCredentials(): Credentials {
		switch (formData.auth_type) {
			case 'basic':
				return {
					auth_type: 'basic',
					username: formData.username,
					password: formData.password
				} as BasicAuthCredentials;
			case 'bearer':
				return {
					auth_type: 'bearer',
					auth_token: formData.auth_token
				} as BearerTokenCredentials;
			case 'api_key':
				return {
					auth_type: 'api_key',
					api_key: formData.api_key,
					api_key_header: formData.api_key_header || 'X-API-Key'
				} as ApiKeyCredentials;
			case 'cookie':
				return {
					auth_type: 'cookie',
					cookies: formData.cookies
				} as CookieCredentials;
			case 'custom':
				return {
					auth_type: 'custom',
					custom_headers: formData.custom_headers
				} as CustomHeadersCredentials;
		}
	}

	/**
	 * Submit form (create or update)
	 */
	async function submitForm() {
		// Never PUT while the stored secret is still in flight — the form's secret
		// fields are blank until it lands, and this PUT replaces them wholesale. The
		// button is disabled too; this guards the form's own Enter-key submit.
		if (loadingSecrets) {
			return;
		}
		if (!validateForm()) {
			return;
		}

		isSubmitting = true;
		error = null;

		try {
			const credentialsData = buildCredentials();

			if (editingCredential) {
				// `credentials` is ALWAYS sent, and must be: the PUT handler validates
				// with `URLCredentialCreateSchema`, where it is required, and the upstream
				// secrets-service PUT is a full-replace upsert of the same model — so
				// omitting it 422s at both layers rather than patching. `URLCredentialUpdate`
				// declaring it optional is a type/runtime divergence, not permission.
				// What makes this safe is openEditModal replaying the STORED secret into
				// the form first; when it could not, `secretsUnavailable` tells the user
				// in the modal that saving replaces the credential.
				const updateData: URLCredentialUpdate = {
					identifier: formData.identifier,
					url: formData.url,
					credentials: credentialsData,
					metadata: formData.metadata,
					ttl: formData.ttl > 0 ? formData.ttl : undefined
				};

				await apiClient.urlCredentials.update(editingCredential.credential_id, updateData);
			} else {
				// Create new credential
				const createData: URLCredentialCreate = {
					identifier: formData.identifier,
					url: formData.url,
					credentials: credentialsData,
					metadata: formData.metadata,
					ttl: formData.ttl > 0 ? formData.ttl : undefined
				};

				await apiClient.urlCredentials.create(createData);
			}

			// Reload credentials and close modal
			await loadCredentials();
			closeModal();
		} catch (err) {
			if (err instanceof ApiError) {
				error = err.message;
			} else {
				error = editingCredential ? 'Failed to update credential' : 'Failed to create credential';
			}
			console.error('Error submitting credential:', err);
		} finally {
			isSubmitting = false;
		}
	}

	/**
	 * Test connection with the credentials
	 */
	async function testConnection() {
		if (!validateForm()) {
			return;
		}

		testingConnection = true;
		testResult = null;

		try {
			// Test connection against a user-supplied external URL. Use the
			// global `fetch` (NOT authFetch) so we never leak the user's
			// Keycloak bearer token to an arbitrary third-party host.
			const response = await fetchWithBudget(
				formData.url,
				{
					method: 'GET',
					headers: {
						'Accept': 'application/json'
					}
				},
				{ fetchImpl: fetch }
			);

			if (response.ok) {
				testResult = { success: true, message: 'Connection successful!' };
			} else {
				testResult = { success: false, message: `Connection failed: ${response.status} ${response.statusText}` };
			}
		} catch (err) {
			if (err instanceof BudgetExceededError) {
				testResult = { success: false, message: 'Connection test timed out — check the URL and your network.' };
			} else {
				testResult = { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
			}
		} finally {
			testingConnection = false;
		}
	}

	/**
	 * Close modal
	 */
	function closeModal() {
		showModal = false;
		editingCredential = null;
		resetFormData();
	}

	/**
	 * Open delete confirmation
	 */
	function openDeleteConfirm(credential: URLCredential) {
		deletingCredential = credential;
		showDeleteConfirm = true;
	}

	/**
	 * Close delete confirmation
	 */
	function closeDeleteConfirm() {
		showDeleteConfirm = false;
		deletingCredential = null;
	}

	/**
	 * Delete a credential
	 */
	async function deleteCredential() {
		if (!deletingCredential) return;

		isSubmitting = true;
		error = null;

		try {
			await apiClient.urlCredentials.delete(deletingCredential.credential_id);
			await loadCredentials();
			closeDeleteConfirm();
		} catch (err) {
			if (err instanceof ApiError) {
				error = err.message;
			} else {
				error = 'Failed to delete credential';
			}
			console.error('Error deleting credential:', err);
		} finally {
			isSubmitting = false;
		}
	}

	/**
	 * Format date for display
	 */
	function formatDate(date: string | Date | null | undefined): string {
		if (!date) return 'Never';
		const d = typeof date === 'string' ? new Date(date) : date;
		return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
	}

	/**
	 * Get auth type label
	 */
	function getAuthTypeLabel(type: string): string {
		return authTypes.find(t => t.value === type)?.label || type;
	}

	/**
	 * Add cookie to the cookies object
	 */
	function addCookie() {
		if (formData.cookieKey.trim() && formData.cookieValue.trim()) {
			formData.cookies[formData.cookieKey] = formData.cookieValue;
			formData.cookieKey = '';
			formData.cookieValue = '';
		}
	}

	/**
	 * Remove cookie from the cookies object
	 */
	function removeCookie(key: string) {
		delete formData.cookies[key];
		formData.cookies = { ...formData.cookies };
	}

	/**
	 * Add custom header
	 */
	function addHeader() {
		if (formData.headerKey.trim() && formData.headerValue.trim()) {
			formData.custom_headers[formData.headerKey] = formData.headerValue;
			formData.headerKey = '';
			formData.headerValue = '';
		}
	}

	/**
	 * Remove custom header
	 */
	function removeHeader(key: string) {
		delete formData.custom_headers[key];
		formData.custom_headers = { ...formData.custom_headers };
	}

	/**
	 * Check if credential is expired
	 */
	function isExpired(credential: URLCredential): boolean {
		if (!credential.expires_at) return false;
		return new Date(credential.expires_at) < new Date();
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-[var(--color-text)] dark:text-[var(--color-text)]">BYOC Credentials</h1>
			<p class="mt-2 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Manage Bring Your Own Cloud URL credentials and authentication</p>
		</div>
		<button
			onclick={openCreateModal}
			class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			disabled={isLoading}
		>
			+ Add Credential
		</button>
	</div>

	<!-- Error Alert -->
	{#if error}
		<div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-4 dark:bg-[var(--color-danger-bg)]/20">
			<div class="flex items-center gap-3">
				<span class="text-[var(--color-danger)] text-lg">⚠</span>
				<div class="flex-1">
					<p class="text-[var(--color-danger-text)] font-medium dark:text-[var(--color-danger-text)]">Error</p>
					<p class="text-[var(--color-danger)] text-sm">{error}</p>
				</div>
				<button onclick={() => (error = null)} class="text-[var(--color-danger)] hover:text-[var(--color-danger-text)]">
					<span class="text-xl">×</span>
				</button>
			</div>
		</div>
	{/if}

	<!-- Loading State -->
	{#if isLoading}
		<div class="bg-[var(--color-bg)] rounded-lg shadow p-12 dark:bg-[var(--color-surface)]">
			<div class="flex flex-col items-center justify-center">
				<div class="animate-spin rounded-full h-12 w-12 border-b-2 border-[var(--color-accent)]"></div>
				<p class="mt-4 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Loading credentials...</p>
			</div>
		</div>
	{:else}
		<!-- Credentials List -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]">
			<div class="px-6 py-4 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h2 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Your Credentials ({credentials.length})</h2>
			</div>

			{#if credentials.length === 0}
				<div class="px-6 py-12 text-center">
					<div class="text-6xl mb-4">🔑</div>
					<p class="text-[var(--color-text)] text-lg dark:text-[var(--color-text-muted)]">No credentials yet</p>
					<p class="text-[var(--color-text-muted)] text-sm mt-2 dark:text-[var(--color-text-muted)]">Add your first BYOC credential to get started</p>
				</div>
			{:else}
				<div class="divide-y divide-[var(--color-border)] dark:divide-[var(--color-border-strong)]">
					{#each credentials as credential}
						<div class="px-6 py-4 hover:bg-[var(--color-surface)] transition-colors dark:hover:bg-[var(--color-surface-strong)]">
							<div class="flex items-center justify-between">
								<div class="flex items-center gap-4 flex-1">
									<span class="text-3xl">🔑</span>
									<div class="flex-1">
										<div class="flex items-center gap-3">
											<p class="font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">{credential.identifier}</p>
											{#if isExpired(credential)}
												<span class="px-2 py-1 text-xs font-medium rounded-full bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]">
													Expired
												</span>
											{:else if credential.expires_at}
												<span class="px-2 py-1 text-xs font-medium rounded-full bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]">
													Expires {formatDate(credential.expires_at)}
												</span>
											{:else}
												<span class="px-2 py-1 text-xs font-medium rounded-full bg-[var(--color-success-bg)] text-[var(--color-success-text)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]">
													Active
												</span>
											{/if}
										</div>
										<p class="text-sm text-[var(--color-text)] mt-1 font-mono dark:text-[var(--color-text-muted)]">{credential.url}</p>
										<div class="flex items-center gap-4 mt-2 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
											<span>Created: {formatDate(credential.created_at)}</span>
											<span>Updated: {formatDate(credential.updated_at)}</span>
										</div>
									</div>
								</div>
								<div class="flex gap-2">
									<button
										onclick={() => openEditModal(credential)}
										data-testid="byoc-edit"
										class="px-3 py-1 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-on-primary)] rounded transition-colors"
									>
										Edit
									</button>
									<button
										onclick={() => openDeleteConfirm(credential)}
										class="px-3 py-1 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] rounded transition-colors"
									>
										Delete
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
	<div class="fixed inset-0 bg-[var(--color-bg)] bg-opacity-50 flex items-center justify-center z-50 p-4 overflow-y-auto">
		<div class="bg-[var(--color-bg)] rounded-lg max-w-2xl w-full shadow-xl my-8 dark:bg-[var(--color-surface)]">
			<div class="px-6 py-4 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h3 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">
					{editingCredential ? 'Edit Credential' : 'Create New Credential'}
				</h3>
			</div>

			<form onsubmit={(e) => { e.preventDefault(); submitForm(); }} class="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
				<!-- Identifier -->
				<div>
					<label for="identifier" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
						Identifier <span class="text-[var(--color-danger)]">*</span>
					</label>
					<input
						id="identifier"
						type="text"
						bind:value={formData.identifier}
						class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
						placeholder="e.g., my-api-credentials"
						required
					/>
					{#if formErrors.identifier}
						<p class="text-[var(--color-danger)] text-xs mt-1">{formErrors.identifier}</p>
					{/if}
				</div>

				<!-- URL -->
				<div>
					<label for="url" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
						URL <span class="text-[var(--color-danger)]">*</span>
					</label>
					<input
						id="url"
						type="url"
						bind:value={formData.url}
						class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
						placeholder="https://api.example.com"
						required
					/>
					{#if formErrors.url}
						<p class="text-[var(--color-danger)] text-xs mt-1">{formErrors.url}</p>
					{/if}
				</div>

				<!-- Auth Type -->
				<div>
					<label for="auth_type" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
						Authentication Type <span class="text-[var(--color-danger)]">*</span>
					</label>
					<select
						id="auth_type"
						bind:value={formData.auth_type}
						class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
					>
						{#each authTypes as type}
							<option value={type.value}>{type.label} - {type.description}</option>
						{/each}
					</select>
				</div>

				<!-- Stored-secret hydration state (edit only) -->
				{#if editingCredential && loadingSecrets}
					<p
						data-testid="byoc-secret-loading"
						class="text-[var(--color-text-muted)] text-xs dark:text-[var(--color-text-muted)]"
					>
						Loading the stored credential…
					</p>
				{:else if editingCredential && secretsUnavailable}
					<div
						role="alert"
						data-testid="byoc-secret-unavailable"
						class="bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] rounded-lg p-3 dark:bg-[var(--color-warning-bg)]/20"
					>
						<p class="text-[var(--color-warning-text)] text-xs dark:text-[var(--color-warning-text)]">
							<strong>The stored secret could not be read back.</strong> Saving now will
							REPLACE this credential with whatever you enter below — re-enter it in full,
							or press Cancel to leave the stored one untouched.
						</p>
					</div>
				{/if}

				<!-- Auth-specific fields -->
				<div class="border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] dark:border-[var(--color-border)] dark:bg-[var(--color-bg)]">
					{#if formData.auth_type === 'basic'}
						<!-- Basic Auth -->
						<div class="space-y-3">
							<h4 class="font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">Basic Authentication</h4>
							<div>
								<label for="username" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
									Username <span class="text-[var(--color-danger)]">*</span>
								</label>
								<input
									id="username"
									type="text"
									bind:value={formData.username}
									class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
									placeholder="Enter username"
									required
								/>
							</div>
							<div>
								<label for="password" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
									Password <span class="text-[var(--color-danger)]">*</span>
								</label>
								<input
									id="password"
									type="password"
									bind:value={formData.password}
									class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
									placeholder="Enter password"
									required
								/>
							</div>
						</div>
					{:else if formData.auth_type === 'bearer'}
						<!-- Bearer Token -->
						<div class="space-y-3">
							<h4 class="font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">Bearer Token</h4>
							<div>
								<label for="auth_token" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
									Token <span class="text-[var(--color-danger)]">*</span>
								</label>
								<textarea
									id="auth_token"
									bind:value={formData.auth_token}
									rows="3"
									class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] font-mono text-sm dark:border-[var(--color-border-strong)]"
									placeholder="Enter bearer token (JWT, OAuth token, etc.)"
									required
								></textarea>
							</div>
						</div>
					{:else if formData.auth_type === 'api_key'}
						<!-- API Key -->
						<div class="space-y-3">
							<h4 class="font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">API Key</h4>
							<div>
								<label for="api_key" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
									API Key <span class="text-[var(--color-danger)]">*</span>
								</label>
								<input
									id="api_key"
									type="password"
									bind:value={formData.api_key}
									class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
									placeholder="Enter API key"
									required
								/>
							</div>
							<div>
								<label for="api_key_header" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
									Header Name
								</label>
								<input
									id="api_key_header"
									type="text"
									bind:value={formData.api_key_header}
									class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
									placeholder="X-API-Key"
								/>
							</div>
						</div>
					{:else if formData.auth_type === 'cookie'}
						<!-- Cookies -->
						<div class="space-y-3">
							<h4 class="font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">Cookies</h4>
							<div class="flex gap-2">
								<input
									type="text"
									bind:value={formData.cookieKey}
									class="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
									placeholder="Cookie name"
								/>
								<input
									type="text"
									bind:value={formData.cookieValue}
									class="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
									placeholder="Cookie value"
								/>
								<button
									type="button"
									onclick={addCookie}
									class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)]"
								>
									Add
								</button>
							</div>
							{#if Object.keys(formData.cookies).length > 0}
								<div class="border border-[var(--color-border)] rounded-lg p-3 space-y-2 dark:border-[var(--color-border)]">
									{#each Object.entries(formData.cookies) as [key, value]}
										<div class="flex items-center justify-between bg-[var(--color-bg)] p-2 rounded dark:bg-[var(--color-surface)]">
											<div class="flex-1 font-mono text-sm">
												<span class="font-medium">{key}:</span> {value}
											</div>
											<button
												type="button"
												onclick={() => removeCookie(key)}
												class="text-[var(--color-danger)] hover:text-[var(--color-danger-text)] ml-2"
											>
												Remove
											</button>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{:else if formData.auth_type === 'custom'}
						<!-- Custom Headers -->
						<div class="space-y-3">
							<h4 class="font-medium text-[var(--color-text)] dark:text-[var(--color-text)]">Custom Headers</h4>
							<div class="flex gap-2">
								<input
									type="text"
									bind:value={formData.headerKey}
									class="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
									placeholder="Header name"
								/>
								<input
									type="text"
									bind:value={formData.headerValue}
									class="flex-1 px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
									placeholder="Header value"
								/>
								<button
									type="button"
									onclick={addHeader}
									class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)]"
								>
									Add
								</button>
							</div>
							{#if Object.keys(formData.custom_headers).length > 0}
								<div class="border border-[var(--color-border)] rounded-lg p-3 space-y-2 dark:border-[var(--color-border)]">
									{#each Object.entries(formData.custom_headers) as [key, value]}
										<div class="flex items-center justify-between bg-[var(--color-bg)] p-2 rounded dark:bg-[var(--color-surface)]">
											<div class="flex-1 font-mono text-sm">
												<span class="font-medium">{key}:</span> {value}
											</div>
											<button
												type="button"
												onclick={() => removeHeader(key)}
												class="text-[var(--color-danger)] hover:text-[var(--color-danger-text)] ml-2"
											>
												Remove
											</button>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/if}

					{#if formErrors.auth}
						<p class="text-[var(--color-danger)] text-xs mt-2">{formErrors.auth}</p>
					{/if}
				</div>

				<!-- TTL -->
				<div>
					<label for="ttl" class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">
						Time to Live (seconds)
					</label>
					<input
						id="ttl"
						type="number"
						bind:value={formData.ttl}
						min="0"
						class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
						placeholder="0 = no expiration"
					/>
					<p class="text-[var(--color-text-muted)] text-xs mt-1 dark:text-[var(--color-text-muted)]">Leave as 0 for no expiration</p>
				</div>

				<!-- Test Result -->
				{#if testResult}
					<div class="border rounded-lg p-3 {testResult.success ? 'bg-[var(--color-success-bg)] border-[var(--color-success-border)]' : 'bg-[var(--color-danger-bg)] border-[var(--color-danger-bg)] dark:bg-[var(--color-danger-bg)]/20'}">
						<p class="text-sm {testResult.success ? 'text-[var(--color-success-text)]' : 'text-[var(--color-danger-text)]'}">
							{testResult.message}
						</p>
					</div>
				{/if}

				<!-- Security Note -->
				<div class="bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] rounded-lg p-3 dark:bg-[var(--color-warning-bg)]/20">
					<p class="text-[var(--color-warning-text)] text-xs dark:text-[var(--color-warning-text)]">
						<strong>Security Note:</strong> All credentials are encrypted at rest and transmitted securely over HTTPS.
						Never share these credentials outside of this platform.
					</p>
				</div>
			</form>

			<!-- Actions -->
			<div class="px-6 py-4 bg-[var(--color-surface)] flex gap-3 rounded-b-lg border-t border-[var(--color-border)] dark:bg-[var(--color-bg)] dark:border-[var(--color-border)]">
				<button
					type="button"
					onclick={testConnection}
					disabled={isSubmitting || testingConnection || loadingSecrets}
					class="px-4 py-2 bg-[var(--color-info-bg)] text-[var(--color-info-text)] border border-[var(--color-info-border)] rounded-lg hover:bg-[var(--color-info-border)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{#if testingConnection}
						<span class="flex items-center gap-2">
							<span class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-border)]"></span>
							Testing...
						</span>
					{:else}
						Test Connection
					{/if}
				</button>
				<button
					type="submit"
					onclick={(e) => { e.preventDefault(); submitForm(); }}
					data-testid="byoc-submit"
					disabled={isSubmitting || testingConnection || loadingSecrets}
					class="flex-1 px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{#if isSubmitting}
						<span class="flex items-center justify-center gap-2">
							<span class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-border)]"></span>
							{editingCredential ? 'Updating...' : 'Creating...'}
						</span>
					{:else}
						{editingCredential ? 'Update Credential' : 'Create Credential'}
					{/if}
				</button>
				<button
					type="button"
					onclick={closeModal}
					disabled={isSubmitting || testingConnection}
					class="px-4 py-2 bg-[var(--color-surface-strong)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed dark:bg-[var(--color-surface-strong)] dark:text-[var(--color-text-muted)]"
				>
					Cancel
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Delete Confirmation Modal -->
{#if showDeleteConfirm && deletingCredential}
	<div class="fixed inset-0 bg-[var(--color-bg)] bg-opacity-50 flex items-center justify-center z-50 p-4">
		<div class="bg-[var(--color-bg)] rounded-lg max-w-md w-full shadow-xl dark:bg-[var(--color-surface)]">
			<div class="px-6 py-4 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
				<h3 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Delete Credential</h3>
			</div>

			<div class="px-6 py-4">
				<p class="text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
					Are you sure you want to delete the credential <strong>"{deletingCredential.identifier}"</strong>?
				</p>
				<p class="text-[var(--color-danger)] text-sm mt-2">
					This action cannot be undone. Any services using this credential will lose access.
				</p>
			</div>

			<div class="px-6 py-4 bg-[var(--color-surface)] flex gap-3 rounded-b-lg dark:bg-[var(--color-bg)]">
				<button
					onclick={deleteCredential}
					disabled={isSubmitting}
					class="flex-1 px-4 py-2 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{#if isSubmitting}
						<span class="flex items-center justify-center gap-2">
							<span class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-border)]"></span>
							Deleting...
						</span>
					{:else}
						Delete Credential
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
