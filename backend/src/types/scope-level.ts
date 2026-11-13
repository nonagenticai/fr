// The single canonical `scope_level` vocabulary.
//
// Why this file exists: `scope_level` had THREE incompatible vocabularies for
// one field name, and the project door accepted `z.string().optional()` — so
// any of them passed, and the mismatch only surfaced far downstream:
//
//   * fr UI (ProjectForm)  -> 'small' | 'medium' | 'large' | 'enterprise'  (a t-shirt SIZE)
//   * AA drive scripts     -> 'single_repo'                                (a repo COUNT)
//   * card request-schema  -> 'repo' | 'module' | ...                      (a code GRANULARITY)
//
// The card schema is the *consumer* — `POST /api/cards/improvement` hard-validates
// against it. Everything else was a producer writing a value the consumer could not
// accept, so every approval card minted by the AA intake orchestrator came back
// `400 validation_failed` while the workflow reported success. Measured on prod
// 2026-07-14: 208/275 projects carried 'single_repo' and 6 carried 'small' — i.e.
// ~78% of all projects could never mint an approval card, silently.
//
// Granularity wins because it is the meaning the consumer already enforces. Size
// is a different concept; if we want it back, it needs its own field.
//
// Import this from BOTH schemas. Do not re-declare the list anywhere.

import { z } from "zod";

export const SCOPE_LEVELS = [
  "multi_repo",
  "repo",
  "app",
  "module",
  "component",
  "file",
  "class",
  "function",
] as const;

export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

export const ScopeLevelSchema = z.enum(SCOPE_LEVELS);

/** Human labels for the UI select — keep in lock-step with SCOPE_LEVELS. */
export const SCOPE_LEVEL_LABELS: Record<ScopeLevel, string> = {
  multi_repo: "Multiple repositories",
  repo: "Single repository",
  app: "Application",
  module: "Module",
  component: "Component",
  file: "File",
  class: "Class",
  function: "Function",
};

/**
 * Legacy → canonical mapping for the values that reached prod before the door
 * was validated. Used by migration 088 to backfill existing rows. New writes are
 * rejected by ScopeLevelSchema, so this map is for historical data only — it is
 * deliberately NOT wired into the request path (a phantom value must fail loud
 * at the door, not be silently coerced).
 */
export const LEGACY_SCOPE_LEVEL_ALIASES: Record<string, ScopeLevel> = {
  single_repo: "repo", // exact synonym — the AA drive scripts' word for 'repo'
  small: "module",
  medium: "app",
  large: "repo",
  enterprise: "multi_repo",
};
