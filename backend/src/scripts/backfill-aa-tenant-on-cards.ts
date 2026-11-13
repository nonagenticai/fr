#!/usr/bin/env bun
//
// Backfill the `keycloak_tenant_id` Metadata customFieldValue onto AA conveyor
// cards, inheriting each card's value TRANSITIVELY from its parent.
//
// ── Why this exists ────────────────────────────────────────────────────────
// Only Intake cards are minted with `keycloak_tenant_id`. Everything the
// conveyor spawns downstream (chain children, sub-cards, retries) inherits
// nothing, so the field is empty on most of the board. `AA Maintenance - Todo
// Sweep`'s selection predicate requires `keycloak_tenant_id <> ''`, so a card
// without it can NEVER be re-selected. That is terminal, not transient: the
// Router is one-shot, so a card that bounces out once is stranded forever with
// no mechanism that can pick it back up.
//
// Measured 2026-09-01 across the 17 in-scope boards:
//   1271 cards, 429 tenanted (33.75%) — i.e. 66% permanently unrunnable.
//   642 cards would gain a tenant purely by inheriting from an ancestor.
//   0 cards are ambiguous (reachable from two different tenant values).
//   Only 8 of the 17 boards even DECLARE the `keycloak_tenant_id` customField;
//   the other 9 have the Metadata group but no field definition, which is
//   almost certainly WHY their cards have no tenant — there was no field to
//   write. Those boards are reported and skipped: fr never creates board
//   fields (v4 ruling 12 — the RM board template is the master).
//
// ── Safety posture ─────────────────────────────────────────────────────────
//   * READ EVERYTHING, PLAN, GUARD, THEN WRITE. No write of ANY kind —
//     neither a customFieldValue PATCH nor a field-definition provision — is
//     issued until the whole graph is closed and both guards below have passed.
//   * Ambiguity guard: if ANY card is reachable from two DIFFERENT tenant
//     values, the run aborts with the offending card ids and writes nothing.
//     Today's measurement says 0 — that is a measurement, not an invariant,
//     so it is enforced rather than assumed.
//   * Blast-radius guard: aborts if the planned patch count is 0 or exceeds
//     `--max` (default 800; production figure is 642). A graph that has moved
//     under us must not turn into a mass write.
//   * ABSENT STAYS ABSENT. An empty-string value is a *present* field: it
//     satisfies an existence check while still failing the sweep's `<> ''`
//     test, i.e. it makes a card unrunnable AND undiagnosable. So we never
//     PATCH `''` — if an inherited value is falsy the card is skipped and
//     counted.
//   * NOTHING IS PROVISIONED, in either mode: boards lacking the field
//     definition are reported BY NAME with the count of cards that cannot be
//     written there. fr never creates board fields (v4 ruling 12).
//   * Idempotent: a card that already carries a non-empty tenant is never
//     touched, so a second run plans strictly fewer patches (and then trips
//     the "planned 0" guard once there is nothing left to do).
//
// ── The duplicate-row trap ─────────────────────────────────────────────────
// A single card can carry MULTIPLE `custom_field_value` rows for the SAME
// field NAME, under different `customFieldId`s (a legacy group and the current
// one both declare `child_cards`). Measured: 102 in-scope cards carry both a
// `'[]'` row and a populated one. Reading "the" row — or a max() — silently
// drops the real edge, because `']'` sorts above `'"'`. So every row is read
// independently and their edges are UNIONed.
//
// ── Note on resolveImprovementFieldGroup ───────────────────────────────────
// The sibling backfill (backfill-stream-slug-on-cards.ts) resolves its group
// via `resolveImprovementFieldGroup`. That helper is deliberately NOT used
// here: it resolves only the 5 core Metadata names and never
// `keycloak_tenant_id`, and it throws on an unprovisioned board — which the
// dry-run path must survive, since reporting those 9 boards is a primary
// output of this script. Everything it would resolve is already present in
// the single `getBoardCustomFields` read this script makes per board.
//
// Usage:
//   bun src/scripts/backfill-aa-tenant-on-cards.ts --dry-run
//   bun src/scripts/backfill-aa-tenant-on-cards.ts
//   bun src/scripts/backfill-aa-tenant-on-cards.ts --max=900
//
// Auth: agent token (same as backfill-stream-slug-on-cards.ts).

import { PlankaClient } from '../services/planka';
import { IMPROVEMENT_CARD_FIELD_GROUP_NAME } from '../services/planka/custom-fields';

