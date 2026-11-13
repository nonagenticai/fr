// src/services/card-repository-resolution.ts
//
// WHICH REPOSITORY DOES THIS CARD'S WORK BELONG TO — computed, at read time.
//
// ── WHAT WAS THERE BEFORE THIS FILE (measured on `origin/main` 34acdf7f) ────
//
// Nothing. fr had NO card→repository resolution path at all. The two halves
// that exist are:
//
//   * card → BOARD → project, via `projects.planka_board_id`. That join is
//     written down once, in `lib/board-tenant-access.ts :: resolveBoardTenant`,
//     and it is used for AUTHORIZATION (which tenant owns this board), never to
//     answer "which repo". It is the only card-keyed project lookup in the repo.
//   * project → repository, via `projects.repository_url` / `projects.branch`
//     (`db/schema.ts:76,87`, both NOT NULL), served by `GET /api/projects/:id`
//     keyed on a project id THE CALLER SUPPLIES.
//
// So the question "given a card id, which repo?" was answered entirely OUTSIDE
// this repo: n8n's `activity-card-hydration.json` walks `Relations.parent_card`
// upward reading each ancestor's `Metadata.project_id`, and hands the winner to
// doing-orchestrate's `Build Activity Envelope`, which calls
// `GET /api/projects/:id` for `dispatch_context.repository_url`. fr was a
// project-keyed lookup table at the end of someone else's walk.
//
// ⚠️ THE CURRENT FALLBACK PRECEDENCE, THEREFORE, WAS: board→project, and on a
// miss NOTHING — no answer, no named refusal, no record that a question was
// asked. fr#1138 measured the consequence: 917 non-DONE `development_*` cards
// whose own board has no `fr.projects` row at all (Asset Authoring —
// Requirements 763 / Decisions 93 / Principles 61), with `Metadata.project_id`
// empty on 100% of them. 661 of the 917 ARE derivable by walking `parent_card`
// (cap 40; the cap-20 figure of 544 in the issue title is a hop-cap artefact —
// 117 cards resolve at depth 21–27 and the deepest chain in the DB is 27).
//
// ── WHY ANCESTRY GOES LAST, NOT FIRST ───────────────────────────────────────
//
// A card's own `Metadata.project_id` and its own board mapping are ASSERTIONS:
// somebody wrote down, about THIS card, which project it belongs to. Ancestry is
// an INFERENCE — `parent_card` records workflow lineage (who spawned whom), not
// repository ownership, and fr#1138 says so in its own words: "a DERIVED pairing,
// not a fabricated one". Derived is not the same as asserted. An inference that
// can override an assertion is how a card silently acquires the wrong repo, so
// the order is: assertion about the card, assertion about the card's board, then
// inference from the nearest ancestor that asserts anything. Within the walk the
// NEAREST ancestor wins, because the shortest inference chain is the strongest.
//
// Every resolution carries `derived: true|false` so a consumer that is only
// willing to act on an assertion can gate on it without re-deriving the reason.
//
// ── A POINTER THAT NAMES SOMETHING IS HONOURED OR REFUSED, NEVER SKIPPED ────
//
// ⭐ The line that matters most in here. A `Metadata.project_id` naming a project
// that does not exist (fr#1142 measured 17 such cards: `5bcd95d7…`×8,
// `0f43bf88…`×3, `bba47a5e…`×2 + 4 singletons), or naming an ARCHIVED project
// (fr#1142's `328639ef-7b8b-41d4-9e65-d199395ab10a`, archived 2026-09-17, which
// 556 chains resolve to) TERMINATES the resolution with that reason. It does NOT
// fall through and keep climbing.
//
// The alternative — skip the broken pointer, walk on, return whatever the next
// ancestor names — substitutes a DIFFERENT repository for the one the card
// actually names, under a 200, with nothing in the payload saying so. That is
// precisely the fabricated pairing migration 120 forbids. "This card names a
// project that no longer exists" is an answer; a neighbouring repo is not.
//
// An ABSENT board mapping is a different thing and is treated differently: a
// board with no `projects` row asserts nothing, so it falls through to the walk.
// The rule is about pointers that NAME something, not about missing data.
//
// ── UNRESOLVABLE IS A VALUE, NOT AN ABSENCE ─────────────────────────────────
//
// The return type is a discriminated union. The unresolved arm has NO
// `repository_url` key, NO `branch` key and NO `project` key — not empty
// strings, not nulls, not zeros. A consumer cannot read a blank out of it and
// render it as an answer, because there is nothing there to read; it must look
// at `resolved` and at `reason`. That is the whole point of the shape.
//
// ── BOUNDS ──────────────────────────────────────────────────────────────────
//
// TWO independent ones, because either alone is insufficient:
//   1. CYCLE: a `visited` Set of card ids. `parent_card` is a single-valued
//      whole-cell overwrite (services/improvement-cards/relations.ts), so the
//      chain is a path and a repeat is proof of a loop, not of a diamond. A
//      repeat terminates with `ancestry_cycle` naming the card that repeated.
//   2. DEPTH: `MAX_ANCESTRY_HOPS = 40` parent edges. 40 and not 20 because 20 is
//      measurably wrong here — fr#1138's correction comment re-ran the walk at
//      cap 40 and found 661 resolvers against 544 at cap 20, i.e. the cap-20
//      figure silently reclassified 117 resolvable cards as dead ends. 40 is
//      also the cap the n8n hydration walk already uses, and the deepest chain
//      measured in the DB is 27, so 40 clears production by 13 hops.
// The Set alone cannot bound a chain that is long but acyclic; the counter alone
// cannot distinguish "deep" from "looping", and those need different fixes. Both.
//
// ── COST, AND WHY THIS IS NOT FOLDED INTO GET /api/cards/:id ────────────────
//
// One `GET /api/cards/:id` per hop (median depth ~13, max 27), plus one board
// metadata read per DISTINCT board crossed — and that one goes through
// `boardMetadataCache`, whose file header records the 2026-09-09 OOMKill that
// an uncached per-request board read caused. Putting this on the card-detail
// route would put a 13-round-trip walk on a page load. It is a separate,
// opt-in route: `GET /api/cards/:cardId/repository`.
//
// ⛔ This module never writes board schema (nor does any card path since v4
// ruling 12 — see the measured incident in `routes/cards/relations.ts` where a
// read-shaped call rewrote a customer board's custom-field schema). A resolver
// is a READ. The
// board schema is read through the metadata cache and a board that does not
// declare `Metadata.project_id` / `Relations.parent_card` simply yields nulls.

