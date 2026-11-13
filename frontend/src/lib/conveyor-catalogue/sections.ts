// The conveyor catalogue's sections. Nav standard (owner ruling 2026-10-03):
// no tab strip inside a page, so each section is its own route and a row in the
// rail's "Conveyor catalogue" sub-group. `/library/conveyor/catalogue` is a 308
// to the first one, or to the section a `?tab=<slug>` names.

import type { LegacyTabMap } from '$lib/nav/legacyTab';
import type { CatalogueResource } from '$lib/api/conveyor-catalogue';

export const CATALOGUE_PREFIX = '/library/conveyor/catalogue';

export interface CatalogueSection {
  slug: string;
  label: string;
  resource: CatalogueResource;
  /** Tier 2 sections are read-only lists in fr for now (RM accepts writes; fr offers none yet). */
  readOnly?: boolean;
}

export const CATALOGUE_SECTIONS: readonly CatalogueSection[] = [
  { slug: 'phases', label: 'Project phases', resource: 'project-phases' },
  { slug: 'capabilities', label: 'Conveyor capabilities', resource: 'capabilities' },
  { slug: 'card-types', label: 'Card types', resource: 'card-types' },
  { slug: 'project-types', label: 'Project types', resource: 'project-types' },
  { slug: 'wip-limits', label: 'WIP limits', resource: 'wip-limits', readOnly: true },
  { slug: 'priority-levels', label: 'Priority levels', resource: 'priority-levels', readOnly: true },
  { slug: 'deliverable-kinds', label: 'Deliverable kinds', resource: 'deliverable-kinds', readOnly: true },
  { slug: 'milestone-kinds', label: 'Milestone kinds', resource: 'milestone-kinds', readOnly: true },
  { slug: 'board-templates', label: 'Board templates', resource: 'board-templates', readOnly: true },
];

export const CATALOGUE_TAB_MAP: LegacyTabMap = CATALOGUE_SECTIONS.map(
  (s) => [s.slug, `${CATALOGUE_PREFIX}/${s.slug}`] as const,
);
