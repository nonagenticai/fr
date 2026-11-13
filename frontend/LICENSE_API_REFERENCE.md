# License Service API Quick Reference

## Import Statements

```typescript
// Service (for direct usage)
import {
  licenseService,
  checkUserLicense,
  validateLicenseOnLogin,
  getCurrentUserLicense,
  isLicenseValid,
  isLicenseExpired,
  isLicenseExpiringSoon,
  getDaysUntilExpiration,
  hasFeature,
  getStatusMessage,
  getTierDisplayName,
  LicenseStatusType,
  LicenseTier,
  type LicenseStatus
} from '$lib/services/license';

// Store (for reactive usage in components)
import { license } from '$lib/stores/license.svelte';

// API helpers
import { licensesApi } from '$lib/services/api';
```

---

## Service Methods

### Check License
```typescript
// Check specific user
const status = await checkUserLicense('user-id');

// Check current authenticated user
const status = await getCurrentUserLicense();
```

### Validate License
```typescript
// Validate on login
const isValid = await validateLicenseOnLogin();
```

### Status Checks
```typescript
const valid = isLicenseValid(status);          // true if active/expiring_soon
const expired = isLicenseExpired(status);      // true if expired
const expiring = isLicenseExpiringSoon(status); // true if < 30 days
const days = getDaysUntilExpiration(status);   // number | null
```

### Feature & Limits
```typescript
const hasFeature = licenseService.hasFeature(status, 'feature-name');
const atLimit = licenseService.hasReachedProjectLimit(status, currentCount);
const remaining = licenseService.getRemainingProjects(status, currentCount);
```

### Display
```typescript
const message = getStatusMessage(status);      // User-friendly message
const tierName = getTierDisplayName(tier);     // "Professional"
```

---

## Store Properties

### State
```typescript
license.status          // LicenseStatus | null
license.isLoading       // boolean
license.error           // string | null
license.lastChecked     // Date | null
```

### Derived
```typescript
license.isValid              // boolean
license.isExpired            // boolean
license.isExpiringSoon       // boolean
license.daysUntilExpiration  // number | null
license.statusMessage        // string
license.tierDisplayName      // string
license.features             // string[]
```

---

## Store Methods

```typescript
// Check license
await license.check();

// Validate on login
const valid = await license.validateOnLogin();

// Feature check
const hasFeature = license.hasFeature('feature-name');

// Limit checks
const atLimit = license.hasReachedProjectLimit(count);
const remaining = license.getRemainingProjects(count);

// Cache control
license.clear();    // Clear cache
await license.refresh(); // Force refresh
```

---

## Types

### LicenseStatus
```typescript
interface LicenseStatus {
  userId: string;
  status: LicenseStatusType;
  tier: LicenseTier;
  expiresAt: string | null;
  issuedAt: string;
  features: string[];
  maxProjects?: number;
  maxUsers?: number;
  customLimits?: Record<string, number>;
  metadata?: Record<string, any>;
}
```

### Enums
```typescript
enum LicenseStatusType {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  EXPIRING_SOON = 'expiring_soon',
  SUSPENDED = 'suspended',
  INVALID = 'invalid',
  NOT_FOUND = 'not_found',
}

enum LicenseTier {
  FREE = 'free',
  BASIC = 'basic',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}
```

---

## Common Patterns

### Login Flow
```svelte
<script lang="ts">
  import { auth } from '$lib/stores/auth.svelte';
  import { license } from '$lib/stores/license.svelte';

  onMount(async () => {
    await auth.initialize();
    if (auth.isAuthenticated) {
      await license.validateOnLogin();
    }
  });
</script>
```

### Feature Gate
```svelte
{#if license.hasFeature('premium-feature')}
  <PremiumComponent />
{:else}
  <UpgradePrompt />
{/if}
```

### Limit Check
```svelte
<script>
  let canCreate = $derived(
    !license.hasReachedProjectLimit(projects.length)
  );
</script>

<button disabled={!canCreate}>
  Create Project
</button>
```

### Status Display
```svelte
{#if license.isExpiringSoon}
  <div class="warning">{license.statusMessage}</div>
{/if}
```

---

## API Endpoints (for Developer A)

### GET /api/v1/licenses/{userId}
Fetch license status for a user.

**Headers:**
```
Authorization: Bearer {token}
```

**Response:**
```json
{
  "userId": "user-123",
  "status": "active",
  "tier": "professional",
  "expiresAt": "2025-12-31T23:59:59Z",
  "issuedAt": "2024-01-01T00:00:00Z",
  "features": ["feature1", "feature2"],
  "maxProjects": 50,
  "maxUsers": 10
}
```

**Status Codes:**
- 200: Success
- 401: Unauthorized
- 403: Forbidden
- 404: Not Found
- 500: Server Error

---

## Configuration

```typescript
// In license.ts
const EXPIRING_SOON_DAYS = 30;           // Warning threshold
private cacheTimeout = 5 * 60 * 1000;    // 5 minutes
```

---

## Troubleshooting

### License not loading?
```typescript
// Check auth
console.log(auth.isAuthenticated, auth.user);

// Force refresh
await license.refresh();

// Check error
console.log(license.error);
```

### Cache not updating?
```typescript
// Clear and reload
license.clear();
await license.check();
```

### API not working?
```typescript
// Test endpoint directly
const response = await licensesApi.get('user-id');
console.log(response);
```
