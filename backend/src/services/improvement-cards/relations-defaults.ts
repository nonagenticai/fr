// backend/src/services/improvement-cards/relations-defaults.ts
//
// Shared default values for the 7 non-Metadata customFieldGroups, used by
// both the runtime card-create path (`from-request.ts`) and the backfill
// script (`scripts/backfill-stream-slug-on-cards.ts`).
//
// Why a shared module: the backfill must produce the same defaults the
// runtime writes, otherwise a legacy card that gets backfilled would diverge
// from a new card created via /api/cards/improvement. Single source of truth.

export interface NonMetadataDefaults {
  Relations: Record<string, string>;
  'Acceptance Criteria': Record<string, string>;
  Validation: Record<string, string>;
  Requirements: Record<string, string>;
  Principles: Record<string, string>;
  Decisions: Record<string, string>;
  Procedures: Record<string, string>;
}

/**
 * Build the indexed `<prefix>_1..5` map. Pads with empty strings up to 5
 * because every Acceptance Criteria / Requirements / Principles / Decisions
 * group has exactly 5 slots provisioned (see `field-groups.ts:GROUP_FIELDS`).
 *
 * Exported so callers (from-request.ts, the backfill script, tests) share the
 * same implementation.
 */
export function indexed5(prefix: string, items: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    out[`${prefix}_${i + 1}`] = items[i] ?? '';
  }
  return out;
}

/**
 * Default values for the 7 non-Metadata groups when no request-schema
 * payload is available (i.e. backfill of legacy cards). For new cards
 * created via /api/cards/improvement, these are overlaid with values
 * derived from the request body — see `from-request.ts:valuesFromRequest`.
 *
 * Field names exactly match GROUP_FIELDS in `field-groups.ts`:
 *   Relations:            parent_card, child_cards, requires, required_by
 *   Acceptance Criteria:  criterion_1..5
 *   Validation:           scenario_titles, gherkin_summary, qa_exit_rule, blocked_conditions
 *   Requirements:         requirement_1..5
 *   Principles:           principle_1..5
 *   Decisions:            decision_1..5
 *   Procedures:           readying_procedure, doing_procedure, qa_procedure, done_procedure
 *
 * `cardType` drives the procedure-name fields (the only Procedures-group
 * defaults that aren't trivially blank). Names follow the `.` separator
 * convention matching the procedures-service regex
 * `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (`::` is rejected).
 */
export function nonMetadataDefaults(cardType: string): NonMetadataDefaults {
  return {
    Relations: {
      parent_card: '',
      child_cards: '[]',
      requires: '[]',
      required_by: '[]',
    },
    'Acceptance Criteria': indexed5('criterion', []),
    Validation: {
      scenario_titles: '[]',
      gherkin_summary: '',
      qa_exit_rule: '',
      blocked_conditions: '[]',
    },
    Requirements: indexed5('requirement', []),
    Principles: indexed5('principle', []),
    Decisions: indexed5('decision', []),
    Procedures: {
      readying_procedure: `${cardType}.readying.action`,
      doing_procedure: `${cardType}.doing.action`,
      qa_procedure: `${cardType}.qa.action`,
      done_procedure: `${cardType}.done.action`,
    },
  };
}
