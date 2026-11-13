// The guard for the scope_level contract drift.
//
// `POST /api/projects` (producer) and `POST /api/cards/improvement` (consumer)
// must speak ONE vocabulary. They didn't: the project door was
// `z.string().optional()` while the card schema was a strict enum, so
// 'single_repo' (AA drive scripts) and 'small' (fr UI select) sailed through
// project creation and then 400'd every approval card the intake orchestrator
// tried to mint — silently, because the workflow swallowed the error.
//
// This test fails if the two ever diverge again.

import { describe, expect, test } from "bun:test";

import { ProjectCreateSchema } from "../../../src/types/api";
import { CardGenerationRequest } from "../../../src/services/improvement-cards/request-schema";
import { SCOPE_LEVELS } from "../../../src/types/scope-level";

const validProject = {
  name: "p",
  repository_url: "https://github.com/o/r",
};

const validCard = {
  card_type: "decision_development",
  project_id: "p1",
  parent_card_id: null,
  target_list: "TODO",
  requestor: "n8n",
  problem_statement: "x",
  desired_outcome: "y",
  success_criteria: ["a"],
  acceptance_criteria: ["b"],
};

describe("scope_level is one vocabulary end-to-end", () => {
  test("every value the project door accepts, the card consumer also accepts", () => {
    for (const level of SCOPE_LEVELS) {
      // ⚠️ 'multi_repo' now needs a SECOND repository on the project door (the
      // repo/scope coherence refine on ProjectCreateSchema). Without this the
      // loop would fail on one of the eight levels for a reason that has nothing
      // to do with the vocabulary this test is about — see
      // tests/unit/types/project-create-repo-scope-coherence.test.ts.
      const repoForLevel =
        level === "multi_repo"
          ? {
              repo: {
                primary: { url: "https://github.com/o/r" },
                additional: [{ url: "https://github.com/o/r2" }],
              },
            }
          : {};
      expect(
        ProjectCreateSchema.safeParse({ ...validProject, ...repoForLevel, scope_level: level })
          .success,
      ).toBe(true);
      expect(
        CardGenerationRequest.safeParse({ ...validCard, scope_level: level })
          .success,
      ).toBe(true);
    }
  });

  // The exact values that were live in prod and broke the approval layer.
  test.each(["single_repo", "small", "medium", "large", "enterprise"])(
    "the project door rejects the legacy value %p instead of passing it downstream",
    (legacy) => {
      const res = ProjectCreateSchema.safeParse({
        ...validProject,
        scope_level: legacy,
      });
      expect(res.success).toBe(false);
    },
  );

  test("scope_level stays optional on projects (null → n8n defaults to module)", () => {
    expect(ProjectCreateSchema.safeParse(validProject).success).toBe(true);
  });
});
