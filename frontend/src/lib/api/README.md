# Unified API Client Documentation

This document provides comprehensive documentation for the FR Frontend Unified API Client.

## Overview

The Unified API Client is a production-ready, type-safe client for interacting with the FR backend API. It replaces both `/src/lib/api/client.ts` and `/src/lib/services/api.ts` with a single, comprehensive solution.

## Key Features

- **TypeScript Generics**: Full type safety for all API calls
- **Singleton Pattern**: Single instance shared across the application
- **Keycloak Authentication**: Automatic Bearer token injection from Keycloak
- **Error Handling**: Standardized `ApiError` class with detailed error information
- **Request/Response Interceptors**: Customize requests and responses
- **Automatic 401 Redirect**: Redirects to login on unauthorized requests
- **Loading State Management**: Track API loading states
- **Timeout Handling**: Configurable request timeouts (default: 30s)
- **Query Parameters**: Type-safe query parameter handling
- **File Uploads**: Support for multipart/form-data uploads

## Installation

The API client is already set up. Simply import it:

```typescript
import { apiClient } from '$lib/api/unified-client';
// or
import apiClient from '$lib/api/unified-client';
```

## Basic Usage

### Projects

```typescript
import { apiClient } from '$lib/api/unified-client';

// List all projects
const projects = await apiClient.projects.list();
console.log(projects.projects); // Array of Project objects

// Get a single project
const project = await apiClient.projects.get('project-id');

// Create a new project
const newProject = await apiClient.projects.create({
  name: 'My Project',
  repository_url: 'https://github.com/user/repo',
  branch: 'main'
});

// (No update: a project's name, description and every other field are owned
// by requirements_management after creation — PATCH /api/projects/:id answers
// 422 rm_owned_field, and apiClient.projects has no `patch`.)

// Delete a project (soft delete - archives it)
await apiClient.projects.delete('project-id');

// Get project status
const status = await apiClient.projects.getStatus('project-id');

// Get project metrics
const metrics = await apiClient.projects.getMetrics('project-id');
```

### Secrets

```typescript
// List all secrets
const secrets = await apiClient.secrets.list();

// Create a new secret
const secret = await apiClient.secrets.create({
  name: 'GitHub Token',
  description: 'Personal access token',
  secret_type: 'api_key',
  secret_value: 'ghp_xxxxxxxxxxxx'
});

// Update a secret
await apiClient.secrets.update('secret-id', {
  name: 'Updated Name'
});

// Delete a secret
await apiClient.secrets.delete('secret-id');
```

### URL Credentials

```typescript
// Create URL credential with basic auth
const credential = await apiClient.urlCredentials.create({
  identifier: 'my-api',
  url: 'https://api.example.com',
  credentials: {
    auth_type: 'basic',
    username: 'user',
    password: 'pass'
  }
});

// Create URL credential with bearer token
const tokenCred = await apiClient.urlCredentials.create({
  identifier: 'oauth-api',
  url: 'https://api.example.com',
  credentials: {
    auth_type: 'bearer',
    auth_token: 'token-here'
  }
});

// List all credentials
const creds = await apiClient.urlCredentials.list();
```

### Documents

```typescript
// Upload a document
const file = document.querySelector('input[type="file"]').files[0];
const upload = await apiClient.documents.upload('project-id', file);

// List project documents
const docs = await apiClient.documents.list('project-id');

// Get document status
const docStatus = await apiClient.documents.getStatus('document-id');

// Delete a document
await apiClient.documents.delete('document-id');
```

### Approvals

```typescript
// Create approval request
const approval = await apiClient.approvals.create('project-id', {
  description: 'Please approve this change',
  change_summary: 'Updated authentication flow',
  impact_analysis: 'Low risk, backwards compatible',
  required_approvers: [
    { user_id: 'user-1', role: 'tech_lead' },
    { user_id: 'user-2', role: 'manager' }
  ]
});

// List approvals
const approvals = await apiClient.approvals.list('project-id');

// Approve a request
await apiClient.approvals.approve('approval-id', {
  comment: 'Looks good to me!'
});

// Reject a request
await apiClient.approvals.reject('approval-id', {
  comment: 'Needs more testing',
  reason: 'Security concerns'
});
```

### Quality & Architecture

