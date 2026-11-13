// The single canonical `project_data.question_mode` vocabulary (fr#1388, U3/A6).
//
// The conveyor picks its QUESTION path per project from this key:
//   'structured' → execution.question, registered answers, one question per approval
//   'free_text'  → today's QUESTION path
//   absent       → 'free_text'
// ncn reads it via GET /api/projects/:id before minting, and moves the card to
// BLOCKED (`question_mode_invalid`) on any PRESENT value outside this set. This
// file exists so a typo is refused at the door (project create + PATCH) instead
// of being discovered when a card blocks.
//
// ⚠️ PROVENANCE of the two literals: at the time of writing, NO ncn code reads
// `question_mode` yet (git grep over every ref of nonagenticai/n8n_custom_nodes
// returned nothing). They are spelled from the coordinator's U3/A6 ruling as
// recorded in fr#1388. When the ncn consumer lands, re-check its literals
// against this tuple — a divergence here is a gate that never opens.
//
// Import this from every schema that accepts the key. Do not re-declare the list.

import { z } from "zod";

export const QUESTION_MODES = ["structured", "free_text"] as const;

export type QuestionMode = (typeof QUESTION_MODES)[number];

/** Exact-match, case-sensitive: 'Structured' and non-strings are refused. */
export const QuestionModeSchema = z.enum(QUESTION_MODES);