// ── MULTI-REPO: WHAT WAS BLIND HERE, AND WHAT WAS NOT ───────────────────────
//
// ⭐ The blindness in this file was the COLUMN SELECTION, not the `.limit(1)`s.
// MEASURED, because the two look alike and only one is a bug:
//
//   * `dbProjectLookup.byId` — `where(eq(projects.id, …)).limit(1)` on
//     `projects.id`, which is `uuid('id').primaryKey()`. A primary-key equality
//     returns AT MOST ONE ROW by definition; the `.limit(1)` is belt-and-braces
//     over a bound Postgres already enforces. It cannot collapse anything.
//   * `dbProjectLookup.byBoardId` — one PROJECT row for one board. Also not a
//     repo collapse. (`planka_board_id` carries no unique index — grep over
//     `backend/migrations/` finds none, while the same grep finds
//     `project_repositories_primary_unique` in 072, so the instrument works — so
//     two projects CAN share a board and this picks one arbitrarily. That is a
//     pre-existing PROJECT-selection ambiguity, identical in shape to
//     `lib/board-tenant-access.ts :: resolveBoardTenant`, which is the codebase's
//     only other board→project join and `.limit(1)`s the same way. It is not
//     this unit's defect and is deliberately left alone.)
//
// Neither limit ever touched `project_repositories`, because NOTHING under
// `src/services/` did (verified: grep for the table across `src/services/`
// returned only the loader below; the same grep over `src/routes/` returns many
// hits). The repo set was not collapsed to one row — it was never queried. So
// the fix is additive: widen what is SELECTED, and attach the full set.
//
// ⛔ Therefore: do NOT remove those `.limit(1)`s. Removing them buys zero repo
// visibility and turns a bounded lookup into an unbounded scan.
//
// Cost of the widening: ONE extra query per RESOLVED card — issued at the moment
// a project wins, not per hop. A 27-hop walk still makes one repo read, not 27.

