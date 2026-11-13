// src/services/conveyor/taxonomy.ts
//
// The read-only CONVEYOR TAXONOMY catalogue behind `GET /api/conveyor/taxonomy`
// (fr#1477, design D6/D8 §3 "A, Conveyor map").
//
// ⛔ SINGLE SOURCE: the caller TENANT's requirements_management PM catalogue
// (design: fr consumes RM vocabulary), read through the one reader. Phases are
// the tenant's RM phases (title, has_gate); capabilities are its RM
// capabilities; each card type's capability is its RM capability and its PHASE
// is the first tenant phase in which any of the tenant's project types composes
// it (RM `GET /pm/project-types/{id}/card-types`) — null when no project type
// composes it (the map's tray). The group (chip colour) IS the capability (Q1 =
// a). RM models no capability level and no concern overlay, so neither is
// served. Nothing here declares a list.
//
// TEMPLATES. pm `project_templates` owns templates (D6). fr has no resolver
// client yet, so `templates` is always `[]` and a `?template=` read answers
// 404 `template_not_found`. Template reads are restricted to platform tenants
// (EXEC + the internal tenants + the AA conveyor tenant) until A-G2 is decided;
// `canReadConveyorTemplates` is that check, applied BEFORE the lookup so the
// later resolver PR inherits it.

import { isPlatformTenant } from '../../middleware/internal-tenant-only';
import {
  capabilities as catalogueCapabilities,
  cardTypes as catalogueCardTypes,
  composition as catalogueComposition,
  phases as cataloguePhases,
  projectTypes as catalogueProjectTypes,
} from '../catalogue/tenant-catalogue';

export interface TaxonomyPhase {
  /** The RM phase name. */
  id: string;
  /** The RM phase title. */
  label: string;
  /** A gate guards this phase's exit (RM `has_gate`). */
  gate: boolean;
  /** Always false: every RM phase is on the tenant's spine (`continuous` was dropped). */
  off_spine: boolean;
}

export interface TaxonomyCapability {
  name: string;
  title: string;
  /** RM models no capability level: always null (the map shows one group). */
  level: string | null;
}

export interface TaxonomyCardType {
  id: string;
  title: string;
  /** The RM capability name. */
  capability: string | null;
  /** The first tenant phase a project type composes it in; null = composed nowhere (tray). */
  phase: string | null;
  /** The chip colour group — the capability (design Q1 = a). */
  group: string | null;
}

/** The catalogue every authenticated caller may read. */
export interface ConveyorTaxonomyPublic {
  phases: TaxonomyPhase[];
  capabilities: TaxonomyCapability[];
  card_types: TaxonomyCardType[];
  /** Always [] until fr reads pm templates (U-PT-CREATE). */
  templates: [];
}

/** The full response. */
export type ConveyorTaxonomy = ConveyorTaxonomyPublic;

/** The tenant's catalogue, as `buildConveyorTaxonomy` consumes it. */
export interface TaxonomyCatalogue {
  phases: ReadonlyArray<{ name: string; title: string; has_gate?: boolean }>;
  capabilities: ReadonlyArray<{ id: string; name: string; title: string }>;
  cardTypes: ReadonlyArray<{ name: string; title: string; capability_id: string }>;
  /** Per project type: phase name → the card type names composed in it. */
  compositions: ReadonlyArray<ReadonlyMap<string, readonly string[]>>;
}

/** Read the caller tenant's catalogue through the one reader (409 when not initialised). */
export async function loadTaxonomyCatalogue(tenantId: string): Promise<TaxonomyCatalogue> {
  const [phases, capabilities, cardTypes, types] = await Promise.all([
    cataloguePhases(tenantId),
    catalogueCapabilities(tenantId),
    catalogueCardTypes(tenantId),
    catalogueProjectTypes(tenantId),
  ]);
  const compositions = await Promise.all(
    types.map(async (t) => {
      const comp = await catalogueComposition(tenantId, t.name);
      const out = new Map<string, string[]>();
      for (const ph of (comp?.phases ?? []) as Array<{
        name?: string;
        capabilities?: Array<{ card_types?: Array<{ name?: string }> }>;
      }>) {
        if (!ph.name) continue;
        out.set(
          ph.name,
          (ph.capabilities ?? []).flatMap((c) => (c.card_types ?? []).map((ct) => ct.name ?? '')).filter(Boolean),
        );
      }
      return out;
    }),
  );
  return { phases, capabilities, cardTypes, compositions };
}

/** Build the catalogue. Pure. */
export function buildConveyorTaxonomy(cat: TaxonomyCatalogue): ConveyorTaxonomy {
  const phases: TaxonomyPhase[] = cat.phases.map((p) => ({
    id: p.name,
    label: p.title,
    gate: p.has_gate ?? false,
    off_spine: false,
  }));
  const capabilities: TaxonomyCapability[] = cat.capabilities.map((c) => ({
    name: c.name,
    title: c.title,
    level: null,
  }));
  const capName = new Map(cat.capabilities.map((c) => [c.id, c.name]));
  const phaseOf = new Map<string, string>();
  for (const p of cat.phases) {
    for (const comp of cat.compositions) {
      for (const ct of comp.get(p.name) ?? []) if (!phaseOf.has(ct)) phaseOf.set(ct, p.name);
    }
  }
  const card_types = cat.cardTypes.map((ct): TaxonomyCardType => {
    const cap = capName.get(ct.capability_id) ?? null;
    return { id: ct.name, title: ct.title, capability: cap, phase: phaseOf.get(ct.name) ?? null, group: cap };
  });

  return { phases, capabilities, card_types, templates: [] };
}

/**
 * May this tenant read conveyor templates? Platform tenants only until A-G2 is
 * decided (design D6). The future pm resolver client must be called only after
 * this returns true.
 */
export function canReadConveyorTemplates(tenantId: string | null | undefined): boolean {
  return isPlatformTenant(tenantId);
}
