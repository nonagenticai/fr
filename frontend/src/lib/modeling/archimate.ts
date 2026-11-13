// Words and layout for an ArchiMate model's contents (ArchimateModelContents).
//
// fr decides nothing about legality: the element types, their layers and the
// relationship types allowed between two types all come from
// requirements_management's metamodel (GET /architecture/metamodel/*). This
// module only names them in plain words and places new shapes on a view so
// they do not overlap.

import type { ArchitectureViewInViewpoint, Bounds } from '@fr/service-client-requirements';
import type { ArchimateElement, ArchimateRelationship, MetamodelConcept, ViewBounds } from '$lib/api/modeling';

/** The ArchiMate layers in reading order, with the name a user sees. */
export const LAYER_ORDER = ['strategy', 'business', 'application', 'technology', 'physical', 'motivation', 'implementation_migration', 'other'] as const;
export const LAYER_LABEL: Record<string, string> = {
  strategy: 'Strategy',
  business: 'Business',
  application: 'Application',
  technology: 'Technology',
  physical: 'Physical',
  motivation: 'Motivation',
  implementation_migration: 'Implementation and migration',
  other: 'Other',
};

const words = (s: string) => s.replace(/_/g, ' ');
const titleWords = (s: string) =>
  words(s)
    .split(' ')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');

/** `application_component` → "Application Component". */
export function elementTypeLabel(type: string): string {
  return titleWords(type);
}

export function layerLabel(layer: string | null | undefined): string {
  if (!layer) return 'No layer';
  return LAYER_LABEL[layer] ?? titleWords(layer);
}

/** The metamodel's concepts grouped by layer (layers in ArchiMate order, types by name), for a grouped type picker. */
export function conceptsByLayer(concepts: readonly MetamodelConcept[]): Array<{ layer: string; label: string; concepts: MetamodelConcept[] }> {
  const groups = new Map<string, MetamodelConcept[]>();
  for (const c of concepts) groups.set(c.layer, [...(groups.get(c.layer) ?? []), c]);
  const rank = (l: string) => {
    const i = (LAYER_ORDER as readonly string[]).indexOf(l);
    return i === -1 ? LAYER_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([layer, list]) => ({ layer, label: layerLabel(layer), concepts: [...list].sort((a, b) => elementTypeLabel(a.type).localeCompare(elementTypeLabel(b.type))) }));
}

/** The layer of a type, from the metamodel (never typed by the user). */
export function layerOfType(concepts: readonly MetamodelConcept[], type: string): string | null {
  return concepts.find((c) => c.type === type)?.layer ?? null;
}

/** The relationship type as a noun ("Realization"). */
export function relationshipTypeLabel(type: string): string {
  return titleWords(type);
}

/** The relationship type as a verb between two names. */
const VERB: Record<string, string> = {
  composition: 'is composed of',
  aggregation: 'aggregates',
  assignment: 'is assigned to',
  realization: 'realizes',
  serving: 'serves',
  access: 'accesses',
  influence: 'influences',
  triggering: 'triggers',
  flow: 'flows to',
  specialization: 'specializes',
  association: 'is associated with',
};

/** "Order System realizes Order Service". */
export function relationshipLabel(r: Pick<ArchimateRelationship, 'source_id' | 'target_id' | 'relationship_type'>, nameOf: ReadonlyMap<string, string>): string {
  const from = nameOf.get(r.source_id) ?? 'an element outside this model';
  const to = nameOf.get(r.target_id) ?? 'an element outside this model';
  return `${from} ${VERB[r.relationship_type] ?? words(r.relationship_type)} ${to}`;
}

export function elementLabel(e: Pick<ArchimateElement, 'title' | 'element_type'>): string {
  return `${e.title} (${elementTypeLabel(e.element_type)})`;
}

/** ArchiMate's usual figure size, and the grid new shapes are placed on. */
export const SHAPE_W = 120;
export const SHAPE_H = 55;
const GAP_X = 60;
const GAP_Y = 45;
const ORIGIN = 24;
const COLUMNS = 4;

const overlaps = (a: ViewBounds, b: ViewBounds) => {
  // Archi stores an unsized figure as w/h = -1 (its default size).
  const bw = b.w > 0 ? b.w : SHAPE_W;
  const bh = b.h > 0 ? b.h : SHAPE_H;
  return a.x < b.x + bw && b.x < a.x + a.w && a.y < b.y + bh && b.y < a.y + a.h;
};

/**
 * Where to put a new shape: the first free cell of a 4-column grid that
 * overlaps none of the shapes already on the view (including ones a user or an
 * import placed off the grid).
 */
export function nextShapeBounds(existing: ReadonlyArray<Bounds | null | undefined>): ViewBounds {
  // RM types every bound as optional: a shape missing one is placed at the origin, default-sized.
  const taken = existing.filter((b): b is Bounds => !!b).map((b): ViewBounds => ({ x: b.x ?? 0, y: b.y ?? 0, w: b.w ?? -1, h: b.h ?? -1 }));
  for (let i = 0; ; i++) {
    const cell: ViewBounds = {
      x: ORIGIN + (i % COLUMNS) * (SHAPE_W + GAP_X),
      y: ORIGIN + Math.floor(i / COLUMNS) * (SHAPE_H + GAP_Y),
      w: SHAPE_W,
      h: SHAPE_H,
    };
    if (!taken.some((b) => overlaps(cell, b))) return cell;
  }
}

/**
 * The name a user reads for each viewpoint RM accepts. Keyed by RM's GENERATED
 * enum (ArchitectureViewInViewpoint), so a viewpoint RM adds or drops fails the
 * typecheck instead of silently missing from the picker.
 */
const VIEWPOINT_LABEL: Record<NonNullable<ArchitectureViewInViewpoint>, string> = {
  application_cooperation: 'Application cooperation',
  application_structure: 'Application structure',
  application_usage: 'Application usage',
  business_process_cooperation: 'Business process cooperation',
  capability: 'Capability',
  capability_map: 'Capability map',
  goal_realization: 'Goal realization',
  implementation_deployment: 'Implementation and deployment',
  implementation_migration: 'Implementation and migration',
  information_structure: 'Information structure',
  landscape: 'Landscape',
  layered: 'Layered',
  migration: 'Migration',
  motivation: 'Motivation',
  organization: 'Organization',
  outcome_realization: 'Outcome realization',
  physical: 'Physical',
  product: 'Product',
  project: 'Project',
  requirements_realization: 'Requirements realization',
  resource: 'Resource',
  service_realization: 'Service realization',
  stakeholder: 'Stakeholder',
  strategy: 'Strategy',
  technology: 'Technology',
  technology_usage: 'Technology usage',
  value_stream: 'Value stream',
};

/** The viewpoints, named, for the picker. `null` = none (unfiltered, as in Archi). */
export const VIEWPOINTS: ReadonlyArray<[string, string]> = Object.entries(VIEWPOINT_LABEL);
