// src/types/project-constraints.ts
//
// WHAT A PROJECT REQUEST IS ALLOWED TO FORBID.
//
// ── WHY THIS IS TYPED AND NOT A TEXTAREA ─────────────────────────────────────
//
// `constraints` and `dependencies` reached this codebase as `z.array(z.string())`
// on ProjectCreateSchema. MEASURED 2026-09-21 by an exhaustive grep of
// backend/src for `project_data.<key>`: the only keys ANY code reads back are
// keycloak_tenant_id, it_flow, approvers, requestor, fixture, problem_statement,
// desired_outcome, business_case, acceptance_criteria, success_criteria,
// target_packages and artifacts. `constraints`, `dependencies` and `risks`
// return ZERO matches. The user typed a rule, the database stored it, and no
// brief, card or agent ever saw it.
//
// ⭐ A free-text constraint an agent may ignore is not a constraint — it is a
// wish with a database row. So the vocabulary is typed: every `kind` below
// except `custom` is MACHINE-CHECKABLE AGAINST A DIFF, which is what makes a
// future enforcement gate possible at all. `custom` exists because a closed
// vocabulary that cannot express the user's actual rule gets worked around by
// stuffing prose into whichever field is nearest, and then we have free text
// anyway but in the wrong column.
//
// ⚠️ `custom` IS AGENT-READ-ONLY AND THE UI MUST SAY SO. The difference between
// "the system will hold you to this" and "we will pass this along and hope"
// is the whole reason to have two categories, and a user who cannot see which
// one they picked has not been told the truth about their own request.
//
// ── SCOPE: WHAT IS ENFORCED, AND WHERE ───────────────────────────────────────
//
// FIVE kinds are ENFORCED AT LANDING: `services/constraint-check.ts` evaluates
// a PR's file list + patches against them, served as
// `POST /api/projects/constraint-check` (op `project.constraintCheck`). n8n's
// merge paths call it before merging and merge ONLY on a 200
// `pass`/`unchecked_only` (fail-closed). Those five are `CHECKABLE_KINDS`
// below — the single source of truth for "the system will hold you to this".
//
// ✅ MEASURED 2026-09-23: that n8n wiring IS LIVE — landed by n8n_custom_nodes
// PR #1590 (`32295db0`) and PR #1607 (`0f202ede`), in TWO merge paths, before
// every conveyor merge. A violation refuses with
// `merge_refused_constraint_violation`; an unreadable answer refuses with
// `merge_refused_constraint_check_failed`. This paragraph previously ended
// "check it is live before telling a user their rule is enforced", and the
// frontend mirror went further and asserted nothing enforced these AT ALL —
// which was false and was believed. To re-check rather than trust: grep
// n8n_custom_nodes for both `merge_refused_constraint_*` tokens WITH a positive
// control in the same search.
//
// ⚠️ AND THE LIMIT, so nobody over-corrects: this is a PRE-MERGE gate on a PR
// DIFF. Nothing evaluates an outline, plan or card against these constraints at
// authoring time — there is no PR then.
//
// ⚠️ `must_keep_api_compatible` and `custom` are AGENT-ONLY: delivered in the
// brief, checked by nothing, and reported by the gate as `unchecked` so no
// caller can mistake their silence for a pass. `must_keep_api_compatible` WAS
// listed as "machine-checkable" here before enforcement existed; it is not
// diff-checkable by any rule we have (a breaking change need not touch a
// recognisable file), so claiming it would be an overclaim. Say "the agent is
// told" for those two — never "the agent is prevented".
//
// Legacy `string` constraints (pre-vocabulary rows) are likewise unchecked.

import { z } from "zod";

/**
 * A rule the requester places on how their repository may be changed.
 *
 * Discriminated on `kind` so a reader can switch exhaustively and the compiler
 * catches a new kind that some consumer forgot to handle — the failure mode a
 * `string` union cannot produce.
 */
export const ProjectConstraintSchema = z.discriminatedUnion("kind", [
  // "do not upgrade the language version" — the example that prompted this.
  z.object({ kind: z.literal("no_language_version_change") }),

  // Stronger: pin it to an exact version, so a DOWNgrade is also a violation.
  z.object({
    kind: z.literal("pin_language_version"),
    language: z.string().min(1),
    version: z.string().min(1),
  }),

  z.object({ kind: z.literal("no_dependency_upgrades") }),
  z.object({ kind: z.literal("no_new_dependencies") }),

  // Paths the work may not touch. Globs, matched against the diff's file list.
  z.object({
    kind: z.literal("no_files_touched"),
    globs: z.array(z.string().min(1)).min(1),
  }),

  z.object({ kind: z.literal("must_keep_api_compatible") }),

  // ⚠️ THE ESCAPE HATCH. Delivered to the agent verbatim and checkable by
  // nothing. The UI must label it as such — see the header.
  z.object({
    kind: z.literal("custom"),
    text: z.string().min(1).max(2000),
  }),
]);

