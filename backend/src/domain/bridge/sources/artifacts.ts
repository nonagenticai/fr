// fr/backend/src/domain/bridge/sources/artifacts.ts
//
// ArtifactsOutputSource — adapts flagged artifacts into ToolOutput records for
// the analysis-to-kanban-bridge slice. See:
//   docs/superpowers/specs/completed/2026-04-24-analysis-to-kanban-bridge.md
//   §Architecture, §Dedup canonical keys
import type { RequestContext } from '../../../integrations/_lib/context';
import { IntegrationError } from '../../../integrations/_lib/errors';
import {
  listFlaggedArtifacts,
  type FlaggedArtifact,
} from '../../../integrations/artifacts';
import { computeStableId } from '../dedup';
import type { KanbanCardDraft, ToolOutput, ToolOutputSource } from '../types';
import { createScopedOutputCache } from './output-cache';

// ---------------------------------------------------------------------------
// Per-process output LRU — populated on listOutputs, consumed by getOutput.
//
// Mirrors the codingOutputSource cache pattern (code-review item 9). The
// upstream single-artifact endpoint is not landed (slice 3), so getOutput
// can ONLY resolve from cache; on miss we warn + throw output_not_found.
// ---------------------------------------------------------------------------

// Keyed by caller scope (tenantId|userId) as well as output_id — see
// ./output-cache.ts for the cross-tenant leak an id-only key allowed.
const outputCache = createScopedOutputCache('artifacts');

function flaggedToOutput(flagged: FlaggedArtifact): ToolOutput {
  const output_id = `${flagged.artifact_id}@${flagged.version}`;
  const stable_id = computeStableId({
    producer: 'artifacts',
    artifact_id: flagged.artifact_id,
    version: flagged.version,
  });
  const bodyLines: string[] = [
    '```',
    `artifact_id: ${flagged.artifact_id}`,
    `version: ${flagged.version}`,
  ];
  if (flagged.flag_reason !== undefined) {
    bodyLines.push(`flag_reason: ${flagged.flag_reason}`);
  }
  if (flagged.flagged_at !== undefined) {
    bodyLines.push(`flagged_at: ${flagged.flagged_at}`);
  }
  bodyLines.push('```');
  return {
    producer: 'artifacts',
    run_id: flagged.project_id,
    output_id,
    stable_id,
    title: `Flagged artifact ${flagged.artifact_id}`,
    body_md: bodyLines.join('\n'),
    severity: 'moderate',
    source_ref: { artifact_id: flagged.artifact_id },
    suggested_labels: ['artifacts', 'flagged'],
    suggested_project_id: flagged.project_id,
  };
}

export const artifactsOutputSource: ToolOutputSource = {
  id: 'artifacts',

  async listOutputs(
    ctx: RequestContext,
    params: Record<string, string>,
  ): Promise<ToolOutput[]> {
    const projectId = params.project_id;
    if (!projectId) {
      throw new IntegrationError({
        // Reachable from the REST route with a caller-controlled params bag:
        // a caller-side refusal, raised before any upstream call.
        code: 'BAD_REQUEST',
        message: 'artifactsOutputSource.listOutputs requires params.project_id',
        // Named so an agent can SELF-CORRECT. `bridge.list_outputs` declares
        // `filters` optional and each producer needs a different set, so
        // "correct the input" alone leaves nothing to act on.
        requiredParams: ['project_id'],
      });
    }
    const flagged = await listFlaggedArtifacts(ctx, projectId);
    const outputs = flagged.map(flaggedToOutput);
    for (const o of outputs) outputCache.put(ctx, o);
    return outputs;
  },

  async getOutput(ctx: RequestContext, output_id: string): Promise<ToolOutput> {
    const cached = outputCache.get(ctx, output_id);
    if (cached) return cached;
    // Cache miss — slice 3 single-artifact endpoint not landed, so we cannot
    // resolve upstream. Warn once and surface output_not_found.
    console.warn(
      `[artifacts-source] getOutput cache miss for ${output_id}; slice 3 endpoint not landed`,
    );
    throw new IntegrationError({
      code: 'output_not_found',
      service: 'fr-bridge',
      upstreamStatus: 404,
      message: `artifacts output ${output_id} not found (slice 3 endpoint not landed)`,
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
