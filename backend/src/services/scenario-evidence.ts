/**
 * fr#1338 — `card_scenario_evidence` (migration 154): the bug-path repro
 * evidence (the full gherkin_scenarios entry, `test_file_content` included)
 * that POST /api/cards/project keeps OUT of Planka. Same lifecycle and shape
 * as `card_version_stamps` (services/improvement-cards/version-stamp.ts):
 * written for a NEW card inside the create-rollback try, deleted with a
 * rolled-back card; read by GET /api/cards/:id.
 *
 * Second writer (G-26 gap A): POST /api/cards/:id/scenario-evidence appends
 * evidence to an EXISTING card — `appendScenarioEvidence` (write-once per
 * (card, scenario_id), same sha ⇒ unchanged, different sha ⇒ conflict) and
 * `deleteAppendedScenarioEvidence` (undo of exactly the rows it created).
 */
import { queryClient } from '../db/client';
import { AppError } from '../utils/errors';
import type { ScenarioEvidence } from './gherkin-scenarios';

/**
 * Insert one row per evidence entry for a NEW card — ALL OR NOTHING, in one
 * transaction: if any row fails (a CHECK, a connection drop) or any row
 * already exists for (card, scenario), the whole set is rolled back and this
 * throws. So on return EVERY entry was written by this call; on a throw NONE
 * of them persists from this call. Returns the number written
 * (= evidence.length).
 *
 * ⛔ Refuses an empty card id; the migration's CHECKs refuse an over-cap file
 * and a sha256 that is not the content's.
 */
export async function insertScenarioEvidence(args: {
  cardId: string;
  projectId: string;
  evidence: ReadonlyArray<ScenarioEvidence>;
}): Promise<number> {
  if (typeof args.cardId !== 'string' || args.cardId.length === 0) {
    throw new Error('insertScenarioEvidence: refusing to write evidence without a real card_id');
  }
  if (args.evidence.length === 0) return 0;
  return queryClient.begin(async (tx) => {
    let inserted = 0;
    for (const e of args.evidence) {
      const rows = await tx`
        INSERT INTO card_scenario_evidence (card_id, scenario_id, project_id, test_file_sha256, entry)
        VALUES (
          ${args.cardId}::text,
          ${e.scenario_id}::text,
          ${args.projectId}::uuid,
          ${e.test_file_sha256}::text,
          ${JSON.stringify(e.entry)}::jsonb
        )
        ON CONFLICT (card_id, scenario_id) DO NOTHING
        RETURNING card_id
      `;
      inserted += rows.length;
    }
    if (inserted !== args.evidence.length) {
      // Throwing inside begin() rolls back the rows this call DID insert.
      throw new Error(
        `insertScenarioEvidence: card_scenario_evidence already holds rows for new card ${args.cardId}; nothing written`,
      );
    }
    return inserted;
  });
}

/** Delete a rolled-back card's evidence. Returns the rows removed. */
export async function deleteScenarioEvidence(cardId: string): Promise<number> {
  const rows = await queryClient`
    DELETE FROM card_scenario_evidence WHERE card_id = ${cardId}::text RETURNING card_id
  `;
  return rows.length;
}

export interface StoredScenarioEvidence {
  scenario_id: string;
  test_file_sha256: string;
  /** The entry as written, test_file_content included. */
  entry: Record<string, unknown>;
}

/** A card's evidence, ordered by scenario_id; [] when it has none. */
export async function loadScenarioEvidence(cardId: string): Promise<StoredScenarioEvidence[]> {
  const rows = await queryClient<StoredScenarioEvidence[]>`
    SELECT scenario_id, test_file_sha256, entry
      FROM card_scenario_evidence
     WHERE card_id = ${cardId}::text
     ORDER BY scenario_id
  `;
  return rows.map((r) => ({ scenario_id: r.scenario_id, test_file_sha256: r.test_file_sha256, entry: r.entry }));
}

// ── POST /api/cards/:id/scenario-evidence — append to an EXISTING card ───────

/** Per-entry outcome of `appendScenarioEvidence`. */
export interface AppendedScenarioEvidence {
  scenario_id: string;
  test_file_sha256: string;
  result: 'created' | 'unchanged';
  /**
   * `unchanged` only: the STORED entry (test_file_content included) — the
   * source of the card pointer when orphan repair has to re-append it.
   */
  stored_entry?: Record<string, unknown>;
}

/**
 * A stored row for (card, scenario_id) names a DIFFERENT sha256. Thrown from
 * inside the insert transaction, so nothing this call inserted survives.
 * A 409 `scenario_evidence_conflict` wherever it reaches a boundary.
 */