import { eq } from 'drizzle-orm';

import { db as defaultDb, projects } from '../db/client';
import { loadProjectRepositories } from './project-repositories';
import type {
  ProjectRepositoryRow,
  ProjectRepositorySet,
} from './project-repositories';
import type { PlankaClient } from './planka';
import { boardMetadataCache } from './planka/board-metadata-cache';
import type { RawBoardDetail } from './planka/board-metadata-cache';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Parent edges the walk may traverse. See the BOUNDS note in the header. */
const MAX_ANCESTRY_HOPS = 40;

/** How many trail entries the response carries. The walk itself is bounded by
 * MAX_ANCESTRY_HOPS; this bounds the RESPONSE so a 40-hop chain cannot make a
 * payload that a log line truncates in the middle of a card id. */
const MAX_TRAIL_ENTRIES = MAX_ANCESTRY_HOPS + 1;

/** Bytes of a malformed cell echoed back as evidence. Planka caps a custom-field
 * cell at 512 chars, so this is a second, tighter bound for a response body. */
const MAX_EVIDENCE_CHARS = 120;

const METADATA_GROUP = 'Metadata' as const;
const PROJECT_ID_FIELD = 'project_id' as const;
const RELATIONS_GROUP = 'Relations' as const;
const PARENT_CARD_FIELD = 'parent_card' as const;

// ---------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------

/** One card, reduced to the three facts the walk reads. */
interface CardNode {
  card_id: string;
  board_id: string;
  /** `Metadata.project_id`, normalised. `null` = the cell asserts nothing. */
  project_id: string | null;
  /** `Relations.parent_card`, normalised. `null` = this card is a terminus. */
  parent_card_id: string | null;
}

/**
 * Reads the card graph. `null` means the card DOES NOT EXIST — distinct from a
 * card that exists and carries no links, which is a `CardNode` with nulls. The
 * walk turns those two into different reasons, so the distinction is load-bearing
 * and an implementation must not collapse them.
 */
interface CardGraphReader {
  readCard(cardId: string): Promise<CardNode | null>;
}

/** The fr project row the resolution reports, narrowed to what a repo answer needs. */
interface ResolvedProjectRow {
  id: string;
  name: string;
  status: string;
  /** NULL = the project has no repository (migration 190) ⇒ `project_has_no_repository`. */
  repository_url: string | null;
  branch: string;
  planka_board_id: string | null;
  repository_provisioned: boolean;
  container_name: string | null;
  /**
   * `projects.coordination_mode` (migration 143) — 'coordinated' or
   * 'independent'. Part of the WIDENED selection: a caller handed N repositories
   * and no mode has to guess whether they move as one unit of work or separately,
   * and guessing wrong is how a coordinated change lands on one repo of three.
   */
  coordination_mode: string;
}

interface ProjectLookup {
  byId(projectId: string): Promise<ResolvedProjectRow | null>;
  byBoardId(boardId: string): Promise<ResolvedProjectRow | null>;
}

/**
 * The project → ALL-repositories lookup, as its own seam.
 *
 * ⭐ SEPARATE FROM `ProjectLookup` ON PURPOSE, for cost. `byId`/`byBoardId` are
 * called at EVERY hop of a walk that is a median 13 and a maximum 27 hops deep;
 * folding the repo query into them would multiply a per-walk cost by the depth,
 * against an upstream whose load shape already took fr's pod down once (see the
 * header's COST section). This is consulted EXACTLY ONCE, at the hop where a
 * project wins.
 */
interface ProjectRepositoryLookup {
  forProject(projectId: string): Promise<ProjectRepositorySet>;
}

/**
 * The `project_repositories ⋈ repositories`-backed lookup.
 *
 * Delegates to the ONE service-layer definition
 * (`services/project-repositories.ts :: loadProjectRepositories`) rather than
 * re-writing the join — that module's stated invariant is that no caller can
 * obtain a single row and believe it has the project's repositories, and a second
 * query here would be the way around it.
 */
function dbProjectRepositoryLookup(db: DbHandle = defaultDb): ProjectRepositoryLookup {
  return {
    forProject: (projectId: string) => loadProjectRepositories(projectId, db),
  };
}

