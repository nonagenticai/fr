// outputs.ts — the shapes of GET /api/projects/:id/outputs (backend services/cockpit/document-trail.ts).

export type TrailStatus = 'published' | 'in_review' | 'draft';

export interface TrailVersion {
  number: number;
  artifact_id: string;
  review_artifact_id: string;
  status: TrailStatus | null;
  review_status: string | null;
  at: string | null;
  title: string;
  summary: string | null;
}

export interface TrailDocument {
  key: string;
  artifact_id: string;
  review_artifact_id: string;
  title: string;
  type_label: string;
  status: TrailStatus | null;
  review_status: string | null;
  version: number;
  version_count: number;
  at: string | null;
  summary: string | null;
  phase: string | null;
  card_id: string | null;
  card_name: string | null;
  is_final: boolean;
  reviewable: boolean;
  versions: TrailVersion[];
}

export interface TrailPullRequest {
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged' | null;
  at: string | null;
  card_name: string | null;
  phase: string | null;
}

export interface TrailPhase {
  name: string;
  label: string;
  state: string;
  current: boolean;
  documents: TrailDocument[];
  pull_requests: TrailPullRequest[];
}

export type ProjectOutputs =
  | { available: false; project_id: string; reason: string }
  | {
      available: true;
      project_id: string;
      state: string | null;
      finished: boolean;
      current_phase: string | null;
      final_report: TrailDocument | null;
      phases: TrailPhase[];
      unassigned: { documents: TrailDocument[]; pull_requests: TrailPullRequest[] };
      partial: string[];
    };
