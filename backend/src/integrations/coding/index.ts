/**
 * coding-gateway integration — public re-exports.
 *
 * Splits across this directory:
 *   types.ts            — Job, Finding, AnalysisType, severity helpers
 *   client.ts           — HttpClient lifecycle + cached singleton
 *   adapter.ts          — triggerAnalysis, listJobs, getJob, getFindings,
 *                         resolveRepo, listAnalysisTypes
 *   normalizers/*.ts    — per-type Finding mappers (one file per upstream)
 *
 * Importers should keep using `from '.../integrations/coding'` — the import
 * path is stable.
 */

export {
  ANALYSIS_TYPES,
  SEVERITIES,
  JOB_STATUSES,
  type AnalysisType,
  type Severity,
  type JobStatus,
  type Job,
  type Finding,
} from './types';

export {
  resolveRepoHeadSha,
  resolveHeadShaForRepoId,
} from './head-sha';

export {
  normalizeSecurityFindings,
  readSecurityScanMeta,
  type SecurityScanMeta,
} from './normalizers/security';
export { normalizeBugHuntFindings } from './normalizers/bug_hunt';
export { normalizeQualityFindings } from './normalizers/quality';
export {
  normalizeDependencyFindings,
  readDependencyScanMeta,
  type DependencyScanMeta,
} from './normalizers/dependencies';
export { normalizeTestsFindings } from './normalizers/tests';

export {
  triggerAnalysis,
  listJobs,
  getJob,
  getFindings,
  listAnalysisTypes,
  type TriggerInput,
  type TriggerResultEnvelope,
  type ListJobsInput,
  type ListJobsResult,
  type GetFindingsInput,
  type GetFindingsResult,
} from './adapter';

// Spine reads + writes — the namespaced Stack-2 surface (/api/coding/*). See spine.ts.
export {
  getAugmentedGraph,
  getQualityGate,
  listCodingContainers,
  getDependencySnapshot,
  getDependencyReport,
  provisionRepository,
  initializeGraph,
  analyzeCodebase,
  triggerQualityScan,
  getStoredQualityLatest,
  getStoredQualityHistory,
  triggerStoredQualityAnalysis,
  getCodingContainer,
  listWorkflowRunsForSha,
  PROVISION_TIMEOUT_MS,
  INITIALIZE_TIMEOUT_MS,
  ANALYZE_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  type DependencyReportResult,
  type InitializeGraphResult,
  type StoredQualityStatus,
  type StoredQualityIssue,
  type StoredQualityLatest,
  type StoredQualityHistory,
  type StoredQualityHistoryRow,
  type QualityAnalyzeAccepted,
  type ListWorkflowRunsRequest,
  type ListWorkflowRunsResponse,
  type WorkflowRunState,
} from './spine';
