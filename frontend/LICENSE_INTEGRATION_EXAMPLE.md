# License Service Integration Example

This document provides practical examples of integrating the license validation service into the FR frontend application.

## Integration Points

### 1. Login Flow Integration

Update the login page to validate license after authentication:

```svelte
<!-- /src/routes/login/+page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { license } from '$lib/stores/license.svelte';

  let error = $state<string | null>(null);
  let licenseWarning = $state<string | null>(null);

  onMount(async () => {
    const checkAuth = async () => {
      if (auth.isLoading) {
        setTimeout(checkAuth, 100);
        return;
      }

      if (auth.isAuthenticated) {
        // Validate license after authentication
        const isValid = await license.validateOnLogin();

        if (!isValid) {
          // License is invalid but allow limited access
          licenseWarning = 'Your license is invalid or expired. Some features may be unavailable.';
          // Still redirect but show warning
          goto('/projects');
        } else if (license.isExpiringSoon) {
          // License is expiring soon
          licenseWarning = license.statusMessage;
          goto('/projects');
        } else {
          // All good
          goto('/projects');
        }
      } else {
        auth.login().catch((err) => {
          error = 'Failed to login. Please try again.';
        });
      }
    };

    checkAuth();
  });
</script>

<!-- UI with license warning -->
{#if licenseWarning}
  <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
    <p class="text-yellow-800">{licenseWarning}</p>
  </div>
{/if}
```

### 2. Layout Integration

Add license check to the main layout:

```svelte
<!-- /src/routes/+layout.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import '../app.css';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Header from '$lib/components/Header.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { license } from '$lib/stores/license.svelte';

  let { children } = $props();
  const publicRoutes = ['/login', '/'];

  onMount(async () => {
    // Initialize authentication
    await auth.initialize();

    // Check license if authenticated
    if (auth.isAuthenticated) {
      await license.check();

      // Log license status
      if (license.isExpiringSoon) {
        console.warn('License expiring soon:', license.statusMessage);
      }
    }
  });

  // React to auth changes
  $effect(() => {
    if (!auth.isLoading) {
      const currentPath = $page.url.pathname;
      const isPublicRoute = publicRoutes.includes(currentPath);

      if (!auth.isAuthenticated && !isPublicRoute) {
        goto('/login');
      }

      if (auth.isAuthenticated && currentPath === '/login') {
        goto('/projects');
      }
    }
  });
</script>

<!-- Show license warning banner if expiring soon -->
{#if auth.isAuthenticated && license.isExpiringSoon}
  <div class="fixed top-0 left-0 right-0 z-50 bg-yellow-500 text-white px-4 py-2 text-center">
    <strong>Warning:</strong> {license.statusMessage}
    <a href="/settings/license" class="underline ml-2">Renew Now</a>
  </div>
{/if}

<!-- Rest of layout -->
```

### 3. Header Component Integration

Add license status to the header:

```svelte
<!-- /src/lib/components/Header.svelte -->
<script lang="ts">
  import { auth } from '$lib/stores/auth.svelte';
  import { license } from '$lib/stores/license.svelte';

  let showLicenseMenu = $state(false);
</script>

<header class="bg-white border-b border-gray-200 px-6 py-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">FR Platform</h1>

    <div class="flex items-center space-x-4">
      <!-- License Status Badge -->
      {#if license.status}
        <div class="relative">
          <button
            onclick={() => showLicenseMenu = !showLicenseMenu}
            class="flex items-center space-x-2 px-3 py-1 rounded-lg hover:bg-gray-100"
          >
            <span class="text-sm text-gray-600">License:</span>
            <span class="text-sm font-semibold {license.isValid ? 'text-green-600' : 'text-red-600'}">
              {license.tierDisplayName}
            </span>
            {#if license.isExpiringSoon}
              <span class="flex h-2 w-2">
                <span class="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-yellow-400 opacity-75"></span>
                <span class="relative inline-flex rounded-full h-2 w-2 bg-yellow-500"></span>
              </span>
            {/if}
          </button>

          {#if showLicenseMenu}
            <div class="absolute right-0 mt-2 w-64 bg-white rounded-lg shadow-lg border border-gray-200 p-4">
              <p class="text-sm text-gray-600 mb-2">{license.statusMessage}</p>
              {#if license.daysUntilExpiration}
                <p class="text-xs text-gray-500">
                  Expires in {license.daysUntilExpiration} days
                </p>
              {/if}
              <a
                href="/settings/license"
                class="block mt-3 text-center px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
              >
                View Details
              </a>
            </div>
          {/if}
        </div>
      {/if}

      <!-- User menu -->
      <div class="flex items-center space-x-3">
        <span class="text-sm text-gray-700">{auth.user?.name}</span>
        <button
          onclick={() => auth.logout()}
          class="px-4 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded"
        >
          Logout
        </button>
      </div>
    </div>
  </div>
</header>
```