/** Metadata field the AA Maintenance sweep predicate requires non-empty. */
export const TENANT_FIELD_NAME = 'keycloak_tenant_id';
/** Relations fields that define the card graph. Content = JSON array of ids. */
export const PARENT_FIELD_NAME = 'parent_card';
export const CHILD_FIELD_NAME = 'child_cards';

/**
 * In-scope board names. NOTE the em-dash (—) and the middot (·) — these are
 * the literal characters Planka stores; an ASCII hyphen matches nothing.
 */
export const AA_BOARD_NAME_RE = /^(Asset Authoring —|FR · )/;

/** Blast-radius ceiling. Production plan is 642. */
export const DEFAULT_MAX_PATCHES = 800;

/**
 * Breadth-first round bound. Production closure converges at depth 12. BFS
 * assigns each card at most once so a cycle cannot spin forever, but a bound
 * is kept as defence-in-depth against a pathological chain; exceeding it is a
 * hard error rather than a truncated (and therefore wrong) closure.
 */
const MAX_PROPAGATION_ROUNDS = 100;

/** Relation contents that carry no edge. Compared against the TRIMMED content. */
const EMPTY_RELATION_CONTENTS = new Set(['', '[]', 'null', '""']);

export interface BackfillOpts {
  dryRun?: boolean;
  /** Blast-radius ceiling on planned patches. Defaults to DEFAULT_MAX_PATCHES. */
  max?: number;
}

export interface BackfillSummary {
  boards_scanned: number;
  board_names: string[];
  cards_seen: number;
  /** Cards that already carried a non-empty tenant — never touched. */
  already_tenanted: number;
  /**
   * Cards that would gain a tenant by inheritance. Identical in dry-run and
   * apply mode — a missing field DEFINITION does not change what is
   * inheritable, only whether it can be written today.
   */
  planned: number;
  /** PATCHes actually issued (0 when dryRun). */
  patched: number;
  /** Inherited value was empty/whitespace — skipped rather than written as ''. */
  skipped_falsy: number;
  /** In-scope cards with no tenant available at all after transitive closure. */
  still_untenanted: number;
  /** Relation rows whose content could not be read as a card-id list. */
  malformed_relation_rows: number;
  /** inheritance depth → number of planned patches at that depth. */
  depth_histogram: Record<number, number>;

  // ── provisioning, reported separately from the patch counts ──────────────
  /** In-scope boards that already declare the `keycloak_tenant_id` field. */
  boards_field_already_present: number;
  /** In-scope boards lacking the field definition, by name. */
  boards_missing_field_definition: string[];
  /**
   * Planned cards that could NOT be written because their board lacks the
   * field definition (never created here — its RM board template must).
   */
  cards_unrepairable_missing_field_definition: number;
}

/** One in-scope card, as seen on a scanned board. */
interface ScannedCard {
  id: string;
  boardId: string;
  name: string;
}

/** What a scanned board contributes to the write plan. */
interface BoardTarget {
  boardId: string;
  boardName: string;
  /** Metadata group id, when the board has one. */
  metadataGroupId: string | null;
  /** `keycloak_tenant_id` field id, when the board DECLARES it. */
  tenantFieldId: string | null;
}

interface PlannedPatch {
  cardId: string;
  boardId: string;
  content: string;
  depth: number;
}

function emptySummary(): BackfillSummary {
  return {
    boards_scanned: 0,
    board_names: [],
    cards_seen: 0,
    already_tenanted: 0,
    planned: 0,
    patched: 0,
    skipped_falsy: 0,
    still_untenanted: 0,
    malformed_relation_rows: 0,
    depth_histogram: {},
    boards_field_already_present: 0,
    boards_missing_field_definition: [],
    cards_unrepairable_missing_field_definition: 0,
  };
}

/**
 * Read a `parent_card` / `child_cards` content string as a list of card ids.
 *
 * Returns `[]` for the four "no edge" encodings ('', '[]', 'null', '""'),
 * and `'MALFORMED'` for anything that cannot be read as ids (counted and
 * skipped rather than guessed at — inventing an edge would move a tenant onto
 * a card that does not descend from it).
 *
 * Exported for tests.
 */
export function parseCardIdList(
  raw: string | null | undefined,
): string[] | 'MALFORMED' {
  if (raw === null || raw === undefined) return [];
  const trimmed = raw.trim();
  if (EMPTY_RELATION_CONTENTS.has(trimmed)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A bare, unquoted card id is not valid JSON but is a legacy `parent_card`
    // encoding. Accept it only when it is unambiguously a lone id token.
    if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return [trimmed];
    return 'MALFORMED';
  }

  if (parsed === null) return [];
  if (typeof parsed === 'string') {
    const s = parsed.trim();
    return s === '' ? [] : [s];
  }
  if (typeof parsed === 'number') return [String(parsed)];
  if (Array.isArray(parsed)) {
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'string') {
        const s = entry.trim();
        if (s !== '') out.push(s);
      } else if (typeof entry === 'number') {
        out.push(String(entry));
      }
    }
    return out;
  }
  return 'MALFORMED';
}