// ---------------------------------------------------------------------------
// The return shape
// ---------------------------------------------------------------------------

type ResolutionVia =
  /** The card's own `Metadata.project_id`. An assertion about this card. */
  | 'card_project_id'
  /** The card's own board, via `projects.planka_board_id`. An assertion too. */
  | 'card_board'
  /** An ancestor's `Metadata.project_id`. An inference. */
  | 'ancestor_project_id'
  /** An ancestor's board. An inference. */
  | 'ancestor_board';

type UnresolvedReason =
  /** The start card id does not exist in Planka. */
  | 'card_not_found'
  /** The chain ran out of parents without anything naming a project. */
  | 'no_project_in_ancestry'
  /** A `parent_card` named a card that does not exist (fr#1142: 34 such ids). */
  | 'ancestry_parent_missing'
  /** The walk revisited a card id. */
  | 'ancestry_cycle'
  /** MAX_ANCESTRY_HOPS edges traversed and still climbing. */
  | 'ancestry_depth_exceeded'
  /** A `Metadata.project_id` named a project with no row in `fr.projects`. */
  | 'project_id_orphan'
  /** The named/mapped project exists but is archived. */
  | 'project_archived'
  /**
   * fr row 14d-2: the next `parent_card` hop sits on a board the CALLER may not
   * read (another tenant, or a platform board for a customer caller). The walk
   * stops at the tenant boundary; nothing about the foreign card (id, board,
   * project) is reported.
   */
  | 'ancestry_tenant_boundary'
  /**
   * The resolved project exists, is live, and has NO repository (migration 190,
   * George 2026-10-13: a repo is optional). A terminal ANSWER — "this card's
   * project has no repo" — never a reason to keep walking to a neighbour's repo.
   */
  | 'project_has_no_repository';

/** One hop of the walk, in the order visited. `hop` 0 is the start card. */
interface TrailEntry {
  hop: number;
  card_id: string;
  board_id: string;
}

interface ResolvedCardRepository {
  card_id: string;
  resolved: true;
  via: ResolutionVia;
  /**
   * TRUE when the answer came from an ancestor, i.e. it is an INFERENCE from
   * workflow lineage rather than something written down about this card. A
   * consumer that will provision a container or push a commit should decide
   * explicitly whether it acts on a derived pairing; fr#1138 measured that of
   * the 661 derivable cards only ~35 are code work and 548 are bookkeeping.
   */
  derived: boolean;
  /** Parent edges traversed to reach the answer. 0 = the card itself. */
  hops: number;
  project: {
    id: string;
    name: string;
    status: string;
    planka_board_id: string | null;
    repository_provisioned: boolean;
    container_name: string | null;
    /** 'coordinated' | 'independent' — how the repos below are worked. */
    coordination_mode: string;
  };
  /**
   * The DENORMALISED PRIMARY repo (`projects.repository_url` / `.branch`, both
   * NOT NULL). ⛔ KEPT: every existing consumer of
   * `GET /api/cards/:cardId/repository` — including doing-orchestrate's
   * `Build Activity Envelope`, which reads `dispatch_context.repository_url` —
   * destructures these two scalars, and they remain correct as the primary. The
   * defect was that they were the ONLY answer, so a card on a 3-repo project got
   * an answer indistinguishable from a card on a 1-repo project.
   */
  repository_url: string;
  branch: string;
  /**
   * EVERY repository attached to the resolved project, primary first.
   *
   * ⛔ `null` IS NOT `[]`. `[]` = the read SUCCEEDED and the project genuinely has
   * no `project_repositories` rows (real, and common for projects predating
   * migration 072 — the denormalised scalars above are then the only record).
   * `null` = the read FAILED or no lookup was supplied, i.e. the repo set is
   * UNKNOWN, and `repositories_unavailable_reason` says which.
   *
   * This module's own doctrine is "UNRESOLVABLE IS A VALUE, NOT AN ABSENCE" (see
   * the header) and this is the same rule one level down. A consumer about to act
   * across repos MUST branch on `null` before it treats the list as the project's
   * repositories; acting on `[] `read out of a failure is how a coordinated change
   * silently lands on one repo of five.
   */
  repositories: ProjectRepositoryRow[] | null;
  /** `repositories.length`, or `null` on the same terms. `0` is a claim a failed read cannot make. */
  repository_count: number | null;
  /** Non-null, and non-empty, EXACTLY when `repositories` is `null`. */
  repositories_unavailable_reason: string | null;
  trail: TrailEntry[];
}

