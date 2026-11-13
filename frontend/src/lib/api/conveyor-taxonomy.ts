// GET /api/conveyor/taxonomy (fr#1477) — the read-only conveyor catalogue the
// /library/conveyor map renders (fr#1478). Every list in it is the caller
// tenant's requirements_management PM catalogue; nothing here re-declares one.

import { authFetch } from './auth-fetch';

export interface TaxonomyPhase {
  id: string;
  label: string;
  /** A human approval gate sits at this phase. */
  gate: boolean;
  /** Always false since phases come from RM (kept for the column styling). */
  off_spine: boolean;
}

export interface TaxonomyCapability {
  name: string;
  title: string;
  /** RM models no capability level: null. */
  level: string | null;
}

export interface TaxonomyCardType {
  id: string;
  title: string;
  capability: string | null;
  /** The first phase a project type composes it in; null = composed nowhere (the tray). */
  phase: string | null;
  /** The capability — drives the CardTypeBadge colour. */
  group: string | null;
}

export interface ConveyorTaxonomy {
  phases: TaxonomyPhase[];
  capabilities: TaxonomyCapability[];
  card_types: TaxonomyCardType[];
  templates: unknown[];
}

export async function fetchConveyorTaxonomy(): Promise<ConveyorTaxonomy> {
  const r = await authFetch('/api/conveyor/taxonomy');
  if (!r.ok) throw new Error(`fetchConveyorTaxonomy: HTTP ${r.status}`);
  // The route answers `{ data }` (fr's envelope-shape ratchet).
  return ((await r.json()) as { data: ConveyorTaxonomy }).data;
}