/**
 * Run the backfill. Exported so tests can drive the body without invoking the
 * CLI shell; the `if (import.meta.main)` block is a thin wrapper.
 *
 * Phases, in order — the ordering IS the safety property:
 *   1. scan  — enumerate in-scope boards, read each ONCE, collect cards,
 *              existing tenants and every relation row. Zero writes.
 *   2. close — multi-source BFS from every card that already has a tenant.
 *   3. guard — ambiguity, then blast radius. Both abort before ANY write,
 *              included.
 *   4. write — PATCH the plan on boards that declare the field; a board
 *              lacking it is reported and skipped.
 */
export async function runBackfill(
  opts: BackfillOpts = {},
): Promise<BackfillSummary> {
  const dryRun = opts.dryRun ?? false;
  const log = (m: string) => console.log(m);
  const planka = PlankaClient.fromConfig().asAgent();
  const max = opts.max ?? DEFAULT_MAX_PATCHES;
  const summary = emptySummary();

  // ── Phase 1: scan (read-only) ────────────────────────────────────────────
  const projectsView = await planka.projects.listWithIncluded();
  const allBoards = projectsView.included?.boards ?? [];
  const boards = allBoards.filter((b) => AA_BOARD_NAME_RE.test(b.name ?? ''));

  log(
    `[plan] ${boards.length}/${allBoards.length} board(s) in scope ` +
      `(name matches ${AA_BOARD_NAME_RE}) dryRun=${dryRun} max=${max}`,
  );
  for (const b of boards) log(`[board] id=${b.id} name="${b.name}"`);

  summary.boards_scanned = boards.length;
  summary.board_names = boards.map((b) => b.name ?? '');

  /** cardId → where we saw it. Only these cards are ever patched. */
  const cards = new Map<string, ScannedCard>();
  /** boardId → group/field ids, plus whether the tenant field exists at all. */
  const targets = new Map<string, BoardTarget>();
  /** cardId → every DISTINCT non-empty tenant value written on that card. */
  const ownTenants = new Map<string, Set<string>>();
  /** parentCardId → child card ids (union of both relation directions). */
  const children = new Map<string, Set<string>>();

  const addEdge = (parentId: string, childId: string): void => {
    if (parentId === childId) return;
    const set = children.get(parentId);
    if (set) set.add(childId);
    else children.set(parentId, new Set([childId]));
  };

  for (const board of boards) {
    // ONE read per board: groups, fields, cards and every customFieldValue.
    const view = await planka.customFields.getBoardCustomFields(board.id);

    // customFieldId → field NAME, across every group on the board. Mapping by
    // NAME (not by a single resolved id) is what makes the duplicate-row trap
    // survivable: two customFieldIds can both be called `child_cards`.
    const nameByFieldId = new Map<string, string>();
    for (const f of view.customFields) {
      if (f.name) nameByFieldId.set(f.id, f.name);
    }

    // Where a write WOULD land: `keycloak_tenant_id` inside the canonical
    // Metadata group. Either part can be absent on a legacy board.
    const metaGroup =
      view.customFieldGroups.find(
        (g) =>
          g.name === IMPROVEMENT_CARD_FIELD_GROUP_NAME &&
          g.boardId === board.id,
      ) ?? null;
    const tenantField = metaGroup
      ? (view.customFields.find(
          (f) =>
            f.name === TENANT_FIELD_NAME &&
            f.customFieldGroupId === metaGroup.id,
        ) ?? null)
      : null;

    targets.set(board.id, {
      boardId: board.id,
      boardName: board.name ?? '',
      metadataGroupId: metaGroup?.id ?? null,
      tenantFieldId: tenantField?.id ?? null,
    });

    if (tenantField) {
      summary.boards_field_already_present += 1;
    } else {
      summary.boards_missing_field_definition.push(board.name ?? board.id);
      log(
        `[board] id=${board.id} name="${board.name}" has NO ` +
          `"${TENANT_FIELD_NAME}" customField definition` +
          (metaGroup ? '' : ` (and no "${IMPROVEMENT_CARD_FIELD_GROUP_NAME}" group)`),
      );
    }

    for (const c of view.cards) {
      if (!cards.has(c.id)) {
        cards.set(c.id, { id: c.id, boardId: board.id, name: c.name ?? '' });
      }
    }

    // ⛔ Every row is read INDEPENDENTLY. Do not group-by-field and pick one.
    for (const row of view.customFieldValues) {
      const fieldName = nameByFieldId.get(row.customFieldId);
      if (!fieldName) continue;

      if (fieldName === TENANT_FIELD_NAME) {
        const content = (row.content ?? '').trim();
        if (content === '') continue; // empty row: present but useless
        const set = ownTenants.get(row.cardId);
        if (set) set.add(content);
        else ownTenants.set(row.cardId, new Set([content]));
        continue;
      }

      if (fieldName !== PARENT_FIELD_NAME && fieldName !== CHILD_FIELD_NAME) {
        continue;
      }

      const ids = parseCardIdList(row.content);
      if (ids === 'MALFORMED') {
        summary.malformed_relation_rows += 1;
        log(
          `[warn] card=${row.cardId} field=${fieldName} ` +
            `unreadable content (len=${(row.content ?? '').length}) — skipped`,
        );
        continue;
      }
      for (const other of ids) {
        if (fieldName === CHILD_FIELD_NAME) addEdge(row.cardId, other);
        else addEdge(other, row.cardId);
      }
    }
  }

  summary.cards_seen = cards.size;

  // ── Phase 2: transitive closure ──────────────────────────────────────────
  interface Assignment {
    tenant: string;
    depth: number;
  }
  const assigned = new Map<string, Assignment>();
  /** cardId → the conflicting tenant values that reach it. MUST stay empty. */
  const conflicts = new Map<string, Set<string>>();

  for (const [cardId, tenants] of ownTenants) {
    const distinct = [...tenants];
    if (distinct.length > 1) {
      // The card's OWN rows disagree — same class of defect as an ambiguous
      // inheritance, and equally unsafe to resolve by guessing.
      conflicts.set(cardId, new Set(distinct));
    }
    assigned.set(cardId, { tenant: distinct[0] as string, depth: 0 });
  }

  let frontier = [...ownTenants.keys()];
  let rounds = 0;
  while (frontier.length > 0) {
    rounds += 1;
    if (rounds > MAX_PROPAGATION_ROUNDS) {
      throw new Error(
        `[abort] tenant propagation did not converge within ` +
          `${MAX_PROPAGATION_ROUNDS} rounds (${frontier.length} card(s) still ` +
          `in the frontier) — the card graph almost certainly contains a ` +
          `cycle. No writes performed.`,
      );
    }
    const next: string[] = [];
    for (const parentId of frontier) {
      const parent = assigned.get(parentId);
      if (!parent) continue;
      for (const childId of children.get(parentId) ?? []) {
        // A card's own value always wins over anything inherited.
        if (ownTenants.has(childId)) continue;
        const existing = assigned.get(childId);
        if (!existing) {
          assigned.set(childId, {
            tenant: parent.tenant,
            depth: parent.depth + 1,
          });
          next.push(childId);
          continue;
        }
        if (existing.tenant !== parent.tenant) {
          const set =
            conflicts.get(childId) ?? new Set<string>([existing.tenant]);
          set.add(parent.tenant);
          conflicts.set(childId, set);
        }
      }
    }
    frontier = next;
  }
  log(`[closure] converged after ${rounds} round(s)`);

  // ── Phase 3a: ambiguity guard ────────────────────────────────────────────
  if (conflicts.size > 0) {
    const detail = [...conflicts.entries()]
      .map(([id, ts]) => `${id} <- {${[...ts].sort().join(' | ')}}`)
      .join('; ');
    throw new Error(
      `[abort] ambiguous tenant inheritance: ${conflicts.size} card(s) are ` +
        `reachable from more than one tenant value. NOTHING was written. ` +
        `Offending cards: ${detail}`,
    );
  }

  // ── Phase 3b: build the plan ─────────────────────────────────────────────
  const plan: PlannedPatch[] = [];
  for (const card of cards.values()) {
    if (ownTenants.has(card.id)) {
      summary.already_tenanted += 1;
      continue;
    }
    const inherited = assigned.get(card.id);
    if (!inherited) {
      summary.still_untenanted += 1;
      continue;
    }
    // ⛔ Never write ''. An empty value is a PRESENT field: it passes an
    // existence check and still fails the sweep's `<> ''` predicate, which is
    // strictly worse than the absence we started with.
    if (inherited.tenant.trim() === '') {
      summary.skipped_falsy += 1;
      summary.still_untenanted += 1;
      log(
        `[card] id=${card.id} inherited value is empty — skipped (never PATCH '')`,
      );
      continue;
    }
    plan.push({
      cardId: card.id,
      boardId: card.boardId,
      content: inherited.tenant,
      depth: inherited.depth,
    });
    summary.depth_histogram[inherited.depth] =
      (summary.depth_histogram[inherited.depth] ?? 0) + 1;
  }
  summary.planned = plan.length;

  // ── Phase 3c: blast-radius guard ─────────────────────────────────────────
  if (plan.length === 0) {
    throw new Error(
      `[abort] planned 0 patches across ${summary.cards_seen} card(s) on ` +
        `${summary.boards_scanned} board(s). Either the backfill has already ` +
        `run, or the board scope / relation fields have moved. Refusing to ` +
        `report a no-op as success.`,
    );
  }
  if (plan.length > max) {
    throw new Error(
      `[abort] planned ${plan.length} patches, which exceeds --max ${max}. ` +
        `NOTHING was written. The card graph has moved since this was sized ` +
        `(measured plan: 642). Re-measure with --dry-run before raising --max.`,
    );
  }

  // ── Phase 4: write ───────────────────────────────────────────────────────
  // Both guards are behind us, so this is the first point at which the script
  // is allowed to write to Planka at all.
  const byBoard = new Map<string, PlannedPatch[]>();
  for (const p of plan) {
    const arr = byBoard.get(p.boardId);
    if (arr) arr.push(p);
    else byBoard.set(p.boardId, [p]);
  }

  for (const [boardId, boardPlan] of byBoard) {
    const target = targets.get(boardId);
    if (!target) continue; // unreachable: every planned card came off a board

    const groupId = target.metadataGroupId;
    const fieldId = target.tenantFieldId;

    if (!groupId || !fieldId) {
      // fr never creates board fields (v4 ruling 12): report, skip the board.
      summary.cards_unrepairable_missing_field_definition += boardPlan.length;
      log(
        `[board] id=${boardId} name="${target.boardName}" lacks the ` +
          `"${TENANT_FIELD_NAME}" definition — ${boardPlan.length} card(s) ` +
          `cannot be written (fr never creates board fields; its RM board ` +
          `template must define it)`,
      );
      continue;
    }

    for (const p of boardPlan) {
      log(
        `[card] id=${p.cardId} board=${p.boardId} depth=${p.depth} ` +
          `PATCH ${TENANT_FIELD_NAME}="${p.content}"`,
      );
      if (dryRun) continue;
      // Belt-and-braces: the plan already excludes falsy values, but this is
      // the last line before the wire, so re-assert it here too.
      if (p.content.trim() === '') continue;
      await planka.customFields.setCardCustomFieldValue({
        cardId: p.cardId,
        customFieldGroupId: groupId,
        customFieldId: fieldId,
        content: p.content,
      });
      summary.patched += 1;
    }
  }

  log(
    `[done] dryRun=${dryRun} ` +
      `boards=${summary.boards_scanned} ` +
      `cards=${summary.cards_seen} ` +
      `alreadyTenanted=${summary.already_tenanted} ` +
      `planned=${summary.planned} ` +
      `patched=${summary.patched} ` +
      `skippedFalsy=${summary.skipped_falsy} ` +
      `stillUntenanted=${summary.still_untenanted} ` +
      `malformedRelationRows=${summary.malformed_relation_rows} ` +
      `boardsFieldAlreadyPresent=${summary.boards_field_already_present} ` +
      `boardsMissingFieldDefinition=${JSON.stringify(summary.boards_missing_field_definition)} ` +
      `cardsUnrepairableMissingFieldDefinition=${summary.cards_unrepairable_missing_field_definition} ` +
      `depthHistogram=${JSON.stringify(summary.depth_histogram)}`,
  );

  return summary;
}

/** Parse `--max=N` / `--max N` out of argv. Exported for tests. */
export function parseMaxArg(argv: readonly string[]): number | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a.startsWith('--max=')) {
      const n = Number(a.slice('--max='.length));
      if (!Number.isFinite(n)) throw new Error(`--max: not a number: ${a}`);
      return n;
    }
    if (a === '--max') {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n)) {
        throw new Error(`--max: not a number: ${argv[i + 1]}`);
      }
      return n;
    }
  }
  return undefined;
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run');
  const max = parseMaxArg(process.argv.slice(2));
  runBackfill({ dryRun, max })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(
        '[error]',
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      process.exit(1);
    });
}
