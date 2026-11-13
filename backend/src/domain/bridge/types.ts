// fr/backend/src/domain/bridge/types.ts
//
// Public type contracts for the analysis-to-kanban bridge slice.
// See: docs/superpowers/specs/completed/2026-04-24-analysis-to-kanban-bridge.md §Architecture.
//
// These shapes are the seam between the per-producer ToolOutputSource adapters
// (CodingOutputSource, KagOutputSource, ArtifactsOutputSource — landed in
// later slices) and the bridge's own DraftService / DedupService / SubmitService
// / CommitService. Anything imported from `db/client` here is intentional —
// service methods accept a `BridgeDb` handle so tests can swap it for a fake.
import type { db } from '../../db/client';
import type { RequestContext } from '../../integrations/_lib/context';

export type ProducerId = 'coding' | 'kag' | 'artifacts';

export interface ToolOutput {
  producer: ProducerId;
  run_id: string;
  output_id: string; // stable within (producer, run_id)
  stable_id: string; // sha256(producer canonical key) — see Dedup
  title: string;
  body_md: string; // markdown; may cite source
  severity?: 'low' | 'moderate' | 'high' | 'critical';
  source_ref?: {
    file_path?: string;
    line_number?: number;
    url?: string;
    artifact_id?: string;
    // Coding producer canonical-key fields. Carried in source_ref (in
    // addition to a 'rule:<id>' label) so consumers can rebuild the
    // stable_id without lossy parsing of suggested_labels.
    tool?: string;
    rule_id?: string;
  };
  suggested_labels?: string[]; // e.g. ['coding:pylint', 'severity:high']
  suggested_project_id?: string; // inferred from producer context
}

export interface KanbanCardDraft {
  title: string;
  body_md: string;
  project_id: string;
  board_id: string;
  list_id: string; // Planka "list" = column
  assignee_user_id?: string;
  labels: string[];
  source: {
    producer: ProducerId;
    run_id: string;
    output_id: string;
    stable_id: string;
  };
}

export interface ToolOutputSource {
  id: ProducerId;
  listOutputs(
    ctx: RequestContext,
    params: Record<string, string>,
  ): Promise<ToolOutput[]>;
  getOutput(ctx: RequestContext, output_id: string): Promise<ToolOutput>;
  toDraft(
    ctx: RequestContext,
    output: ToolOutput,
  ): Promise<Omit<KanbanCardDraft, 'list_id' | 'board_id' | 'assignee_user_id'>>;
}

// ---------------------------------------------------------------------------
// Internal helpers — narrower string-union types used inside the bridge domain.
// ---------------------------------------------------------------------------

/** card_drafts.status enum (see schema.ts::cardDrafts). */
export type DraftStatus =
  | 'editing'
  | 'submitted'
  | 'committed'
  | 'rejected'
  | 'deduped';

/**
 * card_drafts.initiator enum.
 *
 * NOTE: this differs from `RequestContext.initiator` (which is
 * `'human' | 'agent' | 'cron'`). The spec calls the human variant `'user'`
 * for the draft row; routes are responsible for mapping `'human' → 'user'`
 * when persisting.
 */
export type Initiator = 'user' | 'agent' | 'cron';

/**
 * The drizzle handle this domain accepts. Aliasing `typeof db` so test fakes
 * and future tx-scoped handles type-check without dragging the concrete
 * `PostgresJsDatabase<typeof schema>` generic through every service signature.
 */
export type BridgeDb = typeof db;

// ---------------------------------------------------------------------------
// Service-level value objects (kept here so the registry / services share them).
// ---------------------------------------------------------------------------

/** Lookup result from DedupService.lookup(). */
export interface DedupLookupResult {
  match: 'stable_id' | 'digest' | null;
  card_id?: string;
}

/** Bridge request scope — the (user, project) tuple every service method needs. */
export interface BridgeCtx {
  request: RequestContext;
  user_id: string;
  project_id: string;
  /**
   * Migration 042 — required when SubmitService creates an approval row.
   * Populated from `validateAuth(req).tenantId` at the route layer
   * (see `routes/tools/bridge.ts buildBridgeCtx`).
   */
  tenant_id: string;
}
