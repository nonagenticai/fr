# License Guard Usage Guide

The license guard system provides comprehensive protection for routes and features based on user license status.

## Overview

The license guard checks:
- License validity (active vs expired)
- License expiration countdown
- Required features for specific functionality
- License tier requirements (free, pro, enterprise)

## Auto-refresh

License status is automatically refreshed every 15 minutes to ensure up-to-date validation.

## Usage Examples

### 1. Protecting a Route

**In a +page.svelte component:**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { licenseGuard } from '$lib/guards/license-guard';

  onMount(async () => {
    // Redirect to upgrade page if license is invalid
    await licenseGuard({
      redirectOnFail: '/license-upgrade'
    });
  });
</script>
```

### 2. Requiring a Specific Feature

**Check if user has access to a premium feature:**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { licenseGuard, showUpgradeModal } from '$lib/guards/license-guard';

  onMount(async () => {
    const canAccess = await licenseGuard({
      requiredFeature: 'advanced-analytics',
      onUpgradeRequired: () => {
        showUpgradeModal({ feature: 'advanced-analytics' });
      }
    });

    if (!canAccess) {
      console.log('User does not have access to advanced analytics');
    }
  });
</script>
```

### 3. Requiring a Minimum License Tier

**Protect routes that require Pro or Enterprise:**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { licenseGuard } from '$lib/guards/license-guard';

  onMount(async () => {
    await licenseGuard({
      requiredTier: 'pro',
      redirectOnFail: '/license-upgrade?tier=pro'
    });
  });
</script>
```

### 4. Conditional Rendering Based on License

**Show/hide UI elements based on license:**

```svelte
<script lang="ts">
  import { auth } from '$lib/stores/auth.svelte';
  import { hasLicenseFeature, hasLicenseTier } from '$lib/guards/license-guard';
</script>

<!-- Show feature only if license includes it -->
{#if hasLicenseFeature('advanced-analytics')}
  <AdvancedAnalyticsPanel />
{:else}
  <button onclick={() => goto('/license-upgrade?feature=advanced-analytics')}>
    Upgrade to unlock Advanced Analytics
  </button>
{/if}

<!-- Show feature only for Pro+ users -->
{#if hasLicenseTier('pro')}
  <TeamCollaboration />
{/if}

<!-- Show license expiration warning -->
{#if auth.licenseStatus.isExpiringSoon}
  <div class="bg-yellow-50 border border-yellow-200 rounded p-4 mb-4">
    <p class="text-yellow-800">
      Your license expires in {auth.licenseStatus.daysRemaining} days.
      <a href="/license-upgrade" class="underline">Renew now</a>
    </p>
  </div>
{/if}
```

### 5. Using in Load Functions

**In a +page.ts or +layout.ts:**

```typescript
import { redirect } from '@sveltejs/kit';
import { licenseGuard } from '$lib/guards/license-guard';
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
  const canAccess = await licenseGuard({
    requiredFeature: 'advanced-analytics',
    redirectOnFail: null // Don't auto-redirect
  });

  if (!canAccess) {
    throw redirect(302, '/license-upgrade?feature=advanced-analytics');
  }

  return {
    // Your page data
  };
};
```

### 6. Multiple Feature Checks

**Check multiple features at once:**

```svelte
<script lang="ts">
  import { hasAllFeatures, hasAnyFeature } from '$lib/guards/license-guard';

  // Check if user has ALL required features
  $: hasFullAccess = hasAllFeatures([
    'advanced-analytics',
    'team-collaboration',
    'custom-integrations'
  ]);

  // Check if user has ANY of the features
  $: hasPartialAccess = hasAnyFeature([
    'advanced-analytics',
    'team-collaboration'
  ]);
</script>

{#if hasFullAccess}
  <FullFeaturedDashboard />
{:else if hasPartialAccess}
  <PartialFeaturedDashboard />
{:else}
  <BasicDashboard />
{/if}
```

### 7. Custom Upgrade Handler

**Handle upgrade flow with custom logic:**

```svelte
<script lang="ts">
  import { licenseGuard } from '$lib/guards/license-guard';

  async function accessPremiumFeature() {
    const canAccess = await licenseGuard({
      requiredFeature: 'premium-exports',
      onUpgradeRequired: () => {
        // Custom handler
        showCustomModal({
          title: 'Upgrade Required',
          message: 'Premium exports require a Pro license',
          ctaText: 'Upgrade to Pro',
          ctaLink: '/license-upgrade?tier=pro'
        });
      }
    });

    if (canAccess) {
      // Execute premium feature
      performPremiumExport();
    }
  }
</script>
```

## License Status Properties

Access license status directly from the auth store:

```typescript
import { auth } from '$lib/stores/auth.svelte';

// Check license validity
auth.licenseStatus.isValid // boolean

// Days remaining until expiration
auth.licenseStatus.daysRemaining // number

// Check if expiring soon (< 7 days)
auth.licenseStatus.isExpiringSoon // boolean

// Check if upgrade required
auth.licenseStatus.requiresUpgrade // boolean

// Access full license object
auth.license // License | null

// Check user permissions
auth.hasPermission('manage_users') // boolean (derived)

// Check license features
auth.hasFeature('advanced-analytics') // boolean (derived)
```

## Helper Functions

### hasValidLicense()
Returns true if the user has a valid, non-expired license.

### hasLicenseFeature(feature: string)
Returns true if the license includes the specified feature.

### hasLicenseTier(tier: 'free' | 'pro' | 'enterprise')
Returns true if the license meets or exceeds the specified tier.

### hasAllFeatures(features: string[])
Returns true if all specified features are available.

### hasAnyFeature(features: string[])
Returns true if at least one of the specified features is available.

### showUpgradeModal(context?)
Shows the upgrade modal/page with optional context (feature or tier).

## Best Practices

1. **Always check license before expensive operations**: Validate license before initiating long-running tasks or API calls.

2. **Provide clear upgrade paths**: When blocking a feature, always show users how to upgrade.

3. **Use derived state for reactive UI**: Leverage Svelte's reactivity with `auth.licenseStatus` for automatic updates.

4. **Handle edge cases**: Account for users without licenses, expired licenses, and network failures.

5. **Test expiration warnings**: Ensure expiration warnings appear at the right time (7 days before expiration).

6. **Don't trust client-side only**: Always validate license on the backend for critical operations.

## License Validation Flow

```
User Login
    ↓
Keycloak Authentication
    ↓
Fetch User Details (GET /api/auth/me)
    ↓
Fetch License (GET /api/license/status)
    ↓
Store in Auth Store
    ↓
Auto-refresh every 15 minutes
    ↓
License Guards Check Status
    ↓
Allow/Deny Access
```

## Testing

To test the license guard functionality:

1. Test with expired license
2. Test with different license tiers
3. Test feature requirements
4. Test auto-refresh (wait 15+ minutes)
5. Test expiration warnings (< 7 days)
6. Test without license

## Support

For issues or questions about license validation, contact the development team.
