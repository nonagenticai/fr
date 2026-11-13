// fr/backend/src/domain/bridge/sources/coding.ts
//
// CodingOutputSource — adapts coding-gateway analysis findings into ToolOutput
// records for the analysis-to-kanban-bridge slice. See:
//   docs/superpowers/specs/completed/2026-04-24-analysis-to-kanban-bridge.md
//   §Architecture, §Dedup canonical keys
//
// Wire shape: this source consumes `Finding`/`Job` from
// `backend/src/integrations/coding.ts` (the Wave-1 coding-gateway adapter).
// We deliberately do NOT call the gateway directly — `getJob` and `getFindings`
// already encapsulate poll/normalize/per-tenant auth, so the bridge composes
// over them rather than duplicating gateway plumbing.
//
// `listOutputs` requires `params.job_id` (the FR-side coding_analysis_runs row
// id) and `params.user_id` (drives tenant scoping inside the integration).
// `getOutput` resolves through a per-process LRU populated by the most recent
// `listOutputs` call — see `getOutput` for the cache-miss contract.

import {
  getCodingJobId,
  type RequestContext,
} from '../../../integrations/_lib/context';
import { IntegrationError } from '../../../integrations/_lib/errors';
import {
  getFindings,
  getJob,
  type Finding,
  type Severity as CodingSeverity,
} from '../../../integrations/coding';

import { computeStableId } from '../dedup';
import type { KanbanCardDraft, ToolOutput, ToolOutputSource } from '../types';
import { createScopedOutputCache } from './output-cache';

// ---------------------------------------------------------------------------
// output_id encoding — deterministic per-finding within a run
// ---------------------------------------------------------------------------

interface CodingKey {
  tool: string;
  rule_id: string;
  file_path: string;
  line_number: number;
}

function encodeOutputId(k: CodingKey): string {
  // base64url(`${tool}|${rule_id}|${file_path}|${line_number}`)
  return Buffer.from(
    `${k.tool}|${k.rule_id}|${k.file_path}|${k.line_number}`,
    'utf8',
  ).toString('base64url');
}

function decodeOutputId(outputId: string): CodingKey {
  const decoded = Buffer.from(outputId, 'base64url').toString('utf8');
  const parts = decoded.split('|');
  if (parts.length < 4) {
    throw new IntegrationError({
      code: 'output_not_found',
      service: 'fr-bridge',
      upstreamStatus: 404,
      message: `coding output_id ${outputId} could not be decoded`,
    });
  }
  // line_number is the trailing field; everything between rule_id and the last
  // pipe stays as file_path so paths containing `|` (rare but legal) survive.
  const lineRaw = parts[parts.length - 1] ?? '0';
  const tool = parts[0] ?? '';
  const rule_id = parts[1] ?? '';
  const file_path = parts.slice(2, -1).join('|');
  const line_number = Number.parseInt(lineRaw, 10);
  return {
    tool,
    rule_id,
    file_path,
    line_number: Number.isFinite(line_number) ? line_number : 0,
  };
}

// ---------------------------------------------------------------------------
// Severity mapping — coding gateway emits info|low|medium|high|critical;
// ToolOutput severity is low|moderate|high|critical (no `info`).
// ---------------------------------------------------------------------------

function mapSeverity(s: CodingSeverity): ToolOutput['severity'] {
  switch (s) {
    case 'info':
    case 'low':
      return 'low';
    case 'medium':
      return 'moderate';
    case 'high':
      return 'high';
    case 'critical':
      return 'critical';
  }
}

// ---------------------------------------------------------------------------
// Finding → ToolOutput
// ---------------------------------------------------------------------------

function findingToKey(f: Finding): CodingKey {
  return {
    tool: f.type,
    rule_id: f.rule_id ?? f.title,
    file_path: f.location?.file ?? '',
    line_number: f.location?.line ?? 0,
  };
}

