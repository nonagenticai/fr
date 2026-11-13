// src/lib/knowledge-areas.ts
//
// THE KNOWLEDGE-AREA VOCABULARY, AND THE PURE RULES OVER IT.
//
// ── WHAT A KNOWLEDGE AREA IS ────────────────────────────────────────────────
// A knowledge area says WHO TO ASK. "For api questions member A, for business
// decisions member B." It is not a job title, not a RACI letter, and — this is
// the one that matters — NOT AN AUTHORITY. Holding `architecture` here grants
// nothing: authority lives in `user_roles` (CHECK-locked to 'workspace-admin' |
// 'workspace-member' by migration 104) and nowhere else.
//
// ── THE VOCABULARY IS THE TENANT'S RM CAPABILITIES ─────────────────────────
// ⭐ Design "fr consumes RM vocabulary", George's Q1 = (a), 2026-10-12: fr's 15
// `card_groups` are REPLACED by the tenant's requirements_management
// capabilities. A tenant's knowledge areas = the NAMES of its RM capabilities
// (read through services/catalogue/tenant-catalogue.ts), and a card's area is
// its card type's capability — so a question still maps to an area with no human
// tagging step. Knowledge areas are therefore PER TENANT; there is no global
// list in fr, no DB CHECK (migration 187 dropped 135's) and no frontend mirror.
// A tenant with no capabilities is `catalogue_not_initialised` (409).

// ── COVERAGE STARTS AT ZERO, AND THAT MUST STAY VISIBLE ────────────────────
// ⚠️ MEASURED on the prod primary 2026-09-27: `user_roles` holds 13 grants
// across 13 distinct tenants — one user each — and `member_knowledge_areas` is
// brand new, so NOBODY has an area recorded. Every consumer must therefore be
// able to say "nobody has an area recorded" and REFUSE, rather than compute a
// ranking over an empty property and suggest nothing silently. `hasAnyCoverage`
// below is that question, in one place, so no consumer has to reinvent it.

// ── ⛔ WHAT IS DELIBERATELY NOT BUILT HERE (a note, not code) ───────────────
// The obvious next step is to feed these areas into
// `src/domain/engagement/approval-routing.ts` so a consultation is routed to the
// member who holds the matching area. That is NOT in this change, on purpose, and
// it is not a small addition:
//
//  * It touches the APPROVALS ROSTER. Read approval-routing.ts:240-262 first. Its
//    own measurement (prod, 2026-08-29) is that the PUSH_CHANNELS ladder is
//    BYPASSED on the arm that carries projects — a card WITH a project takes its
//    approvers verbatim from `project_stakeholders` role='execution_signoff', and
//    the only test applied is `approverIds.length === 0`. 172 projects are rostered
//    to an inapp-only robot; 42 `inapp` deliveries marked `sent` produced zero
//    answers. Adding a new selection input to a resolver that is already bypassed
//    on its main arm would ship an unexercised claim.
//  * ⚠️ AND COVERAGE IS ZERO. `member_knowledge_areas` is new and empty, and
//    `user_roles` holds 13 grants across 13 tenants — ONE user each. A router that
//    ranked by area today would have nothing to rank on any tenant and would fall
//    through silently, which is indistinguishable from working. `hasAnyCoverage`
//    below exists so that consumer can REFUSE instead; it is not a substitute for
//    that consumer being written, reviewed and audited on its own.
//
// So: fill the data first (these endpoints are how), then build the routing
// consumer as its own change with its own audit.

import { z } from 'zod';

import {
  capabilities as catalogueCapabilities,
  cardTypes as catalogueCardTypes,
} from '../services/catalogue/tenant-catalogue';

/**
 * `project_stakeholders.role` values that are NOT knowledge areas and must never
 * be read, written or deleted by the allocation paths, even if a tenant named a
 * capability the same: the execution sign-off roster lives in that column too.
 */
export const NON_AREA_STAKEHOLDER_ROLES: readonly string[] = Object.freeze(['execution_signoff']);

/**
 * The tenant's knowledge areas: its RM capability names, sorted (a picker must
 * not reshuffle between reads), minus any reserved stakeholder role. Throws
 * CatalogueNotInitialised for a tenant with no capabilities.
 */
