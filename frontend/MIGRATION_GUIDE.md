# Migration Guide: Unified API Client

This guide helps you migrate from the old API clients to the new Unified API Client.

## Overview

The new Unified API Client (`/src/lib/api/unified-client.ts`) replaces:
- `/src/lib/api/client.ts` (old API client)
- `/src/lib/services/api.ts` (newer API client)

## Benefits of Migration

1. **Full TypeScript Support**: Complete type safety with generics
2. **Consistent API**: All endpoints follow the same pattern
3. **Better Error Handling**: Structured `ApiError` class
4. **Loading States**: Built-in loading state management
5. **Interceptors**: Request/response/error interceptors
6. **Better Auth**: Automatic Keycloak token handling
7. **Production Ready**: Timeout, retry, and error handling

## Migration Steps

### Step 1: Update Imports

**Old (client.ts):**
```typescript
import { apiClient } from '$lib/api/client';
```

**Old (api.ts):**
```typescript
import { api, projectsApi, secretsApi } from '$lib/services/api';
```

**New:**
```typescript
import { apiClient } from '$lib/api/unified-client';
```

### Step 2: Update API Calls

#### Projects

**Old:**
```typescript
// client.ts style
const projects = await apiClient.getProjects();
const project = await apiClient.getProject(id);
await apiClient.createProject(data);
await apiClient.deleteProject(id);

// api.ts style
const projects = await projectsApi.list();
const project = await projectsApi.get(id);
await projectsApi.create(data);
await projectsApi.delete(id);
```

**New:**
```typescript
const response = await apiClient.projects.list();
const projects = response.projects; // or response.items
const project = await apiClient.projects.get(id);
await apiClient.projects.create(data);
await apiClient.projects.delete(id);
```

#### Secrets

**Old:**
```typescript
// client.ts style
const secrets = await apiClient.getSecrets();
await apiClient.createSecret(data);
await apiClient.updateSecret(id, data);
await apiClient.deleteSecret(id);

// api.ts style
const secrets = await secretsApi.list(projectId);
await secretsApi.create(data);
await secretsApi.update(id, data);
await secretsApi.delete(id);
```

**New:**
```typescript
const response = await apiClient.secrets.list();
const secrets = response.secrets; // or response.items
await apiClient.secrets.create(data);
await apiClient.secrets.update(id, data);
await apiClient.secrets.delete(id);
```

#### Documents

**Old:**
```typescript
// client.ts style
await apiClient.uploadDocument(file, projectId);
const docs = await apiClient.getDocuments(projectId);
const status = await apiClient.getDocumentStatus(docId);

// api.ts style
await documentsApi.upload(projectId, file);
const docs = await documentsApi.list(projectId);
```

**New:**
```typescript
await apiClient.documents.upload(projectId, file);
const response = await apiClient.documents.list(projectId);
const docs = response.documents; // or response.items
const status = await apiClient.documents.getStatus(docId);
```

#### Approvals

**Old:**
```typescript
// client.ts style
const approvals = await apiClient.getApprovals(projectId);
await apiClient.submitApproval(projectId, data);
await apiClient.approveRequest(approvalId);
await apiClient.rejectRequest(approvalId, reason);

// api.ts style
const approvals = await approvalsApi.list({ project_id: projectId });
await approvalsApi.approve(approvalId, comment);
await approvalsApi.reject(approvalId, comment);
```

**New:**
```typescript
const response = await apiClient.approvals.list(projectId);
const approvals = response.approvals;
await apiClient.approvals.create(projectId, data);
await apiClient.approvals.approve(approvalId, { comment });
await apiClient.approvals.reject(approvalId, { comment, reason });
```

#### Quality & Architecture

**Old:**
```typescript
// client.ts style
const gate = await apiClient.getQualityGate(containerName);
const graph = await apiClient.getArchitectureGraph(containerName);
const report = await apiClient.getDependencyReport(containerName);
await apiClient.scanDependencies(containerName);
```

**New:**
```typescript
const gate = await apiClient.quality.getQualityGate(containerName);
const graph = await apiClient.architecture.getGraph(containerName);
const report = await apiClient.dependencies.getReport(containerName);
```

#### Flows

**Old:**
```typescript
// client.ts style
const flows = await apiClient.getFlows();
const flow = await apiClient.getFlow(id);
await apiClient.createFlow(data);
await apiClient.updateFlow(id, data);

// api.ts style
const flows = await flowsApi.list();
const flow = await flowsApi.get(id);
```

**New:**
```typescript
const response = await apiClient.flows.list();
const flows = response.flows; // or response.items
const flow = await apiClient.flows.get(id);
await apiClient.flows.create(data);
await apiClient.flows.update(id, data);
```

#### Improvements

**Old:**
```typescript
// client.ts style
const improvements = await apiClient.getImprovements();
const improvement = await apiClient.getImprovement(id);
await apiClient.approveImprovement(id);
await apiClient.rejectImprovement(id);
const metrics = await apiClient.getImprovementMetrics(id);

// api.ts style
const improvements = await improvementsApi.list();
const improvement = await improvementsApi.get(id);
await improvementsApi.approve(id);
await improvementsApi.reject(id, comment);
```