```typescript
// Get quality gate
const qualityGate = await apiClient.quality.getQualityGate('container-name');
console.log(qualityGate.status); // 'passed' | 'failed' | 'warning'

// Get architecture graph
const graph = await apiClient.architecture.getGraph('container-name');
console.log(graph.nodes, graph.edges);

// Get dependency report
const depReport = await apiClient.dependencies.getReport('container-name');
console.log(depReport.vulnerable_count);
```

### Improvements

```typescript
// List improvements
const improvements = await apiClient.improvements.list({
  status: 'pending',
  project_id: 'project-id'
});

// Get improvement details
const improvement = await apiClient.improvements.get('improvement-id');

// Approve improvement
await apiClient.improvements.approve('improvement-id', {
  comment: 'Great suggestion!'
});

// Reject improvement
await apiClient.improvements.reject('improvement-id', {
  comment: 'Not applicable',
  reason: 'Already implemented'
});

// Get improvement metrics
const metrics = await apiClient.improvements.getMetrics('improvement-id');
```

### Metrics

```typescript
// Get aggregate metrics
const aggregate = await apiClient.metrics.getAggregate({
  start_date: '2024-01-01',
  end_date: '2024-12-31'
});

// Get project metrics
const projectMetrics = await apiClient.metrics.getProject('project-id');
```

## Error Handling

The API client throws `ApiError` instances with detailed error information:

```typescript
import { apiClient, ApiError } from '$lib/api/unified-client';

try {
  const project = await apiClient.projects.get('invalid-id');
} catch (error) {
  if (error instanceof ApiError) {
    console.error('API Error:', {
      message: error.message,
      status: error.status,
      endpoint: error.endpoint,
      method: error.method,
      data: error.data
    });

    // Check error type
    if (error.isAuthError()) {
      console.log('Authentication failed');
    } else if (error.isNotFoundError()) {
      console.log('Resource not found');
    } else if (error.isValidationError()) {
      console.log('Invalid data');
    } else if (error.isServerError()) {
      console.log('Server error');
    }
  }
}
```

### ApiError Methods

- `isNetworkError()`: Returns true if no response was received
- `isAuthError()`: Returns true for 401/403 status codes
- `isValidationError()`: Returns true for 400/422 status codes
- `isNotFoundError()`: Returns true for 404 status code
- `isServerError()`: Returns true for 5xx status codes
- `toJSON()`: Returns error as JSON object

## Interceptors

### Request Interceptors

Modify requests before they're sent:

```typescript
apiClient.addRequestInterceptor(async (url, options) => {
  // Add custom header
  options.headers = {
    ...options.headers,
    'X-Custom-Header': 'value'
  };

  // Log request
  console.log('Request:', url, options.method);

  return { url, options };
});
```

### Response Interceptors

Process responses before they're returned:

```typescript
apiClient.addResponseInterceptor(async (response) => {
  // Log response
  console.log('Response:', response.status, response.url);

  // Clone response to read body
  const clone = response.clone();
  const data = await clone.json();
  console.log('Response data:', data);

  return response;
});
```

### Error Interceptors

Handle errors globally:

```typescript
apiClient.addErrorInterceptor(async (error) => {
  // Log all errors to monitoring service
  console.error('API Error:', error);

  // Send to Sentry, LogRocket, etc.
  // sentryLogger.captureException(error);

  throw error; // Re-throw to allow local handling
});
```

### Clear Interceptors

```typescript
apiClient.clearInterceptors();
```

## Loading State Management

Track API loading states across your application:

```typescript
// Subscribe to loading state changes
const unsubscribe = apiClient.onLoadingChange((state) => {
  console.log('Loading:', state.isLoading);
  console.log('Endpoint:', state.endpoint);
  console.log('Method:', state.method);

  // Update UI loading indicator
  if (state.isLoading) {
    showSpinner();
  } else {
    hideSpinner();
  }
});

// Get current loading state
const currentState = apiClient.getLoadingState();

// Unsubscribe when done
unsubscribe();
```

### Svelte Integration

```svelte
<script lang="ts">
  import { apiClient } from '$lib/api/unified-client';
  import { onMount, onDestroy } from 'svelte';

  let isLoading = $state(false);

  onMount(() => {
    const unsubscribe = apiClient.onLoadingChange((state) => {
      isLoading = state.isLoading;
    });

    onDestroy(unsubscribe);
  });
</script>

{#if isLoading}
  <div class="spinner">Loading...</div>
{/if}
```

