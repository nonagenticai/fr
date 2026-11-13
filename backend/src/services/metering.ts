// src/services/metering.ts
//
// Response contract for the fr "My licenses & tokens" page metering cards.
//
// Until 2026-05-24 this module also held a subject-scoped `meteringClient`
// (GET /api/usage/me + /api/costs/me). That was removed: real metering rolls
// up under a NULL-subject sentinel, so the per-subject view was structurally
// always $0. The licenses page now scopes its usage/cost cards to the active
// WORKSPACE via the tenant-scoped wrappers in `integrations/metering/usage.ts`
// (mirroring /settings/usage after #309). These types remain the shape the
// route adapts back into and the frontend reads.

export interface UsageBucket {
  service_key: string;
  request_count: number;
  denied_count: number;
  budget_denied_count: number;
}

export interface MyUsageResponse {
  subject_id: string;
  period: { from: string; to: string };
  totals: { request_count: number; denied_count: number; budget_denied_count: number };
  by_service: UsageBucket[];
}

export interface CostBucket {
  provider: string;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: string;
}

export interface MyCostsResponse {
  subject_id: string;
  period: { from: string; to: string };
  /**
   * `total_cost_usd` is incurred for a super-admin, billed for everyone else,
   * and `null` (`cost_basis: 'unavailable'`) when the tenant's markup cannot be
   * established — never the incurred figure for a non-super-admin.
   */
  totals: { input_tokens: number; output_tokens: number; total_cost_usd: string | null };
  cost_basis: 'incurred' | 'billed' | 'unavailable';
  by_provider: CostBucket[];
}
