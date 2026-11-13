# License Validation Service

This document describes the license validation service implementation for the FR frontend application.

## Overview

The license validation service provides a comprehensive solution for managing and validating user licenses in the FR platform. It integrates seamlessly with the existing authentication system (Keycloak) and the unified API client.

## Architecture

### Files Created

1. **`/src/lib/services/license.ts`** - Core license service with business logic
2. **`/src/lib/stores/license.svelte.ts`** - Reactive Svelte 5 runes-based store
3. **`/src/lib/components/LicenseStatus.svelte`** - Example UI component
4. **Updated `/src/lib/services/api.ts`** - Added license API endpoints

## Core Features

### 1. License Service (`license.ts`)

The license service provides the following functionality:

- **`checkUserLicense(userId: string): Promise<LicenseStatus>`** - Check license for a specific user
- **`validateLicenseOnLogin(): Promise<boolean>`** - Validate license during login
- **`getCurrentUserLicense(): Promise<LicenseStatus | null>`** - Get the authenticated user's license
- **`isLicenseValid(status: LicenseStatus): boolean`** - Check if license allows system access
- **`isLicenseExpired(status: LicenseStatus): boolean`** - Check if license is expired
- **`isLicenseExpiringSoon(status: LicenseStatus): boolean`** - Check if license is approaching expiration
- **`getDaysUntilExpiration(status: LicenseStatus): number | null`** - Get days until expiration
- **`hasFeature(status: LicenseStatus, feature: string): boolean`** - Check if feature is enabled
- **`getStatusMessage(status: LicenseStatus): string`** - Get user-friendly status message
- **`getTierDisplayName(tier: LicenseTier): string`** - Get tier display name
- **`hasReachedProjectLimit(status, count): boolean`** - Check project limits
- **`hasReachedUserLimit(status, count): boolean`** - Check user limits
- **`getRemainingProjects(status, count): number | null`** - Get remaining project slots

### 2. License Store (`license.svelte.ts`)

The reactive store provides:

**State Properties:**
- `status` - Current license status
- `isLoading` - Loading state
- `error` - Error message
- `lastChecked` - Last check timestamp

**Derived Properties:**
- `isValid` - Whether license is valid
- `isExpired` - Whether license is expired
- `isExpiringSoon` - Whether license is expiring soon
- `daysUntilExpiration` - Days until expiration
- `statusMessage` - User-friendly message
- `tierDisplayName` - Tier display name
- `features` - Array of enabled features

**Methods:**
- `check()` - Check current user's license
- `validateOnLogin()` - Validate license on login
- `hasFeature(feature)` - Check feature availability
- `hasReachedProjectLimit(count)` - Check project limit
- `getRemainingProjects(count)` - Get remaining projects
- `clear()` - Clear cached data
- `refresh()` - Force refresh license status

## Data Types

### LicenseStatus Interface

```typescript
interface LicenseStatus {
  userId: string;
  status: LicenseStatusType;
  tier: LicenseTier;
  expiresAt: string | null; // ISO date string
  issuedAt: string;
  features: string[];
  maxProjects?: number;
  maxUsers?: number;
  customLimits?: Record<string, number>;
  metadata?: Record<string, any>;
}
```

### LicenseStatusType Enum

```typescript
enum LicenseStatusType {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  EXPIRING_SOON = 'expiring_soon',
  SUSPENDED = 'suspended',
  INVALID = 'invalid',
  NOT_FOUND = 'not_found',
}
```

### LicenseTier Enum

```typescript
enum LicenseTier {
  FREE = 'free',
  BASIC = 'basic',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}
```

## Usage Examples

### Example 1: Basic License Check

```typescript
import { license } from '$lib/stores/license.svelte';

// In a component
onMount(async () => {
  await license.check();

  if (!license.isValid) {
    console.warn('License is not valid:', license.statusMessage);
  }
});
```

### Example 2: Validate on Login

```typescript
import { license } from '$lib/stores/license.svelte';
import { auth } from '$lib/stores/auth.svelte';

async function handleLogin() {
  // After authentication
  await auth.login();

  // Validate license
  const isValid = await license.validateOnLogin();

  if (!isValid) {
    // Handle invalid license (e.g., show warning, redirect)
    alert('Your license is invalid or expired');
  }
}
```

### Example 3: Feature Gating

```typescript
import { license } from '$lib/stores/license.svelte';

// In a component
{#if license.hasFeature('advanced-analytics')}
  <AdvancedAnalytics />
{:else}
  <UpgradePrompt feature="Advanced Analytics" />
{/if}
```

### Example 4: Project Limit Check

```typescript
import { license } from '$lib/stores/license.svelte';

async function createProject() {
  const currentProjectCount = await getProjectCount();

  if (license.hasReachedProjectLimit(currentProjectCount)) {
    alert('You have reached your project limit. Please upgrade your license.');
    return;
  }

  // Proceed with project creation
  await createNewProject();
}
```

### Example 5: Display License Status

```svelte
<script lang="ts">
  import { license } from '$lib/stores/license.svelte';
</script>

<div>
  {#if license.isExpiringSoon}
    <div class="alert alert-warning">
      {license.statusMessage}
    </div>
  {/if}

  <p>License Tier: {license.tierDisplayName}</p>
  <p>Status: {license.status?.status}</p>
  <p>Expires: {license.status?.expiresAt}</p>
</div>
```

### Example 6: Using the Service Directly

