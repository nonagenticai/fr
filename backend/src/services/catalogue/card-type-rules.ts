// src/services/catalogue/card-type-rules.ts
//
// The RM card-type `rules[]` strings fr reads BY NAME (design: fr consumes RM
// vocabulary, "Things fr encodes that RM does not model": the reclassify-refused
// list, the dependency_upgrade subtype and ncn's coding set become card-type
// rules in requirements_management). They replace three vendored ncn lists
// (reclassify_target_refused / coding_card_types / the OD-6 subtype constant).
//
// ⛔ fr OWNS ONLY THE NAMES. Which card types carry a rule is the tenant's RM
// catalogue (services/catalogue/tenant-catalogue.ts `cardTypeHasRule` /
// `cardTypesWithRule`). A tenant whose card types carry none of these rules
// simply has none of the behaviour: no fallback list lives here.

import { cardType as catalogueCardType, cardTypeHasRule, cardTypes as catalogueCardTypes } from './tenant-catalogue';

/**
 * A RECLASSIFY may not target this type: its QA can never pass for a re-typed
 * card (was `reclassify_target_refused.vendored.json`, fr#1441).
 */
export const RULE_NO_RECLASSIFY_TARGET = 'no_reclassify_target';

/**
 * OD-6: a card of this type, spawned for a project whose `it_flow` is the
 * dependency flow (or absent), carries the Metadata `subtype:"dependency_upgrade"`
 * tag (was the hard-coded `development_chore` check).
 */
export const RULE_DEPENDENCY_UPGRADE = 'dependency_upgrade';

/** The Metadata subtype value the OD-6 rule stamps. */
export const DEPENDENCY_UPGRADE_SUBTYPE = 'dependency_upgrade';

/**
 * ncn's coding set (was `coding_card_types.vendored.json`): the card types whose
 * QA exit is decided ONLY by computed checks. `repo_write` = writes the repo;
 * `container_read_exec` = reads/executes in the workspace container; `setup` =
 * the workspace setup card. A card type carrying ANY of them is COMPUTED-GATED.
 */
export const RULE_REPO_WRITE = 'repo_write';
export const RULE_CONTAINER_READ_EXEC = 'container_read_exec';
export const RULE_SETUP = 'setup';
export const COMPUTED_GATE_RULES: readonly string[] = Object.freeze([
  RULE_REPO_WRITE,
  RULE_CONTAINER_READ_EXEC,
  RULE_SETUP,
]);

// ── the rule predicates (tenant-explicit, through the one reader) ───────────

/** Is `cardType` a RECLASSIFY target the tenant's catalogue refuses? */
export async function isReclassifyTargetRefused(tenantId: string, cardType: string): Promise<boolean> {
  return await cardTypeHasRule(tenantId, cardType, RULE_NO_RECLASSIFY_TARGET);
}

/** Is `cardType` computed-gated in the tenant's catalogue (any COMPUTED_GATE_RULES rule)? */
export async function isComputedGatedCardType(tenantId: string, cardType: unknown): Promise<boolean> {
  if (typeof cardType !== 'string' || cardType.trim() === '') return false;
  const ct = await catalogueCardType(tenantId, cardType.trim());
  return (ct?.rules ?? []).some((r) => COMPUTED_GATE_RULES.includes(r));
}

/**
 * OD-6 — the Metadata `subtype` a spawned card carries: `dependency_upgrade`
 * when the tenant's card type carries the `dependency_upgrade` rule AND the
 * project's `it_flow` is the dependency flow (`dependency`, or absent/empty =
 * the Flow-1 default per types/api.ts `it_flow`). A card of a rule-carrying
 * type bound to a non-dependency flow is NOT tagged. Undefined otherwise.
 */
export async function dependencyUpgradeSubtype(
  tenantId: string,
  cardType: string,
  itFlow?: string | null,
): Promise<typeof DEPENDENCY_UPGRADE_SUBTYPE | undefined> {
  if (itFlow != null && itFlow !== '' && itFlow !== 'dependency') return undefined;
  return (await cardTypeHasRule(tenantId, cardType, RULE_DEPENDENCY_UPGRADE))
    ? DEPENDENCY_UPGRADE_SUBTYPE
    : undefined;
}

/** Sync lookups over ONE read of the tenant's card types (for pure classifiers). */
export interface CardTypeRuleIndex {
  known: ReadonlySet<string>;
  reclassifyRefused: ReadonlySet<string>;
  computedGated: ReadonlySet<string>;
}

export async function cardTypeRuleIndex(tenantId: string): Promise<CardTypeRuleIndex> {
  const types = await catalogueCardTypes(tenantId);
  const has = (rules: readonly string[] | null | undefined, wanted: readonly string[]): boolean =>
    (rules ?? []).some((r) => wanted.includes(r));
  return {
    known: new Set(types.map((t) => t.name)),
    reclassifyRefused: new Set(types.filter((t) => has(t.rules, [RULE_NO_RECLASSIFY_TARGET])).map((t) => t.name)),
    computedGated: new Set(types.filter((t) => has(t.rules, COMPUTED_GATE_RULES)).map((t) => t.name)),
  };
}