### 4. Feature Gating Example

Protect features based on license:

```svelte
<!-- Example: /src/routes/projects/+page.svelte -->
<script lang="ts">
  import { license } from '$lib/stores/license.svelte';
  import { onMount } from 'svelte';

  let projects = $state([]);
  let canCreateProject = $derived(
    license.status ? !license.hasReachedProjectLimit(projects.length) : false
  );

  onMount(async () => {
    // Load projects
    projects = await loadProjects();

    // Check license
    await license.check();
  });

  async function createProject() {
    if (!canCreateProject) {
      alert(`You've reached your project limit (${license.status?.maxProjects}). Please upgrade your license.`);
      return;
    }

    // Create project
    await createNewProject();
  }
</script>

<div>
  <div class="flex justify-between items-center mb-6">
    <h1 class="text-2xl font-bold">Projects</h1>

    <button
      onclick={createProject}
      disabled={!canCreateProject}
      class="px-4 py-2 bg-blue-600 text-white rounded disabled:bg-gray-400 disabled:cursor-not-allowed"
    >
      Create Project
    </button>
  </div>

  <!-- Show limit warning -->
  {#if license.status?.maxProjects}
    <div class="mb-4 p-3 bg-blue-50 rounded-lg">
      <p class="text-sm text-blue-800">
        Projects: {projects.length} / {license.status.maxProjects}
        {#if canCreateProject}
          <span class="text-green-600">
            ({license.getRemainingProjects(projects.length)} remaining)
          </span>
        {:else}
          <span class="text-red-600">
            (Limit reached)
          </span>
        {/if}
      </p>
    </div>
  {/if}

  <!-- Project list -->
  <!-- ... -->
</div>
```

### 5. Advanced Feature Access Control

```svelte
<!-- Example: Advanced analytics feature -->
<script lang="ts">
  import { license } from '$lib/stores/license.svelte';

  const hasAdvancedAnalytics = $derived(
    license.hasFeature('advanced-analytics')
  );

  const hasApiAccess = $derived(
    license.hasFeature('api-access')
  );
</script>

<div class="space-y-6">
  <!-- Basic analytics (always available) -->
  <section>
    <h2 class="text-xl font-bold mb-4">Basic Analytics</h2>
    <BasicAnalyticsDashboard />
  </section>

  <!-- Advanced analytics (feature-gated) -->
  {#if hasAdvancedAnalytics}
    <section>
      <h2 class="text-xl font-bold mb-4">Advanced Analytics</h2>
      <AdvancedAnalyticsDashboard />
    </section>
  {:else}
    <section class="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
      <h3 class="text-lg font-semibold mb-2">Advanced Analytics</h3>
      <p class="text-gray-600 mb-4">
        Unlock advanced analytics with a Professional or Enterprise license.
      </p>
      <a
        href="/upgrade"
        class="inline-block px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
      >
        Upgrade License
      </a>
    </section>
  {/if}

  <!-- API Access -->
  {#if hasApiAccess}
    <section>
      <h2 class="text-xl font-bold mb-4">API Credentials</h2>
      <ApiKeyManager />
    </section>
  {/if}
</div>
```

### 6. License Settings Page

Create a dedicated license management page:

```svelte
<!-- /src/routes/settings/license/+page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { license } from '$lib/stores/license.svelte';
  import LicenseStatus from '$lib/components/LicenseStatus.svelte';

  onMount(async () => {
    await license.check();
  });
</script>

<div class="max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold mb-8">License Management</h1>

  <div class="grid grid-cols-1 gap-6">
    <!-- License Status Component -->
    <LicenseStatus />

    <!-- Upgrade Options -->
    {#if license.status?.tier !== 'enterprise'}
      <div class="bg-white rounded-lg shadow p-6">
        <h2 class="text-2xl font-bold mb-4">Upgrade Your License</h2>

        <div class="grid grid-cols-3 gap-4">
          <!-- Basic Tier -->
          <div class="border rounded-lg p-4">
            <h3 class="text-lg font-semibold mb-2">Basic</h3>
            <p class="text-2xl font-bold mb-4">$29/mo</p>
            <ul class="text-sm space-y-2 mb-4">
              <li>✓ 10 Projects</li>
              <li>✓ 5 Users</li>
              <li>✓ Basic Support</li>
            </ul>
            <button class="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
              Upgrade
            </button>
          </div>

          <!-- Professional Tier -->
          <div class="border-2 border-blue-600 rounded-lg p-4">
            <div class="bg-blue-600 text-white text-xs px-2 py-1 rounded mb-2 inline-block">
              RECOMMENDED
            </div>
            <h3 class="text-lg font-semibold mb-2">Professional</h3>
            <p class="text-2xl font-bold mb-4">$99/mo</p>
            <ul class="text-sm space-y-2 mb-4">
              <li>✓ 50 Projects</li>
              <li>✓ 20 Users</li>
              <li>✓ Advanced Analytics</li>
              <li>✓ API Access</li>
              <li>✓ Priority Support</li>
            </ul>
            <button class="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
              Upgrade
            </button>
          </div>

          <!-- Enterprise Tier -->
          <div class="border rounded-lg p-4">
            <h3 class="text-lg font-semibold mb-2">Enterprise</h3>
            <p class="text-2xl font-bold mb-4">Custom</p>
            <ul class="text-sm space-y-2 mb-4">
              <li>✓ Unlimited Projects</li>
              <li>✓ Unlimited Users</li>
              <li>✓ All Features</li>
              <li>✓ 24/7 Support</li>
              <li>✓ Custom Integration</li>
            </ul>
            <button class="w-full px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700">
              Contact Sales
            </button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
```

### 7. Middleware for Route Protection

Create a license-aware navigation guard:

```typescript
// /src/lib/utils/licenseGuard.ts
import { license } from '$lib/stores/license.svelte';
import { goto } from '$app/navigation';

export async function requireValidLicense() {
  const status = await license.getCurrentUserLicense();

  if (!status || !license.isValid) {
    // Redirect to license warning page
    goto('/license-expired');
    return false;
  }

  return true;
}

export async function requireFeature(feature: string) {
  const status = await license.getCurrentUserLicense();

  if (!status || !license.hasFeature(feature)) {
    goto('/upgrade');
    return false;
  }

  return true;
}
```

Use in route:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { requireFeature } from '$lib/utils/licenseGuard';

  onMount(async () => {
    // Require advanced analytics feature
    const allowed = await requireFeature('advanced-analytics');
    if (!allowed) return; // Will redirect to upgrade page

    // Load analytics data
    loadAnalytics();
  });
</script>
```

## Complete Integration Checklist

- [ ] Add license check to login flow
- [ ] Add license status to main layout
- [ ] Add license badge to header
- [ ] Create license settings page
- [ ] Implement feature gating for premium features
- [ ] Add project/user limit checks
- [ ] Show license expiration warnings
- [ ] Handle expired licenses gracefully
- [ ] Add upgrade prompts
- [ ] Test all license states (active, expiring, expired, invalid)

## Testing Different License States

For testing, you can mock different license states:

```typescript
// Mock different license scenarios
import { license } from '$lib/stores/license.svelte';

// Mock active license
license.status = {
  userId: 'test-user',
  status: 'active',
  tier: 'professional',
  expiresAt: '2025-12-31T23:59:59Z',
  issuedAt: '2024-01-01T00:00:00Z',
  features: ['advanced-analytics', 'api-access'],
  maxProjects: 50,
  maxUsers: 20
};

// Mock expiring soon license
license.status = {
  ...license.status,
  status: 'expiring_soon',
  expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString() // 15 days from now
};

// Mock expired license
license.status = {
  ...license.status,
  status: 'expired',
  expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() // Yesterday
};
```

## Best Practices

1. **Check license early**: Validate on login and cache the result
2. **Graceful degradation**: Allow limited functionality even with expired license
3. **Clear communication**: Show clear messages about license status
4. **Proactive warnings**: Warn users before license expires
5. **Feature gating**: Use feature flags from license, not hardcoded checks
6. **Limit enforcement**: Check limits before operations, not during
7. **Cache management**: Use cached status but allow manual refresh
8. **Error handling**: Handle API errors gracefully with fallbacks