```typescript
import {
  licenseService,
  checkUserLicense,
  isLicenseValid
} from '$lib/services/license';

// Check a specific user's license
const status = await checkUserLicense('user-123');

if (isLicenseValid(status)) {
  console.log('License is valid');
}

// Check features
if (licenseService.hasFeature(status, 'api-access')) {
  console.log('API access is enabled');
}

// Get days until expiration
const days = licenseService.getDaysUntilExpiration(status);
if (days && days < 7) {
  console.warn(`License expires in ${days} days`);
}
```

## Integration with Authentication

The license service integrates with the existing Keycloak authentication system:

1. **User ID from Auth**: Gets user ID from `auth.user.id`
2. **Token Authentication**: Uses the same Bearer token for API calls
3. **Login Hook**: Can be called after successful authentication
4. **Logout**: License cache is cleared on logout

### Example: Integration in Layout

```svelte
<script lang="ts">
  import { auth } from '$lib/stores/auth.svelte';
  import { license } from '$lib/stores/license.svelte';
  import { onMount } from 'svelte';

  onMount(async () => {
    // Initialize auth
    await auth.initialize();

    // If authenticated, check license
    if (auth.isAuthenticated) {
      const isValid = await license.validateOnLogin();

      if (!isValid) {
        // Show license warning banner
        showLicenseWarning();
      }
    }
  });
</script>
```

## API Endpoints

The service expects the following API endpoints to be available:

### GET `/api/v1/licenses/{userId}`

Get license status for a user.

**Response:**
```json
{
  "userId": "user-123",
  "status": "active",
  "tier": "professional",
  "expiresAt": "2025-12-31T23:59:59Z",
  "issuedAt": "2024-01-01T00:00:00Z",
  "features": [
    "advanced-analytics",
    "api-access",
    "priority-support"
  ],
  "maxProjects": 50,
  "maxUsers": 10,
  "customLimits": {
    "api_calls_per_day": 10000
  }
}
```

### POST `/api/v1/licenses/{userId}/validate` (Optional)

Validate a user's license.

**Response:**
```json
{
  "valid": true,
  "status": "active"
}
```

### POST `/api/v1/licenses/{userId}/refresh` (Optional)

Refresh license data from the license server.

## Caching Strategy

- **Cache Duration**: 5 minutes
- **Cache Key**: User ID
- **Cache Invalidation**: On logout, manual refresh, or cache timeout
- **Force Refresh**: Use `license.refresh()` or `licenseService.clearCache()`

## Error Handling

The service handles errors gracefully:

1. **Network Errors**: Returns invalid license status
2. **API Errors**: Logs error and returns invalid status
3. **Authentication Errors**: Checks if user is authenticated before making requests
4. **Cache**: Uses cached data when API is unavailable (within cache timeout)

## Configuration

Key configuration values in the service:

- **EXPIRING_SOON_DAYS**: 30 days (warning threshold)
- **CACHE_TIMEOUT**: 5 minutes (300000ms)

To modify:

```typescript
// In license.ts
const EXPIRING_SOON_DAYS = 30; // Change as needed
private cacheTimeout = 5 * 60 * 1000; // Change as needed
```

## Testing

Example test scenarios:

```typescript
import { licenseService, LicenseStatusType, LicenseTier } from '$lib/services/license';

// Mock license status
const mockStatus = {
  userId: 'test-user',
  status: LicenseStatusType.ACTIVE,
  tier: LicenseTier.PROFESSIONAL,
  expiresAt: '2025-12-31T23:59:59Z',
  issuedAt: '2024-01-01T00:00:00Z',
  features: ['feature1', 'feature2'],
  maxProjects: 50
};

// Test validity
console.assert(licenseService.isLicenseValid(mockStatus) === true);

// Test features
console.assert(licenseService.hasFeature(mockStatus, 'feature1') === true);
console.assert(licenseService.hasFeature(mockStatus, 'feature3') === false);

// Test project limits
console.assert(licenseService.hasReachedProjectLimit(mockStatus, 50) === true);
console.assert(licenseService.hasReachedProjectLimit(mockStatus, 49) === false);
```

## Notes for Developer A (API Integration)

The license service is designed to work with a unified API client. Key integration points:

1. **API Endpoint**: Expects `/api/v1/licenses/{userId}` to be implemented
2. **Response Format**: Should match the `LicenseStatus` interface
3. **Authentication**: Uses Bearer token from Keycloak (automatically handled by API client)
4. **Error Responses**: Should return appropriate HTTP status codes (401, 403, 404, etc.)

### Recommended Backend Response

```typescript
// Backend should return this structure
{
  userId: string;
  status: 'active' | 'expired' | 'expiring_soon' | 'suspended' | 'invalid' | 'not_found';
  tier: 'free' | 'basic' | 'professional' | 'enterprise';
  expiresAt: string | null; // ISO 8601 format
  issuedAt: string; // ISO 8601 format
  features: string[];
  maxProjects?: number;
  maxUsers?: number;
  customLimits?: Record<string, number>;
  metadata?: Record<string, any>;
}
```

## Future Enhancements

Potential improvements:

1. **WebSocket Updates**: Real-time license status updates
2. **Grace Period**: Allow limited functionality after expiration
3. **License Renewal**: In-app license renewal flow
4. **Usage Analytics**: Track feature usage against license limits
5. **Multi-tenant Support**: Organization-level licenses
6. **License Pooling**: Shared license pools for teams
7. **Offline Mode**: Cached license validation when offline

## Troubleshooting

### License Check Fails

1. Verify user is authenticated
2. Check API endpoint is available
3. Verify Bearer token is valid
4. Check CORS settings if running locally

### Cache Not Updating

1. Use `license.refresh()` to force update
2. Check cache timeout settings
3. Verify API is returning new data

### Features Not Available

1. Check license status and tier
2. Verify feature name matches backend
3. Check if license is valid and not expired