interface UnresolvedCardRepository {
  card_id: string;
  resolved: false;
  reason: UnresolvedReason;
  /** One sentence a human can act on. Never "unknown", never empty. */
  detail: string;
  /** Parent edges traversed before giving up. */
  hops_walked: number;
  trail: TrailEntry[];
  /** The card the walk stopped at, when the reason names one. */
  stopped_at_card_id?: string;
  /** The project id a pointer named, for `project_id_orphan` / `project_archived`. */
  project_id?: string;
  /** The project's name, for `project_archived` (it exists, so it has one). */
  project_name?: string;
}

export type CardRepositoryResolution =
  | ResolvedCardRepository
  | UnresolvedCardRepository;

// ---------------------------------------------------------------------------
// Normalisation of a Planka custom-field cell
// ---------------------------------------------------------------------------

/**
 * A custom-field cell → a usable value, or `null`.
 *
 * `'null'` and `'undefined'` are rejected as LITERAL TEXT, not as a style
 * preference: fr#1138 measured `container_name` holding the six-character string
 * `"null"` on 6 of the 917 cards, which is what a JS template literal produces
 * from a null. Treating that as an id would send a lookup after a project called
 * `null`.
 */
function normalizeCell(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === 'null' || lowered === 'undefined') return null;
  return trimmed;
}

function clip(s: string): string {
  return s.length <= MAX_EVIDENCE_CHARS ? s : `${s.slice(0, MAX_EVIDENCE_CHARS)}…`;
}

// ---------------------------------------------------------------------------
// The walk — pure, over the two seams
// ---------------------------------------------------------------------------

/**
 * Resolve the repository for `cardId`.
 *
 * Precedence, applied at EVERY hop starting with the card itself:
 *   1. that card's `Metadata.project_id`  (assertion, card-scoped)
 *   2. that card's board → `projects.planka_board_id`  (assertion, board-scoped)
 *   3. climb to `Relations.parent_card` and repeat  (inference, nearest first)
 *
 * A pointer at step 1 that names a missing or archived project STOPS the walk
 * (see the header). An absent board row at step 2 does not.
 *
 * Never throws for a data condition — every way this can fail to produce a repo
 * is a value in the union. It propagates only genuine I/O errors from the seams,
 * which are the caller's to translate.
 */