export async function knowledgeAreasOf(tenantId: string): Promise<string[]> {
  return (await catalogueCapabilities(tenantId))
    .map((c) => c.name)
    .filter((n) => !NON_AREA_STAKEHOLDER_ROLES.includes(n))
    .sort();
}

/** One area as a picker needs it: the capability, its title and the card types it covers. */
export interface KnowledgeAreaEntry {
  /** The RM capability NAME. The value written to the API, never a display label. */
  area: string;
  /** The RM capability title (display label). */
  title: string;
  /** The tenant's card types in this capability — what makes an area self-describing. */
  card_types: string[];
}

/** The tenant's areas with their card types, in `knowledgeAreasOf` order. */
export async function knowledgeAreaEntriesOf(tenantId: string): Promise<KnowledgeAreaEntry[]> {
  const [caps, types] = await Promise.all([
    catalogueCapabilities(tenantId),
    catalogueCardTypes(tenantId),
  ]);
  return caps
    .filter((c) => !NON_AREA_STAKEHOLDER_ROLES.includes(c.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c) => ({
      area: c.name,
      title: c.title,
      card_types: types.filter((t) => t.capability_id === c.id).map((t) => t.name),
    }));
}

/** The requested areas that are NOT in `vocabulary` (sorted, de-duplicated). */
export function unknownAreas(areas: readonly string[], vocabulary: readonly string[]): string[] {
  const known = new Set(vocabulary);
  return normaliseAreas(areas).filter((a) => !known.has(a));
}

/**
 * A knowledge area in a request body: SHAPE only (a non-empty capability name).
 * Membership is the tenant's RM capabilities, checked by the route with
 * `unknownAreas` — zod cannot know the tenant.
 */
export const KnowledgeArea = z.string().trim().min(1).max(200);

/**
 * The body both write paths take: a member's COMPLETE set of areas.
 *
 * ⭐ A FULL-SET REPLACEMENT, not a patch, and that is what makes the endpoint
 * idempotent: sending the same set twice is a no-op, and "remove an area" needs
 * no second verb. `[]` is a legal, meaningful body — it means this member holds
 * no areas — so it is deliberately NOT `.min(1)`.
 *
 * `.strict()` is load-bearing for the same reason it is on `GrantBody` in
 * routes/workspace/members.ts: a `tenant_id` smuggled into the body must be a
 * 422 today, not a field silently dropped that the next author "wires up".
 */
export const SetAreasBody = z
  .object({
    areas: z.array(KnowledgeArea).max(200),
  })
  .strict();

/** Duplicates collapsed, sorted — the canonical form of a requested set. */
export function normaliseAreas(areas: readonly string[]): string[] {
  return [...new Set(areas)].sort();
}

/**
 * ⭐ "Does ANYBODY in this tenant have an area recorded?"
 *
 * The question every consumer must ask before ranking anything. Coverage starts
 * at ZERO (measured: 13 members, one per tenant, and this table is new), and a
 * ranking computed over a property nobody fills in suggests nothing, silently,
 * and looks like a working feature. Asked here, once, rather than reinvented.
 */
export function hasAnyCoverage(
  rows: ReadonlyArray<{ areas: readonly string[] }>,
): boolean {
  return rows.some((r) => r.areas.length > 0);
}

/**
 * The minimal write plan that turns `current` into `desired`.
 *
 * ⭐ WHY A PLAN RATHER THAN "DELETE EVERYTHING, RE-INSERT EVERYTHING". Both
 * tables carry an `assigned_at` / `added_at` audit timestamp. A blind
 * delete-and-reinsert rewrites the timestamp of every area the admin did not
 * touch, so "held since" silently becomes "last time anybody pressed Save" on
 * every row — an audit field that answers a different question than its name.
 * Diffing keeps untouched rows untouched.
 *
 * Pure, and both inputs are normalised here so a caller cannot pass an
 * unsorted/duplicated set and get a plan that churns.
 */
export function planAllocation(
  current: readonly string[],
  desired: readonly string[],
): { toInsert: string[]; toDelete: string[]; changed: boolean } {
  const cur = new Set(normaliseAreas(current));
  const des = new Set(normaliseAreas(desired));
  const toInsert = [...des].filter((a) => !cur.has(a)).sort();
  const toDelete = [...cur].filter((a) => !des.has(a)).sort();
  return { toInsert, toDelete, changed: toInsert.length > 0 || toDelete.length > 0 };
}