export type ProjectConstraint = z.infer<typeof ProjectConstraintSchema>;

/**
 * Something the project must keep working with. Maps onto
 * `CardGenerationRequest.dependencies` (services/improvement-cards/
 * request-schema.ts:42) and from there to `Relations.requires` — plumbing that
 * already existed and that the project form was simply never connected to.
 */
export const ProjectDependencySchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(["service", "library", "api"]),
  note: z.string().max(2000).optional(),
});

export type ProjectDependency = z.infer<typeof ProjectDependencySchema>;

/**
 * The kinds ENFORCED at landing by `services/constraint-check.ts`. Single source
 * of truth: the gate, `isMachineCheckable` and the UI badge all derive from it.
 * Adding a kind here without a rule in constraint-check.ts is a lie the gate's
 * exhaustiveness test catches.
 */
export const CHECKABLE_KINDS = [
  "no_language_version_change",
  "pin_language_version",
  "no_dependency_upgrades",
  "no_new_dependencies",
  "no_files_touched",
] as const satisfies readonly ProjectConstraint["kind"][];

export type CheckableKind = (typeof CHECKABLE_KINDS)[number];

/** @deprecated alias of CHECKABLE_KINDS, kept for existing importers. */
export const MACHINE_CHECKABLE_CONSTRAINT_KINDS = CHECKABLE_KINDS;

/**
 * True when a constraint is ENFORCED at landing (see CHECKABLE_KINDS).
 *
 * Exists so the UI can tell the user which of their rules the system can hold
 * them to, rather than presenting all constraints as equally binding. That
 * honesty is the point of splitting `custom` out at all.
 */
export function isMachineCheckable(c: ProjectConstraint): boolean {
  return (CHECKABLE_KINDS as readonly string[]).includes(c.kind);
}

/**
 * One-line human rendering, for a brief or a card description.
 *
 * ⚠️ This is what an AGENT reads. Keep it imperative and unambiguous: it is the
 * difference between a rule the model follows and a label it skims past.
 */
export function describeConstraint(c: ProjectConstraint): string {
  switch (c.kind) {
    case "no_language_version_change":
      return "Do NOT change the language version.";
    case "pin_language_version":
      return `Keep ${c.language} pinned at exactly ${c.version}; do not upgrade or downgrade it.`;
    case "no_dependency_upgrades":
      return "Do NOT upgrade any existing dependency.";
    case "no_new_dependencies":
      return "Do NOT add any new dependency.";
    case "no_files_touched":
      return `Do NOT modify these paths: ${c.globs.join(", ")}.`;
    case "must_keep_api_compatible":
      return "The public API must remain backwards compatible; no breaking changes.";
    case "custom":
      return c.text;
  }
}

/**
 * Render whatever `project_data.constraints` holds into prose an agent reads.
 *
 * ⚠️ TWO SHAPES LIVE IN THAT COLUMN AND BOTH ARE REAL. Every project created
 * before the typed vocabulary carries `string[]`, because ProjectCreateSchema
 * declared `z.array(z.string())`. Those rows are not migrated — there is no
 * safe automatic reading of "do not upgrade python" into
 * `{kind:'pin_language_version'}`, and guessing would manufacture a
 * machine-checkable promise the user never made. So a legacy string is
 * rendered verbatim and treated exactly like `custom`: delivered, not checked.
 *
 * Returns null rather than an empty string when there is nothing to say, so a
 * consumer can distinguish "no constraints" from "constraints we failed to
 * render".
 */
export function renderConstraintsForBrief(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const lines: string[] = [];
  for (const item of raw) {
    // Legacy free text, from before the vocabulary existed.
    if (typeof item === "string") {
      const t = item.trim();
      if (t) lines.push(t);
      continue;
    }
    // Typed. Parse rather than cast: project_data is jsonb and nothing
    // guarantees a row matches the current union — a shape that fails to parse
    // must not take the whole brief down with it.
    const parsed = ProjectConstraintSchema.safeParse(item);
    if (parsed.success) {
      lines.push(describeConstraint(parsed.data));
      continue;
    }
    // Unknown shape: say so plainly rather than dropping it. A constraint the
    // user set and the agent never sees is the exact defect being fixed, and a
    // silent drop here would reproduce it one layer further in.
    lines.push(`(unrecognised constraint: ${JSON.stringify(item)})`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}