## Query Parameters

Pass query parameters type-safely:

```typescript
// List with pagination
const projects = await apiClient.projects.list({
  page: 1,
  limit: 20,
  offset: 0,
  sort: 'created_at',
  order: 'desc',
  status: 'active'
});

// Filter improvements
const improvements = await apiClient.improvements.list({
  status: 'pending',
  project_id: 'project-id',
  limit: 50
});

// Metrics with date range
const metrics = await apiClient.metrics.getAggregate({
  start_date: '2024-01-01',
  end_date: '2024-12-31',
  interval: 'week'
});
```

## HTTP Method Helpers

For custom endpoints not covered by the API:

```typescript
// GET request
const data = await apiClient.get<MyType>('/api/custom-endpoint', {
  params: { key: 'value' }
});

// POST request
const result = await apiClient.post<ResultType>('/api/custom', {
  field: 'value'
});

// PUT request
await apiClient.put('/api/resource/id', updateData);

// PATCH request
await apiClient.patch('/api/resource/id', partialData);

// DELETE request
await apiClient.delete('/api/resource/id');

// Upload with custom endpoint
const formData = new FormData();
formData.append('file', file);
const upload = await apiClient.upload('/api/custom-upload', formData);
```

## Configuration

Create a custom instance with configuration:

```typescript
import { UnifiedApiClient } from '$lib/api/unified-client';

const customClient = new UnifiedApiClient({
  baseUrl: 'https://api.example.com',
  timeout: 60000, // 60 seconds
  retries: 3,
  headers: {
    'X-Custom-Header': 'value'
  }
});
```

## Automatic Features

### Bearer Token Authentication

The API client automatically:
- Retrieves the token from Keycloak via `auth.getToken()`
- Adds `Authorization: Bearer <token>` header to all requests
- Skips auth for requests with `skipAuth: true` option

### 401 Redirect

When a 401 Unauthorized response is received:
1. Error is logged to console
2. `auth.login()` is called to redirect to Keycloak
3. After login, user is returned to the original page

### Request Timeout

All requests timeout after 30 seconds (configurable). A timeout error is thrown:

```typescript
try {
  await apiClient.projects.list();
} catch (error) {
  if (error.message === 'Request timeout') {
    console.log('Request took too long');
  }
}
```

## Type Safety

All API methods are fully typed:

```typescript
import type { Project, ProjectCreate } from '$lib/types/api';

// TypeScript knows the return type
const project: Project = await apiClient.projects.get('id');

// TypeScript validates the payload
const data: ProjectCreate = {
  name: 'Project',
  repository_url: 'https://github.com/user/repo',
  branch: 'main'
};

await apiClient.projects.create(data);
```

## Migration Guide

### From `/src/lib/api/client.ts`

**Before:**
```typescript
import { apiClient } from '$lib/api/client';
const projects = await apiClient.getProjects();
```

**After:**
```typescript
import { apiClient } from '$lib/api/unified-client';
const projects = await apiClient.projects.list();
```

### From `/src/lib/services/api.ts`

**Before:**
```typescript
import { projectsApi } from '$lib/services/api';
const projects = await projectsApi.list({ status: 'active' });
```

**After:**
```typescript
import { apiClient } from '$lib/api/unified-client';
const projects = await apiClient.projects.list({ status: 'active' });
```

## Best Practices

1. **Always handle errors**: Wrap API calls in try-catch blocks
2. **Use TypeScript types**: Import types from `$lib/types/api`
3. **Show loading states**: Subscribe to loading state for UX
4. **Validate data**: Validate user input before sending to API
5. **Use query parameters**: Filter and paginate data efficiently
6. **Log errors**: Use error interceptors for monitoring
7. **Test API calls**: Mock the API client in tests

## Examples

See the example pages for complete implementations:
- Projects: `/frontend/src/lib/components/projects/ProjectPortfolio.svelte`
- Secrets: `/frontend/src/routes/secrets/+page.svelte`
- Documents: `/frontend/src/routes/documents/+page.svelte`
- Approvals: `/frontend/src/routes/approvals/+page.svelte`
- Architecture: `/frontend/src/routes/architecture/+page.svelte`