export async function resolveCardRepository(
  cardId: string,
  deps: {
    cards: CardGraphReader;
    projects: ProjectLookup;
    /**
     * fr row 14d-2: the PER-HOP tenant check. Called with each ANCESTOR's board
     * id (hop ≥ 1; the start card is gated by the route before the walk) and
     * must return true only when the caller may read that board. `false` stops
     * the walk with `ancestry_tenant_boundary` BEFORE the hop is added to the
     * trail or any of its pointers are followed.
     *
     * ⚠️ The live route (`routes/cards/repository.ts`) ALWAYS passes it
     * (`isBoardReadableByCaller`). It is optional only for the operator batch
     * sweep (`resolveCardRepositories`), which has no caller tenant.
     */
    hopAllowed?: (boardId: string) => Promise<boolean>;
  },
): Promise<CardRepositoryResolution> {
  const repositoryLookup = dbProjectRepositoryLookup();
  const visited = new Set<string>();
  const trail: TrailEntry[] = [];
  let current = cardId;
  let hops = 0;

  const unresolved = (
    reason: UnresolvedReason,
    detail: string,
    extra: Partial<UnresolvedCardRepository> = {},
  ): UnresolvedCardRepository => ({
    card_id: cardId,
    resolved: false,
    reason,
    detail,
    hops_walked: hops,
    trail: trail.slice(0, MAX_TRAIL_ENTRIES),
    ...extra,
  });

  /**
   * Build the resolved answer — ONE repo-set read, here, because this is the only
   * place a project has actually won.
   *
   * ⛔ THE CATCH BELOW MUST NOT PRODUCE AN EMPTY LIST. A failure yields `null` +
   * a reason, which a consumer cannot mistake for "this project has no other
   * repos"; `[]` would be exactly that mistake. And it must not RETHROW either:
   * the repository question HAS been answered for the primary (`repository_url`
   * is on the project row, already read), so turning a secondary-list hiccup into
   * a total failure would discard a correct answer. Degrade the part that failed,
   * name it, keep the part that did not.
   */
  const resolved = async (
    row: ResolvedProjectRow,
    via: ResolutionVia,
  ): Promise<CardRepositoryResolution> => {
    // A live project with NO repository (migration 190): a terminal answer, not
    // an empty string a consumer could clone. Same shape as `project_archived`.
    if (!row.repository_url) {
      return unresolved(
        'project_has_no_repository',
        `project ${row.id} ("${clip(row.name)}") has no repository; repository-dependent ` +
          'work does not apply to this card until a repository is attached to the project.',
        { project_id: row.id, project_name: row.name },
      );
    }
    const repositoryUrl = row.repository_url;
    let set: ProjectRepositorySet | null = null;
    let unavailableReason: string | null = null;
    try {
      set = await repositoryLookup.forProject(row.id);
    } catch (err) {
      set = null;
      unavailableReason =
        `the project_repositories read for project ${row.id} failed ` +
        `(${clip(err instanceof Error ? err.message : String(err))}); the repository ` +
        'list is UNKNOWN for this project, not empty — repository_url/branch are ' +
        'the denormalised primary only, and any cross-repo action must stop here.';
    }

    return {
      card_id: cardId,
      resolved: true,
      via,
      derived: via === 'ancestor_project_id' || via === 'ancestor_board',
      hops,
      project: {
        id: row.id,
        name: row.name,
        status: row.status,
        planka_board_id: row.planka_board_id,
        repository_provisioned: row.repository_provisioned,
        container_name: row.container_name,
        coordination_mode: row.coordination_mode,
      },
      repository_url: repositoryUrl,
      branch: row.branch,
      repositories: set ? set.repositories : null,
      repository_count: set ? set.count : null,
      repositories_unavailable_reason: unavailableReason,
      trail: trail.slice(0, MAX_TRAIL_ENTRIES),
    };
  };

  for (;;) {
    // BOUND 1 — cycle. Checked BEFORE the read so a self-parent (`A -> A`) is
    // caught on the second visit rather than costing an extra round trip.
    if (visited.has(current)) {
      return unresolved(
        'ancestry_cycle',
        `the parent_card chain returns to card ${current} after ${hops} hop(s); ` +
          'it is a loop, so no ancestor can ever name a project. Break the cycle ' +
          'by correcting one card\'s parent_card, then re-ask.',
        { stopped_at_card_id: current },
      );
    }
    visited.add(current);

    const node = await deps.cards.readCard(current);
    if (!node) {
      if (hops === 0) {
        return unresolved('card_not_found', `card ${current} does not exist.`, {
          stopped_at_card_id: current,
        });
      }
      return unresolved(
        'ancestry_parent_missing',
        `the parent_card chain reaches card ${current} at hop ${hops}, and that ` +
          'card does not exist — the ancestor that carried the project link was ' +
          'deleted. Nothing above this point is readable, so the repository ' +
          'cannot be derived.',
        { stopped_at_card_id: current },
      );
    }

    // fr row 14d-2 — PER-HOP tenant boundary. Checked before the hop enters
    // the trail and before any of its pointers are read, so a foreign ancestor
    // contributes nothing to the answer. Fail closed: a throwing check is a
    // refusal, not a pass.
    if (hops > 0 && deps.hopAllowed) {
      let allowed = false;
      try {
        allowed = await deps.hopAllowed(node.board_id);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        return unresolved(
          'ancestry_tenant_boundary',
          `the parent_card chain leaves the caller's tenant at hop ${hops}; the ` +
            'walk stops at the tenant boundary, so no repository is derived from ' +
            'an ancestor the caller may not read.',
          { stopped_at_card_id: trail[trail.length - 1]?.card_id ?? cardId },
        );
      }
    }

    trail.push({ hop: hops, card_id: node.card_id, board_id: node.board_id });

    // ── 1. the card's own pointer ───────────────────────────────────────────
    if (node.project_id) {
      const row = await deps.projects.byId(node.project_id);
      if (!row) {
        return unresolved(
          'project_id_orphan',
          `card ${node.card_id} names project ${node.project_id}, which has no row ` +
            'in fr.projects. The pointer is honoured or refused, never skipped: ' +
            'returning a neighbouring project found further up the chain would ' +
            'substitute a different repository for the one this card names.',
          { stopped_at_card_id: node.card_id, project_id: node.project_id },
        );
      }
      if (row.status === 'archived') {
        return unresolved(
          'project_archived',
          `card ${node.card_id} resolves to project ${row.id} ("${clip(row.name)}"), ` +
            'which is archived. An archived project is a terminal answer, not a ' +
            'reason to keep walking.',
          {
            stopped_at_card_id: node.card_id,
            project_id: row.id,
            project_name: row.name,
          },
        );
      }
      return await resolved(row, hops === 0 ? 'card_project_id' : 'ancestor_project_id');
    }

    // ── 2. the card's board ─────────────────────────────────────────────────
    const boardRow = await deps.projects.byBoardId(node.board_id);
    if (boardRow) {
      if (boardRow.status === 'archived') {
        return unresolved(
          'project_archived',
          `card ${node.card_id} sits on board ${node.board_id}, which belongs to ` +
            `project ${boardRow.id} ("${clip(boardRow.name)}") — archived. An ` +
            'archived project is a terminal answer, not a reason to keep walking.',
          {
            stopped_at_card_id: node.card_id,
            project_id: boardRow.id,
            project_name: boardRow.name,
          },
        );
      }
      return await resolved(boardRow, hops === 0 ? 'card_board' : 'ancestor_board');
    }

    // ── 3. climb ────────────────────────────────────────────────────────────
    if (!node.parent_card_id) {
      return unresolved(
        'no_project_in_ancestry',
        `card ${node.card_id} is the top of its parent_card chain (${hops} hop(s) ` +
          'walked) and neither it nor any ancestor carries a Metadata.project_id ' +
          'or sits on a board mapped to an fr project. No repository is derivable ' +
          'for this card.',
        { stopped_at_card_id: node.card_id },
      );
    }

    // BOUND 2 — depth. Counted in EDGES, and checked before taking the edge, so
    // `hops` never exceeds MAX_ANCESTRY_HOPS in any reported value.
    if (hops + 1 > MAX_ANCESTRY_HOPS) {
      return unresolved(
        'ancestry_depth_exceeded',
        `the parent_card chain is deeper than the ${MAX_ANCESTRY_HOPS}-hop bound ` +
          `(stopped at card ${node.card_id}). The deepest chain measured in ` +
          'production is 27 hops, so a chain this long is a data fault, not a ' +
          'reason to raise the bound.',
        { stopped_at_card_id: node.card_id },
      );
    }

    current = node.parent_card_id;
    hops += 1;
  }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

type DbHandle = typeof defaultDb;

/** The `fr.projects`-backed lookup. Both halves select the SAME column list so
 * a board-resolved answer and a pointer-resolved answer are the same shape. */
export function dbProjectLookup(db: DbHandle = defaultDb): ProjectLookup {
  const columns = {
    id: projects.id,
    name: projects.name,
    status: projects.status,
    repository_url: projects.repository_url,
    branch: projects.branch,
    planka_board_id: projects.planka_board_id,
    repository_provisioned: projects.repository_provisioned,
    container_name: projects.container_name,
    // ⭐ THE WIDENING. This column list — not the `.limit(1)`s below — was where
    // the multi-repo blindness lived: it fetched the denormalised primary
    // (`repository_url`/`branch`) and nothing that said how many repos there are
    // or how they are worked. `coordination_mode` (migration 143) is NOT NULL with
    // a CHECK of ('coordinated','independent'), so it is always a real value.
    // The repo LIST is not a `projects` column — it comes from
    // `dbProjectRepositoryLookup`, read once at the winning hop.
    coordination_mode: projects.coordination_mode,
  };

  const normalize = (row: {
    id: string;
    name: string;
    status: string;
    repository_url: string | null;
    branch: string;
    planka_board_id: string | null;
    repository_provisioned: boolean | null;
    container_name: string | null;
    coordination_mode: string;
  }): ResolvedProjectRow => ({
    ...row,
    // `repository_provisioned` is `.default(false)` but NULLABLE in the schema,
    // so a row written before the default existed can read NULL. Reported as
    // `false` — "we have no record that it was provisioned" — never as `true`.
    repository_provisioned: row.repository_provisioned === true,
  });

  return {
    async byId(projectId: string) {
      // A malformed uuid must not 500 the read: Postgres raises 22P02 on
      // `uuid = 'not-a-uuid'`, and a bad cell on a card is a data condition the
      // union already has a value for. Shape-check first, then query.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
        return null;
      }
      const [row] = await db.select(columns).from(projects).where(eq(projects.id, projectId)).limit(1);
      return row ? normalize(row) : null;
    },
    async byBoardId(boardId: string) {
      const [row] = await db
        .select(columns)
        .from(projects)
        .where(eq(projects.planka_board_id, boardId))
        .limit(1);
      return row ? normalize(row) : null;
    },
  };
}