**New:**
```typescript
const response = await apiClient.improvements.list();
const improvements = response.improvements;
const improvement = await apiClient.improvements.get(id);
await apiClient.improvements.approve(id);
await apiClient.improvements.reject(id, { comment, reason });
const metrics = await apiClient.improvements.getMetrics(id);
```

#### Metrics

**Old:**
```typescript
// client.ts style
const metrics = await apiClient.getAggregateMetrics();

// api.ts style
const metrics = await metricsApi.aggregate({ start_date, end_date });
const projectMetrics = await metricsApi.project(projectId);
```

**New:**
```typescript
const metrics = await apiClient.metrics.getAggregate({ start_date, end_date });
const projectMetrics = await apiClient.metrics.getProject(projectId);
```

### Step 3: Update Error Handling

**Old:**
```typescript
try {
  const projects = await apiClient.getProjects();
} catch (error) {
  console.error('Error:', error.message);
}
```

**New:**
```typescript
import { ApiError } from '$lib/api/unified-client';

try {
  const response = await apiClient.projects.list();
  const projects = response.projects;
} catch (error) {
  if (error instanceof ApiError) {
    console.error('API Error:', {
      message: error.message,
      status: error.status,
      endpoint: error.endpoint
    });

    if (error.isAuthError()) {
      // Handle authentication error
    } else if (error.isNotFoundError()) {
      // Handle not found
    }
  }
}
```

### Step 4: Update Response Handling

The new API client returns structured responses:

**Old:**
```typescript
const projects = await apiClient.getProjects();
// projects is the data directly
```

**New:**
```typescript
const response = await apiClient.projects.list();
const projects = response.projects || response.items || [];
const total = response.total;
```

For consistency, destructure the response:

```typescript
const { projects, total } = await apiClient.projects.list();
```

### Step 5: Add TypeScript Types

Import types from the new type system:

```typescript
import type {
  Project,
  ProjectCreate,
  Secret,
  Document,
  Approval
} from '$lib/types/api';

const project: Project = await apiClient.projects.get(id);

const newProject: ProjectCreate = {
  name: 'My Project',
  repository_url: 'https://github.com/user/repo',
  branch: 'main'
};
```

## Complete Example: Before and After

### Before (using old clients)

```svelte
<script lang="ts">
  import { apiClient } from '$lib/api/client';
  import { projectsApi } from '$lib/services/api';

  let projects = $state([]);
  let loading = $state(false);
  let error = $state('');

  async function loadProjects() {
    loading = true;
    error = '';
    try {
      projects = await apiClient.getProjects();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function createProject(name: string, url: string) {
    try {
      await projectsApi.create({ name, repository_url: url });
      await loadProjects();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
  }
</script>
```

### After (using unified client)

```svelte
<script lang="ts">
  import { apiClient, ApiError } from '$lib/api/unified-client';
  import type { Project, ProjectCreate } from '$lib/types/api';

  let projects = $state<Project[]>([]);
  let loading = $state(false);
  let error = $state('');

  // Subscribe to loading state
  $effect(() => {
    const unsubscribe = apiClient.onLoadingChange((state) => {
      loading = state.isLoading;
    });
    return unsubscribe;
  });

  async function loadProjects() {
    error = '';
    try {
      const response = await apiClient.projects.list();
      projects = response.projects || [];
    } catch (err) {
      if (err instanceof ApiError) {
        error = err.message;
        if (err.isServerError()) {
          error = 'Server error. Please try again later.';
        }
      }
    }
  }

  async function createProject(name: string, url: string) {
    try {
      const data: ProjectCreate = {
        name,
        repository_url: url,
        branch: 'main'
      };
      await apiClient.projects.create(data);
      await loadProjects();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.isValidationError()) {
          alert('Invalid data: ' + err.message);
        } else {
          alert('Failed: ' + err.message);
        }
      }
    }
  }
</script>
```

## Breaking Changes

1. **Response Structure**: Most list endpoints now return `{ items: T[], total: number }` or `{ <entity_name>: T[], total: number }`
2. **Error Type**: Errors are now `ApiError` instances, not plain `Error`
3. **Method Names**: Some method names have changed for consistency
4. **Authentication**: Token handling is automatic, no need to call `setToken()`

## Deprecation Timeline

- **Phase 1 (Now)**: New unified client is available
- **Phase 2 (Next sprint)**: Update all pages to use new client
- **Phase 3 (Following sprint)**: Remove old clients

## Need Help?

- Check the [README.md](/src/lib/api/README.md) for detailed documentation
- See [example-usage.ts](/src/lib/api/example-usage.ts) for code examples
- Ask in the team chat if you have questions

## Checklist

Use this checklist when migrating a component:

- [ ] Update imports to use unified client
- [ ] Import TypeScript types from `$lib/types/api`
- [ ] Update API method calls to new structure
- [ ] Handle list response structure (e.g., `response.projects`)
- [ ] Update error handling to use `ApiError`
- [ ] Add proper TypeScript types to variables
- [ ] Test the component thoroughly
- [ ] Remove old imports
