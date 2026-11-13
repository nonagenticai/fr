# UI/UX Components Documentation

This document describes the reusable loading skeleton and error handling components available in the FR frontend.

## Loading Skeleton Components

### ProjectCardSkeleton.svelte

A reusable loading skeleton for project and workflow card layouts.

**Props:**
- `count` (number, default: 1): Number of skeleton cards to render
- `cols` (string, default: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"): Grid column configuration

**Usage:**
```svelte
<script>
  import ProjectCardSkeleton from '$lib/components/ProjectCardSkeleton.svelte';
</script>

{#if loading}
  <ProjectCardSkeleton count={6} />
{:else}
  <!-- Your content here -->
{/if}
```

**Example with custom grid:**
```svelte
<ProjectCardSkeleton count={4} cols="grid-cols-1 md:grid-cols-2" />
```

---

### TableRowSkeleton.svelte

A reusable loading skeleton for table row layouts.

**Props:**
- `rows` (number, default: 5): Number of skeleton rows to render
- `columns` (number, default: 4): Number of columns per row
- `showHeader` (boolean, default: false): Whether to show a header skeleton

**Usage:**
```svelte
<script>
  import TableRowSkeleton from '$lib/components/TableRowSkeleton.svelte';
</script>

{#if loading}
  <TableRowSkeleton rows={8} columns={5} showHeader={true} />
{:else}
  <!-- Your table content here -->
{/if}
```

---

### StatCardSkeleton.svelte

A reusable loading skeleton for dashboard stat cards.

**Props:**
- `count` (number, default: 3): Number of skeleton cards to render
- `cols` (string, default: "grid-cols-1 md:grid-cols-3"): Grid column configuration

**Usage:**
```svelte
<script>
  import StatCardSkeleton from '$lib/components/StatCardSkeleton.svelte';
</script>

{#if loading}
  <StatCardSkeleton count={5} cols="grid-cols-1 md:grid-cols-2 lg:grid-cols-5" />
{:else}
  <!-- Your stat cards here -->
{/if}
```

---

## Error Handling Components

### ErrorMessage.svelte

A reusable error message component with customizable styling and actions.

**Props:**
- `title` (string, default: "Error"): Error title
- `message` (string, required): Error message to display
- `dismissible` (boolean, default: true): Whether the error can be dismissed
- `onDismiss` (function, optional): Callback when error is dismissed
- `onRetry` (function, optional): Optional retry callback - shows retry button if provided
- `type` ("error" | "warning" | "info", default: "error"): Error severity type

**Usage:**
```svelte
<script>
  import ErrorMessage from '$lib/components/ErrorMessage.svelte';

  let error = $state<string | null>(null);

  async function loadData() {
    try {
      // ... load data
    } catch (e) {
      error = e.message;
    }
  }
</script>

{#if error}
  <ErrorMessage
    message={error}
    onDismiss={() => error = null}
    onRetry={loadData}
  />
{/if}
```

**Warning Example:**
```svelte
<ErrorMessage
  type="warning"
  title="Warning"
  message="Your session is about to expire"
  dismissible={false}
/>
```

---

### ErrorBoundary.svelte

A wrapper component to catch and handle errors gracefully with retry and error reporting functionality.

**Props:**
- `fallback` (snippet, optional): Custom error fallback component
- `onError` (function, optional): Callback when error occurs
- `onRetry` (function, required): Callback for retry action
- `showReportOption` (boolean, default: true): Whether to show "Report Error" button
- `errorTitle` (string, default: "Something went wrong"): Custom error title

**Usage:**
```svelte
<script>
  import ErrorBoundary from '$lib/components/ErrorBoundary.svelte';

  let error = $state<Error | null>(null);

  async function loadData() {
    try {
      const data = await apiClient.getData();
      // ... process data
      error = null; // Clear error on success
    } catch (e) {
      error = e as Error;
    }
  }

  onMount(() => {
    loadData();
  });
</script>

<ErrorBoundary
  {error}
  onRetry={loadData}
  onError={(e) => console.error('Error occurred:', e)}
>
  <!-- Your content here -->
  {#if data}
    <div>Your content</div>
  {/if}
</ErrorBoundary>
```

**Custom Fallback Example:**
```svelte
<ErrorBoundary
  {error}
  onRetry={loadData}
  showReportOption={false}
>
  {#snippet fallback(error, retry)}
    <div class="custom-error">
      <h2>Oops! {error.message}</h2>
      <button onclick={retry}>Try again</button>
    </div>
  {/snippet}

  <!-- Your content -->
  <YourComponent />
</ErrorBoundary>
```

---

## Complete Page Example

Here's a complete example showing how to use all components together:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { apiClient } from '$lib/api/unified-client';
  import ProjectCardSkeleton from '$lib/components/ProjectCardSkeleton.svelte';
  import StatCardSkeleton from '$lib/components/StatCardSkeleton.svelte';
  import ErrorMessage from '$lib/components/ErrorMessage.svelte';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let stats = $state([]);
  let projects = $state([]);

  async function loadData() {
    loading = true;
    error = null;

    try {
      const [statsData, projectsData] = await Promise.all([
        apiClient.stats.list(),
        apiClient.projects.list()
      ]);

      stats = statsData.items;
      projects = projectsData.items;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadData();
  });
</script>

<div class="space-y-6">
  <h1 class="text-3xl font-bold">Dashboard</h1>

  <!-- Error Display -->
  {#if error}
    <ErrorMessage
      message={error}
      onDismiss={() => error = null}
      onRetry={loadData}
    />
  {/if}

  <!-- Stats Section -->
  {#if loading}
    <StatCardSkeleton count={5} cols="grid-cols-1 md:grid-cols-2 lg:grid-cols-5" />
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
      {#each stats as stat}
        <div class="bg-white rounded-lg shadow p-6">
          <!-- Stat content -->
        </div>
      {/each}
    </div>
  {/if}

  <!-- Projects Section -->
  {#if loading}
    <ProjectCardSkeleton count={6} />
  {:else if projects.length === 0}
    <div class="text-center py-12">
      <p class="text-gray-500">No projects found</p>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {#each projects as project}
        <div class="bg-white rounded-lg shadow p-6">
          <!-- Project card content -->
        </div>
      {/each}
    </div>
  {/if}
</div>
```

---

## Design Guidelines

### Skeleton Loading States

1. **Use skeletons for perceived performance**: Show skeletons immediately while data loads
2. **Match the layout**: Skeletons should closely match the final content layout
3. **Consistent animations**: All skeletons use the `animate-pulse` class for consistency
4. **Appropriate counts**: Show realistic numbers of skeleton items based on typical data

### Error Handling

1. **Be specific**: Provide clear, actionable error messages
2. **Offer solutions**: Always include a retry option when applicable
3. **Graceful degradation**: Use ErrorBoundary to prevent entire page crashes
4. **User feedback**: Show what went wrong and how to fix it

### Accessibility

- All error messages include proper ARIA labels
- Skeleton states are marked with `aria-busy="true"` (handled by parent components)
- Error icons use semantic SVG markup
- All interactive elements are keyboard accessible

---

## Migration Guide

### Replacing Inline Skeletons

If you have inline skeleton code like this:

```svelte
{#if loading}
  <div class="grid grid-cols-3 gap-6">
    {#each Array(6) as _}
      <div class="bg-white rounded-lg shadow p-6 animate-pulse">
        <div class="w-8 h-8 bg-gray-200 rounded"></div>
        <div class="h-6 bg-gray-200 rounded mb-2"></div>
        <!-- ... more skeleton markup -->
      </div>
    {/each}
  </div>
{/if}
```

Replace it with:

```svelte
{#if loading}
  <ProjectCardSkeleton count={6} />
{/if}
```

### Replacing Inline Errors

If you have inline error handling like this:

```svelte
{#if error}
  <div class="bg-red-50 border border-red-200 p-4">
    <p class="text-red-800">{error}</p>
  </div>
{/if}
```

Replace it with:

```svelte
{#if error}
  <ErrorMessage
    message={error}
    onDismiss={() => error = null}
    onRetry={loadData}
  />
{/if}
```

---

## Best Practices

1. **Always provide a retry mechanism**: Users should be able to retry failed operations
2. **Use appropriate skeleton counts**: Don't show 100 skeleton cards if you typically display 10
3. **Handle edge cases**: Consider empty states, network failures, and timeouts
4. **Provide feedback**: Use loading states and error messages consistently
5. **Test error scenarios**: Simulate failures to ensure error handling works correctly

---

## Future Enhancements

Potential improvements for these components:

- Add skeleton variants (compact, detailed)
- Support for custom skeleton shapes
- Internationalization (i18n) support for error messages
- Integration with analytics/error tracking services
- Animated transitions between loading and loaded states
- A11y improvements with screen reader announcements
