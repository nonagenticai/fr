// The MACRO project lifecycle phase rail — pure projection over a phase LIST.
// Distinct from `lib/phase.ts`, which is the MICRO card mantra (READYING →
// DOING → INSPECTING → PUBLISHING) within a single card.
//
// ⭐ fr HOLDS NO PHASE VOCABULARY (design: fr consumes RM vocabulary, George
// 2026-10-12). A project's phases are the ORDERED phases of its project type in
// the tenant's requirements_management catalogue, with RM's titles and RM's
// `has_gate` (services/catalogue/tenant-catalogue.ts `phasesOfProject`). This
// module only projects such a list into rail nodes. The old 11-phase spine, its
// labels, the frontend mirror and the off-spine `continuous` phase are gone
// (`continuous` was dropped: continuous projects are out of scope, George 10-11).
//
// Pure and import-free.

/** One phase of a project type, in order (RM `ProjectTypePhaseOut`). */
export interface PhaseSpec {
  name: string;
  title: string;
  /** RM-derived: a gate guards this phase's exit. */
  has_gate: boolean;
  phase_id?: string;
}

export type RailNodeState = 'done' | 'active' | 'gate' | 'upcoming';

export interface RailNode {
  phase: string;
  label: string;
  state: RailNodeState;
  isGate: boolean;
  /**
   * PLAN projects only (fr#1482): the approval kinds gating this phase's EXIT
   * (phase_plan.gates).
   */
  gate_kinds?: string[];
}

function indexOf(phases: readonly PhaseSpec[], name: string): number {
  return phases.findIndex((p) => p.name === name);
}

/** Is `name` one of `phases`? (Input validation for a phase a caller names.) */
export function isPhaseOf(phases: readonly PhaseSpec[], name: unknown): name is string {
  return typeof name === 'string' && indexOf(phases, name) >= 0;
}

/**
 * Project the type's phases into rail nodes relative to `current`: before it
 * `done`, it `active`, an upcoming gated phase `gate`, the rest `upcoming`.
 * A new project's `current` is `setup` (RM sets it at create — v4 D16), a
 * normal phase of its type. `current` null is only a DEFENSIVE fallback (RM
 * holds no phase): every node is pending (`gate` / `upcoming`), none done or
 * active.
 * Null when `current` is not one of the phases — the caller reports the rail
 * unavailable rather than inventing a position.
 */
export function railNodes(phases: readonly PhaseSpec[], current: string | null): RailNode[] | null {
  const idx = current === null ? -1 : indexOf(phases, current);
  if (current !== null && idx < 0) return null;
  return phases.map((p, i): RailNode => {
    const state: RailNodeState = i < idx ? 'done' : i === idx ? 'active' : p.has_gate ? 'gate' : 'upcoming';
    return { phase: p.name, label: p.title, state, isGate: p.has_gate };
  });
}

/**
 * The first gated phase at or after `current`, or null (none, or `current` not
 * a phase). `current` null = not started: searched from the start of the list.
 */
export function nextGate(phases: readonly PhaseSpec[], current: string | null): string | null {
  const idx = current === null ? 0 : indexOf(phases, current);
  if (idx < 0) return null;
  for (let i = idx; i < phases.length; i++) if (phases[i]!.has_gate) return phases[i]!.name;
  return null;
}
