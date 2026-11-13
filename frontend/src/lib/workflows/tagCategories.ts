// tagCategories.ts
//
// SUPERSEDED by the faceted tag system. Workflow tags are now namespaced
// (`domain:`/`purpose:`/`stage:`/`trigger:`) and the backend returns them
// already grouped into facets (see `$lib/workflows/facets.ts` and the
// `FacetedTags` shape in `$lib/api/workflows.ts`). The old flat-tag →
// trigger_registry.md category bucketing this file used to do is gone;
// non-namespaced tags now fall into the backend's `other` bucket and are
// rendered as the "Other tags" facet section.
//
// Kept (not deleted) only as the home of the shared "Other" label.

/** Sidebar heading for non-namespaced ("manual") tags. */
export const OTHER_LABEL = 'Other tags';