/** Planka's `included.customFieldValues`, as the card-detail endpoint returns it. */
interface RawCardCustomFieldValue {
  cardId?: string;
  customFieldGroupId?: string;
  customFieldId?: string;
  content?: string | null;
}

interface RawCardDetail {
  item?: { id?: string; boardId?: string } | null;
  included?: { customFieldValues?: RawCardCustomFieldValue[] };
}

/**
 * The Planka-backed card reader.
 *
 * Per card: ONE `GET /api/cards/:id` (its `included.customFieldValues` carries
 * the cells) plus, for a board not seen before in this process-wide 60s window,
 * one `GET /api/boards/:id` through `boardMetadataCache` to map
 * customFieldId → (group, field) names.
 *
 * ⛔ Read-only — see the header. A board that
 * declares no `Metadata.project_id` / `Relations.parent_card` yields nulls here
 * and is left exactly as it is.
 */
export function plankaCardGraphReader(planka: PlankaClient): CardGraphReader {
  return {
    async readCard(cardId: string): Promise<CardNode | null> {
      let detail: RawCardDetail;
      try {
        detail = (await planka.http.request(
          'GET',
          `/api/cards/${encodeURIComponent(cardId)}`,
          {},
        )) as RawCardDetail;
      } catch {
        // A card Planka will not return is, for this walk, a card that is not
        // there. The two produce the same reason on purpose: `ancestry_parent_
        // missing` says "nothing above this point is readable", which is true of
        // a deleted card AND of one we were refused. It never becomes a repo.
        return null;
      }

      const boardId = detail.item?.boardId;
      if (!boardId) return null;

      const values = (detail.included?.customFieldValues ?? []).filter(
        (v) => v.cardId === cardId,
      );

      const meta = await boardMetadataCache.get({
        boardId,
        fetchBoard: () =>
          planka.http.request('GET', `/api/boards/${encodeURIComponent(boardId)}`, {}) as Promise<RawBoardDetail>,
        // The FRESH card's field ids are the staleness probe — an id this entry
        // has never heard of proves the entry predates that field. Same contract
        // routes/cards/get.ts uses.
        probeFieldIds: values
          .map((v) => v.customFieldId)
          .filter((id): id is string => typeof id === 'string'),
      });

      const groupIdByName = new Map(meta.customFieldGroups.map((g) => [g.name, g.id]));
      const fieldId = (group: string, field: string): string | null => {
        const groupId = groupIdByName.get(group);
        if (!groupId) return null;
        return (
          meta.customFields.find(
            (f) => f.customFieldGroupId === groupId && f.name === field,
          )?.id ?? null
        );
      };

      const cellFor = (group: string, field: string): string | null => {
        const id = fieldId(group, field);
        if (!id) return null;
        return normalizeCell(values.find((v) => v.customFieldId === id)?.content);
      };

      return {
        card_id: cardId,
        board_id: boardId,
        project_id: cellFor(METADATA_GROUP, PROJECT_ID_FIELD),
        parent_card_id: cellFor(RELATIONS_GROUP, PARENT_CARD_FIELD),
      };
    },
  };
}