function findingToOutput(f: Finding, runId: string): ToolOutput {
  const key = findingToKey(f);
  const output_id = encodeOutputId(key);
  const stable_id = computeStableId({
    producer: 'coding',
    tool: key.tool,
    rule_id: key.rule_id,
    file_path: key.file_path,
    line_number: key.line_number,
  });
  const severity = mapSeverity(f.severity);
  const loc =
    key.file_path.length > 0 ? `${key.file_path}:${key.line_number}` : '(no location)';
  const title = `[${severity}] ${key.tool}: ${key.rule_id} at ${loc}`;
  const bodyLines: string[] = [
    '```',
    `tool: ${key.tool}`,
    `rule_id: ${key.rule_id}`,
    `severity: ${severity}`,
    `location: ${loc}`,
    `run_id: ${runId}`,
  ];
  if (f.message.length > 0) {
    bodyLines.push('', f.message);
  }
  bodyLines.push('```');
  // source_ref carries the FULL coding canonical-key tuple
  // (tool, rule_id, file_path, line_number) so any consumer can recompute
  // stable_id without lossy parsing of suggested_labels. Belt-and-suspenders:
  // we ALSO emit 'rule:<id>' in suggested_labels for legacy consumers.
  const sourceRef: ToolOutput['source_ref'] = {
    tool: key.tool,
    rule_id: key.rule_id,
  };
  if (key.file_path.length > 0) sourceRef.file_path = key.file_path;
  if (key.line_number > 0) sourceRef.line_number = key.line_number;
  return {
    producer: 'coding',
    run_id: runId,
    output_id,
    stable_id,
    title,
    body_md: bodyLines.join('\n'),
    severity,
    source_ref: sourceRef,
    suggested_labels: [
      'coding',
      `coding:${key.tool}`,
      `rule:${key.rule_id}`,
      `severity:${severity}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Per-process output LRU — populated on listOutputs, consumed by getOutput.
//
// getOutput receives only the opaque output_id; the originating job_id /
// user_id are not encoded into it, so without this cache we couldn't resolve
// back to a Finding without scanning every job in the system. The cache is
// populated as a side effect of every listOutputs call. On a miss we throw
// `coding_output_not_cached` with a clear message — callers must re-list.
// ---------------------------------------------------------------------------

// Keyed by caller scope (tenantId|userId) as well as output_id — see
// ./output-cache.ts for the cross-tenant leak an id-only key allowed.
const outputCache = createScopedOutputCache('coding');

// ---------------------------------------------------------------------------
// ToolOutputSource implementation
// ---------------------------------------------------------------------------

export const codingOutputSource: ToolOutputSource = {
  id: 'coding',

  async listOutputs(
    ctx: RequestContext,
    params: Record<string, string>,
  ): Promise<ToolOutput[]> {
    const job_id = params.job_id;
    const user_id = params.user_id;
    if (!job_id || !user_id) {
      throw new IntegrationError({
        // Reachable from the REST route with a caller-controlled params bag:
        // a caller-side refusal, raised before any upstream call.
        code: 'BAD_REQUEST',
        message:
          'codingOutputSource.listOutputs requires params.job_id and params.user_id',
        // Named so an agent can SELF-CORRECT. `bridge.list_outputs` declares
        // `filters` optional and each producer needs a different set, so
        // "correct the input" alone leaves nothing to act on.
        requiredParams: ['job_id', 'user_id'],
      });
    }
    // Resolve the job for its run_id (== FR job id) and to surface a clear
    // not-found before we ask for findings.
    const job = await getJob(job_id, user_id);
    if (!job) {
      throw new IntegrationError({
        code: 'UPSTREAM_NOT_FOUND',
        service: 'fr-bridge',
        upstreamStatus: 404,
        message: `coding job ${job_id} not found`,
      });
    }
    const { findings } = await getFindings({ userId: user_id, jobId: job_id });
    const outputs = findings.map((f) => findingToOutput(f, job.id));
    for (const o of outputs) outputCache.put(ctx, o);
    return outputs;
  },

  async getOutput(ctx: RequestContext, output_id: string): Promise<ToolOutput> {
    // Validate the encoding eagerly so a malformed id surfaces as 404 rather
    // than a cache miss with a confusing message.
    decodeOutputId(output_id);
    // Cache wins — listOutputs is the hot path and produces canonical rows.
    const cached = outputCache.get(ctx, output_id);
    if (cached) return cached;

    // Cache miss: try to resolve fresh via the request-scoped coding.job_id
    // (X-Coding-Job-Id header, or set explicitly by the route handler).
    // Pull the job_id from ALS first; fall back to the explicit ctx.coding
    // for code paths that pass a synthesised RequestContext without going
    // through `withRequestContext`.
    const jobId = getCodingJobId() ?? ctx.coding?.jobId;
    const userId = ctx.userId;
    if (jobId && userId) {
      // Re-list the run; populates the cache as a side effect (cachePut on
      // every output) so subsequent requests in the same draft batch hit
      // the cache instead of round-tripping again.
      const job = await getJob(jobId, userId);
      if (!job) {
        throw new IntegrationError({
          code: 'coding_output_unresolvable',
          service: 'fr-bridge',
          upstreamStatus: 404,
          message: `coding job ${jobId} not found while resolving output ${output_id}`,
        });
      }
      const { findings } = await getFindings({ userId, jobId });
      const relisted = findings.map((f) => findingToOutput(f, job.id));
      for (const o of relisted) outputCache.put(ctx, o);
      // Resolve from the relisted rows, not by re-reading the cache: an
      // unscoped ctx (no tenantId) is never cached, and must still resolve.
      const reFetched = relisted.find((o) => o.output_id === output_id);
      if (reFetched) return reFetched;
      throw new IntegrationError({
        code: 'coding_output_unresolvable',
        service: 'fr-bridge',
        upstreamStatus: 404,
        message: `coding output ${output_id} not present in job ${jobId} findings`,
      });
    }

    // No job id available and not cached — emit a warning so the operator
    // can spot misconfigured callers (frontend/agent forgetting to send
    // X-Coding-Job-Id) and surface a typed unresolvable error instead of
    // the historical "not_cached" message.
    console.warn(
      '[bridge.coding] getOutput cache miss with no coding.jobId in context',
      {
        output_id,
        correlation_id: ctx.correlationId,
        has_user_id: Boolean(userId),
      },
    );
    throw new IntegrationError({
      code: 'coding_output_unresolvable',
      service: 'fr-bridge',
      upstreamStatus: 404,
      message:
        `coding output ${output_id} cannot be resolved: not cached and no coding.job_id in request context (set X-Coding-Job-Id or call listOutputs first)`,
    });
  },

  async toDraft(
    _ctx: RequestContext,
    output: ToolOutput,
  ): Promise<Omit<KanbanCardDraft, 'list_id' | 'board_id' | 'assignee_user_id'>> {
    return {
      title: output.title,
      body_md: output.body_md,
      project_id: output.suggested_project_id ?? '',
      labels: output.suggested_labels ?? [],
      source: {
        producer: output.producer,
        run_id: output.run_id,
        output_id: output.output_id,
        stable_id: output.stable_id,
      },
    };
  },
};