export class ScenarioEvidenceConflictError extends AppError {
  readonly conflicts: Array<{ scenario_id: string; stored_sha256: string; sent_sha256: string }>;
  constructor(conflicts: ScenarioEvidenceConflictError['conflicts']) {
    super(
      409,
      `card_scenario_evidence: ${conflicts.length} scenario(s) already hold DIFFERENT evidence; ` +
        'evidence is write-once, nothing written',
      { scenario_ids: conflicts.map((c) => c.scenario_id) },
    );
    this.name = 'ScenarioEvidenceConflictError';
    this.conflicts = conflicts;
    this.withCode('scenario_evidence_conflict');
  }
}

/**
 * WRITE-ONCE per (card_id, scenario_id), ALL OR NOTHING, in ONE transaction:
 *   - no row ⇒ inserted ⇒ `created`;
 *   - a row with the SAME sha256 ⇒ `unchanged` (no write);
 *   - a row with a DIFFERENT sha256 ⇒ `ScenarioEvidenceConflictError`, and the
 *     whole transaction rolls back — never an overwrite, never a partial set.
 * Results are in input order.
 */
export async function appendScenarioEvidence(args: {
  cardId: string;
  projectId: string;
  evidence: ReadonlyArray<ScenarioEvidence>;
  /**
   * Runs INSIDE the transaction, after every row is decided and no conflict
   * was found, before COMMIT. Throwing rolls back every row this call
   * inserted (the caller's own veto, e.g. a card document that cannot take
   * the pointers).
   */
  beforeCommit?: (results: ReadonlyArray<AppendedScenarioEvidence>) => void | Promise<void>;
}): Promise<AppendedScenarioEvidence[]> {
  if (typeof args.cardId !== 'string' || args.cardId.length === 0) {
    throw new Error('appendScenarioEvidence: refusing to write evidence without a real card_id');
  }
  if (args.evidence.length === 0) return [];
  return queryClient.begin(async (tx) => {
    const out: AppendedScenarioEvidence[] = [];
    const conflicts: ScenarioEvidenceConflictError['conflicts'] = [];
    for (const e of args.evidence) {
      const inserted = await tx`
        INSERT INTO card_scenario_evidence (card_id, scenario_id, project_id, test_file_sha256, entry)
        VALUES (
          ${args.cardId}::text,
          ${e.scenario_id}::text,
          ${args.projectId}::uuid,
          ${e.test_file_sha256}::text,
          ${JSON.stringify(e.entry)}::jsonb
        )
        ON CONFLICT (card_id, scenario_id) DO NOTHING
        RETURNING card_id
      `;
      if (inserted.length === 1) {
        out.push({ scenario_id: e.scenario_id, test_file_sha256: e.test_file_sha256, result: 'created' });
        continue;
      }
      const [stored] = await tx<Array<{ test_file_sha256: string; entry: Record<string, unknown> }>>`
        SELECT test_file_sha256, entry FROM card_scenario_evidence
         WHERE card_id = ${args.cardId}::text AND scenario_id = ${e.scenario_id}::text
      `;
      if (stored && stored.test_file_sha256 === e.test_file_sha256) {
        out.push({
          scenario_id: e.scenario_id,
          test_file_sha256: e.test_file_sha256,
          result: 'unchanged',
          stored_entry: stored.entry,
        });
      } else {
        conflicts.push({
          scenario_id: e.scenario_id,
          stored_sha256: stored?.test_file_sha256 ?? '',
          sent_sha256: e.test_file_sha256,
        });
      }
    }
    // Throwing inside begin() rolls back every row this call inserted.
    if (conflicts.length > 0) throw new ScenarioEvidenceConflictError(conflicts);
    if (args.beforeCommit) await args.beforeCommit(out);
    return out;
  });
}

/**
 * Undo `appendScenarioEvidence` for the rows IT created — keyed on
 * (card_id, scenario_id, test_file_sha256), so a pre-existing row (an
 * `unchanged` entry, another scenario) is never touched. One transaction.
 * Returns the rows removed.
 */
export async function deleteAppendedScenarioEvidence(
  cardId: string,
  created: ReadonlyArray<{ scenario_id: string; test_file_sha256: string }>,
): Promise<number> {
  if (created.length === 0) return 0;
  return queryClient.begin(async (tx) => {
    let removed = 0;
    for (const c of created) {
      const rows = await tx`
        DELETE FROM card_scenario_evidence
         WHERE card_id = ${cardId}::text
           AND scenario_id = ${c.scenario_id}::text
           AND test_file_sha256 = ${c.test_file_sha256}::text
        RETURNING card_id
      `;
      removed += rows.length;
    }
    return removed;
  });
}
