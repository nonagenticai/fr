// fr/backend/src/domain/bridge/sources/kag.ts
//
// KagOutputSource — adapts kag scrape failures into ToolOutput records for the
// analysis-to-kanban-bridge slice. See:
//   docs/superpowers/specs/completed/2026-04-24-analysis-to-kanban-bridge.md
//   §Architecture, §Dedup canonical keys
import type { RequestContext } from '../../../integrations/_lib/context';
import { IntegrationError } from '../../../integrations/_lib/errors';
import {
  listScrapeFailures,
  type ScrapeFailure,
} from '../../../integrations/kag';
import { computeStableId } from '../dedup';
import type { KanbanCardDraft, ToolOutput, ToolOutputSource } from '../types';
import { createScopedOutputCache } from './output-cache';

function encodeOutputId(sessionId: string, url: string): string {
  return Buffer.from(`${sessionId}|${url}`, 'utf8').toString('base64url');
}

function decodeOutputId(outputId: string): { sessionId: string; url: string } {
  const decoded = Buffer.from(outputId, 'base64url').toString('utf8');
  const sep = decoded.indexOf('|');
  if (sep < 0) {
    throw new IntegrationError({
      code: 'output_not_found',
      service: 'fr-bridge',
      upstreamStatus: 404,
      message: `kag output_id ${outputId} could not be decoded`,
    });
  }
  return { sessionId: decoded.slice(0, sep), url: decoded.slice(sep + 1) };
}

// ---------------------------------------------------------------------------
// Per-process output LRU — populated on listOutputs, consumed by getOutput.
//
// Mirrors the codingOutputSource cache pattern: getOutput receives only the
// opaque output_id, and without this cache we'd re-list the upstream scrape
// failures on every call (code-review item 9). On a miss we fall back to the
// existing decode + relist behavior so deep links / agent-initiated calls
// before any list still resolve.
// ---------------------------------------------------------------------------

// Keyed by caller scope (tenantId|userId) as well as output_id — see
// ./output-cache.ts for the cross-tenant leak an id-only key allowed.
const outputCache = createScopedOutputCache('kag');

function failureToOutput(failure: ScrapeFailure): ToolOutput {
  const output_id = encodeOutputId(failure.session_id, failure.url);
  const stable_id = computeStableId({
    producer: 'kag',
    session_id: failure.session_id,
    url: failure.url,
  });
  const bodyLines: string[] = ['```', `url: ${failure.url}`];
  if (failure.error_code !== undefined) {
    bodyLines.push(`error_code: ${failure.error_code}`);
  }
  if (failure.error_message !== undefined) {
    bodyLines.push(`error_message: ${failure.error_message}`);
  }
  if (failure.occurred_at !== undefined) {
    bodyLines.push(`occurred_at: ${failure.occurred_at}`);
  }
  bodyLines.push('```');
  return {
    producer: 'kag',
    run_id: failure.session_id,
    output_id,
    stable_id,
    title: `Scrape failed: ${failure.url}`,
    body_md: bodyLines.join('\n'),
    severity: 'moderate',
    source_ref: { url: failure.url },
    suggested_labels: ['kag', 'scrape-failure'],
  };
}

export const kagOutputSource: ToolOutputSource = {
  id: 'kag',

  async listOutputs(
    ctx: RequestContext,
    params: Record<string, string>,
  ): Promise<ToolOutput[]> {
    const sessionId = params.session_id;
    if (!sessionId) {
      throw new IntegrationError({
        // Reachable from the REST route with a caller-controlled params bag:
        // a caller-side refusal, raised before any upstream call.
        code: 'BAD_REQUEST',
        message: 'kagOutputSource.listOutputs requires params.session_id',
        // Named so an agent can SELF-CORRECT. `bridge.list_outputs` declares
        // `filters` optional and each producer needs a different set, so
        // "correct the input" alone leaves nothing to act on.
        requiredParams: ['session_id'],
      });
    }
    const failures = await listScrapeFailures(ctx, sessionId);
    const outputs = failures.map(failureToOutput);
    for (const o of outputs) outputCache.put(ctx, o);
    return outputs;
  },

  async getOutput(ctx: RequestContext, output_id: string): Promise<ToolOutput> {
    const cached = outputCache.get(ctx, output_id);
    if (cached) return cached;
    // Cache miss — decode + relist upstream so deep links / agent-initiated
    // calls before any listOutputs still resolve. Single-line slow-path log.
    console.warn(
      `[kag-source] getOutput cache miss for ${output_id}; relisting upstream`,
    );
    const { sessionId, url } = decodeOutputId(output_id);
    const failures = await listScrapeFailures(ctx, sessionId);
    const match = failures.find((f) => f.url === url);
    if (!match) {
      throw new IntegrationError({
        code: 'output_not_found',
        service: 'fr-bridge',
        upstreamStatus: 404,
        message: `kag output ${output_id} not found`,
      });
    }
    const output = failureToOutput(match);
    outputCache.put(ctx, output);
    return output;
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
