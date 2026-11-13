<script lang="ts">
  // GithubQueryConnectorForm.svelte — Spec 2 §2-B
  // Fields: query (required), search_type (required enum), max_results (1-1000),
  //         secret_id (REQUIRED — GitHub token).
  // Mirrors GithubQueryConnectorConfig zod schema.

  import SecretPicker from '$lib/components/ui/SecretPicker.svelte';

  type GithubSearchType = 'issues' | 'pulls' | 'code' | 'repositories';

  type GithubQueryConnectorConfig = {
    kind: 'github_query';
    secret_id: string;
    query: string;
    search_type: GithubSearchType;
    max_results: number;
  };

  type Props = {
    value?: GithubQueryConnectorConfig;
    onChange?: (config: GithubQueryConnectorConfig) => void;
    disabled?: boolean;
  };

  let {
    value = $bindable<GithubQueryConnectorConfig>({
      kind: 'github_query',
      secret_id: '',
      query: '',
      search_type: 'issues',
      max_results: 100,
    }),
    onChange,
    disabled = false,
  }: Props = $props();

  let errors = $state<{
    query?: string;
    secret_id?: string;
    max_results?: string;
  }>({});

  const SEARCH_TYPE_OPTIONS: { value: GithubSearchType; label: string }[] = [
    { value: 'issues', label: 'Issues' },
    { value: 'pulls', label: 'Pull Requests' },
    { value: 'code', label: 'Code' },
    { value: 'repositories', label: 'Repositories' },
  ];

  function emit() {
    onChange?.(value);
  }

  function validateQuery() {
    if (!value.query.trim()) {
      errors.query = 'Query is required';
    } else {
      errors.query = undefined;
    }
  }

  function validateSecret() {
    if (!value.secret_id) {
      errors.secret_id = 'A GitHub token secret is required';
    } else {
      errors.secret_id = undefined;
    }
  }

  function validateMaxResults() {
    const n = value.max_results;
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      errors.max_results = 'Must be an integer between 1 and 1000';
    } else {
      errors.max_results = undefined;
    }
  }

  function onQueryInput(e: Event) {
    value.query = (e.target as HTMLInputElement).value;
    if (errors.query) validateQuery();
    emit();
  }

  function onQueryBlur() {
    validateQuery();
  }

  function onSearchTypeChange(e: Event) {
    value.search_type = (e.target as HTMLSelectElement).value as GithubSearchType;
    emit();
  }

  function onMaxResultsInput(e: Event) {
    value.max_results = parseInt((e.target as HTMLInputElement).value, 10) || 100;
    if (errors.max_results) validateMaxResults();
    emit();
  }

  function onMaxResultsBlur() {
    validateMaxResults();
  }

  function onSecretSelect(id: string | null) {
    value.secret_id = id ?? '';
    if (errors.secret_id) validateSecret();
    emit();
  }

  export function validate(): boolean {
    validateQuery();
    validateSecret();
    validateMaxResults();
    return !errors.query && !errors.secret_id && !errors.max_results;
  }
</script>

<div class="flex flex-col gap-4" data-testid="github-query-connector-form">
  <!-- GitHub Token Secret (required) -->
  <div class="flex flex-col gap-1">
    <p class="text-sm font-medium" id="github-secret-label">
      GitHub Token <span class="text-[var(--color-danger)]">*</span>
    </p>
    <SecretPicker
      value={value.secret_id || null}
      kind="api_key"
      placeholder="Select GitHub token secret…"
      allowCreate={true}
      {disabled}
      onSelect={onSecretSelect}
      data-testid="github-secret-picker"
    />
    {#if errors.secret_id}
      <p class="text-xs text-[var(--color-danger)]" data-testid="github-secret-error">{errors.secret_id}</p>
    {/if}
  </div>

  <!-- Query -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="github-query">
      Search query <span class="text-[var(--color-danger)]">*</span>
    </label>
    <input
      id="github-query"
      type="text"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 {errors.query ? 'border-[var(--color-danger)]' : ''}"
      value={value.query}
      placeholder="repo:owner/repo is:open"
      oninput={onQueryInput}
      onblur={onQueryBlur}
      data-testid="github-query-input"
    />
    {#if errors.query}
      <p class="text-xs text-[var(--color-danger)]" data-testid="github-query-error">{errors.query}</p>
    {/if}
  </div>

  <!-- Search type -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="github-search-type">
      Search type
    </label>
    <select
      id="github-search-type"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
      value={value.search_type}
      onchange={onSearchTypeChange}
      data-testid="github-search-type-select"
    >
      {#each SEARCH_TYPE_OPTIONS as opt}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </div>

  <!-- Max results -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="github-max-results">
      Max results <span class="text-xs text-[var(--color-text-muted,#888)]">(1 – 1000)</span>
    </label>
    <input
      id="github-max-results"
      type="number"
      min="1"
      max="1000"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 {errors.max_results ? 'border-[var(--color-danger)]' : ''}"
      value={value.max_results}
      oninput={onMaxResultsInput}
      onblur={onMaxResultsBlur}
      data-testid="github-max-results-input"
    />
    {#if errors.max_results}
      <p class="text-xs text-[var(--color-danger)]" data-testid="github-max-results-error">{errors.max_results}</p>
    {/if}
  </div>
</div>
