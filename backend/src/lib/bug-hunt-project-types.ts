// The project types a bug hunt can be (one list, shared by the create guard in
// routes/projects.ts, and mirrored in SQL by
// migration 189's partial unique index + its declaration in db/schema.ts).
//
// - `bug_hunt_fix` — RM's bug-hunt project type (requirements_management PM defaults).
// - `it`           — ⚠️ LEGACY pre-RM fr type; RM's defaults dropped it. Kept only so
//                    hunts created before RM owned the vocabulary still resolve.

/** RM's bug-hunt project type: the project KIND whose hunt PR delivers it. */
export const BUG_HUNT_PROJECT_TYPE = 'bug_hunt_fix' as const;

/** ⚠️ LEGACY — the pre-RM fr type that carried `project_data.bug_hunt = true`. */
export const LEGACY_BUG_HUNT_PROJECT_TYPE = 'it' as const;

/** Project types that may carry `project_data.bug_hunt = true` (create accepts the flag only on these). */
export const BUG_HUNT_FLAG_PROJECT_TYPES = [LEGACY_BUG_HUNT_PROJECT_TYPE, BUG_HUNT_PROJECT_TYPE] as const;

export function isBugHuntFlagProjectType(t: string | null | undefined): boolean {
  return (BUG_HUNT_FLAG_PROJECT_TYPES as readonly string[]).includes(t ?? '');
}
