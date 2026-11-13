// Project-type matrix editor state: phase rows × capability groups → card-type
// checkboxes, plus (RM Tier 1) entry toggles and per-phase output / exit-rule
// overrides. Pure; the page binds to the state and sends `matrixPutBody`.
//
// ⚠️ A phase left out of the PUT loses its card types, so the body always
// carries EVERY phase with its full `card_type_ids` and `entry_card_type_ids`.
//
// ⛔ The overrides trap. GET returns the EFFECTIVE `output` / `exit_rule` (the
// override, else the phase's own value) PLUS `output_override` /
// `exit_rule_override`. PUT `output` / `exit_rule` SET the override. So the form
// hydrates from `*_override` — never from the effective value — and the PUT
// carries `output` / `exit_rule` ONLY for a phase whose override the user
// changed (omitted = unchanged; null = remove the override). Copying the GET
// `output` into a PUT would silently freeze the phase's value as an override.
//
// ⚠️ Tier 1 keys are sent only when the GET showed RM carries them. RM's
// `PhaseCardTypesIn` is `extra="forbid"`; an older RM would 422 a body that
// names `entry_card_type_ids` / `output` / `exit_rule`.

import type {
  CardType,
  ConveyorCapability,
  MatrixPhase,
  MatrixPhasePut,
  ProjectTypeMatrix,
  ProjectTypeMatrixPut,
} from '$lib/api/conveyor-catalogue';

export interface MatrixPhaseState {
  phase_id: string;
  name: string;
  title: string;
  position: number;
  has_gate?: boolean;
  selected: string[];
  entry: string[];
  /** The override typed for this project type; '' = none (the phase's own value applies). */
  outputOverride: string;
  exitRuleOverride: string;
  /** The override as RM reported it (`*_override`), to send only a changed one. */
  initialOutputOverride: string;
  initialExitRuleOverride: string;
  /** The effective values RM reported, for display. */
  effectiveOutput: string | null;
  effectiveExitRule: string | null;
  outputOverridden: boolean;
  exitRuleOverridden: boolean;
}

export interface MatrixState {
  /** RM reported Tier 1 matrix fields (is_entry / overrides). */
  tier1: boolean;
  phases: MatrixPhaseState[];
}

/** Did RM send any Tier 1 matrix key? */
export function matrixHasTier1(m: ProjectTypeMatrix): boolean {
  return m.phases.some(
    (p) =>
      'output_overridden' in p ||
      'exit_rule_overridden' in p ||
      'output_override' in p ||
      'exit_rule_override' in p ||
      p.capabilities.some((c) => c.card_types.some((ct) => 'is_entry' in ct)),
  );
}

function phaseState(p: MatrixPhase): MatrixPhaseState {
  const cts = p.capabilities.flatMap((c) => c.card_types);
  // From the OVERRIDE field only (see the header): never from effective `output`.
  const outputOverride = p.output_override ?? '';
  const exitRuleOverride = p.exit_rule_override ?? '';
  return {
    phase_id: p.phase_id,
    name: p.name,
    title: p.title,
    position: p.position,
    has_gate: p.has_gate,
    selected: cts.map((c) => c.card_type_id),
    entry: cts.filter((c) => c.is_entry === true).map((c) => c.card_type_id),
    outputOverride,
    exitRuleOverride,
    initialOutputOverride: outputOverride,
    initialExitRuleOverride: exitRuleOverride,
    effectiveOutput: p.output ?? null,
    effectiveExitRule: p.exit_rule ?? null,
    outputOverridden: p.output_overridden === true,
    exitRuleOverridden: p.exit_rule_overridden === true,
  };
}

export function matrixState(m: ProjectTypeMatrix): MatrixState {
  const phases = [...m.phases].sort((a, b) => a.position - b.position).map(phaseState);
  return { tier1: matrixHasTier1(m), phases };
}

/** Tick / untick a card type in a phase. Unticking also drops it as an entry (an entry is a ticked type). */
export function toggleCardType(p: MatrixPhaseState, cardTypeId: string): MatrixPhaseState {
  if (p.selected.includes(cardTypeId)) {
    return {
      ...p,
      selected: p.selected.filter((id) => id !== cardTypeId),
      entry: p.entry.filter((id) => id !== cardTypeId),
    };
  }
  return { ...p, selected: [...p.selected, cardTypeId] };
}

export function toggleEntry(p: MatrixPhaseState, cardTypeId: string): MatrixPhaseState {
  return p.entry.includes(cardTypeId)
    ? { ...p, entry: p.entry.filter((id) => id !== cardTypeId) }
    : { ...p, entry: [...p.entry, cardTypeId] };
}

function overrideOrNull(v: string): string | null {
  return v.trim() === '' ? null : v;
}

/**
 * Every phase as RM's PUT body. `entry_card_type_ids` is always the subset of
 * the selection that is ticked as entry; `output` / `exit_rule` appear only for
 * a changed override (value = the override, '' ⇒ null = remove it).
 */
export function matrixPutBody(s: MatrixState): ProjectTypeMatrixPut {
  return {
    phases: s.phases.map((p): MatrixPhasePut => {
      if (!s.tier1) return { phase_id: p.phase_id, card_type_ids: [...p.selected] };
      const out: MatrixPhasePut = {
        phase_id: p.phase_id,
        card_type_ids: [...p.selected],
        entry_card_type_ids: p.entry.filter((id) => p.selected.includes(id)),
      };
      const output = overrideOrNull(p.outputOverride);
      if (output !== overrideOrNull(p.initialOutputOverride)) out.output = output;
      const exitRule = overrideOrNull(p.exitRuleOverride);
      if (exitRule !== overrideOrNull(p.initialExitRuleOverride)) out.exit_rule = exitRule;
      return out;
    }),
  };
}

export interface CapabilityGroup {
  capability: ConveyorCapability;
  cardTypes: CardType[];
}

/**
 * Every card type of the tenant, grouped under its conveyor capability (the
 * matrix columns). A card type whose capability is not in the list still shows,
 * under an "unknown capability" group named by its id, rather than vanishing.
 */
export function capabilityGroups(
  capabilities: readonly ConveyorCapability[],
  cardTypes: readonly CardType[],
): CapabilityGroup[] {
  const known = new Map(capabilities.map((c) => [c.id, c]));
  const groups = new Map<string, CapabilityGroup>();
  for (const c of capabilities) groups.set(c.id, { capability: c, cardTypes: [] });
  for (const ct of cardTypes) {
    let g = groups.get(ct.capability_id);
    if (!g) {
      g = {
        capability: known.get(ct.capability_id) ?? {
          id: ct.capability_id,
          name: ct.capability_id,
          title: `Unknown capability ${ct.capability_id}`,
        },
        cardTypes: [],
      };
      groups.set(ct.capability_id, g);
    }
    g.cardTypes.push(ct);
  }
  return [...groups.values()];
}
