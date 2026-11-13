/**
 * status.summary + help.list_commands AG-UI actions.
 *
 * The Wave-4 command grammar (`domain/engagement/command-grammar.ts`) maps
 * the inbound free-text verb `status [<slug>]` to the action
 * `status.summary` and the verb `help` to `help.list_commands`. Both
 * actions were declared by the grammar but never registered in the
 * AG-UI registry, so every status / help message from a chat user
 * came back as `UnknownActionError: Unknown action: status.summary`
 * (visible to the user as the dispatcher's action-error reply).
 *
 * This module wires both ends:
 *   - `status.summary` — looks up the project by fuzzy slug (or all the
 *     user's projects when scope='mine'), pulls each kanban board's
 *     list/card breakdown, and returns a compact text summary plus a
 *     structured payload the agent can fall through into the right pane.
 *   - `help.list_commands` — returns the static set of command-grammar
 *     verbs as a chat-friendly text block.
 *
 * Read-only, no upstream mutations, approval=auto, RBAC=public-but-
 * filtered-by-tenant (P1-TEAM-a). Both are safe for a no-confirmation reply.
 */

import { z } from 'zod';
import { clientSafeCaughtErrorText } from '../../integrations/_lib/errors';
import { and, ilike, or } from 'drizzle-orm';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { db, projects } from '../../db/client';
import { tenantMemberProjectScope } from '../../lib/project-access';
// A request's pending/cancelled pre-approval row has no board and is not a
// project to report status on. Archived stays listed, as before.
import { projectIsNotPreApproval } from '../../lib/project-live-status';
import { plankaClient } from '../../services/planka';
import type { BoardDetail } from '../../services/planka/types';
import { helpText } from '../../domain/engagement/channel-commands';

// Words we strip from the slug before fuzzy-matching. Users naturally
// type "status of fr-test-verification" — without this the slug is
// "of fr-test-verification" and matches nothing.
const SLUG_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'on',
  'in',
  'about',
  'project',
]);

function cleanSlug(raw: string): string {
  return raw
    .toLowerCase()
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !SLUG_STOP_WORDS.has(tok))
    .join(' ')
    .trim();
}

// ---------------------------------------------------------------------------
// status.summary
// ---------------------------------------------------------------------------

const statusInputSchema = z.object({
  scope: z.enum(['mine', 'project']),
  /** Free-text fragment — fuzzy-matched against project names. */
  slug: z.string().optional(),
});

const projectSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.string(),
  /** Total cards across the kanban board, when reachable. */
  card_count: z.number().int().nullable(),
  /** Per-list card counts (key = list name, e.g. "TODO" → 3). When the
   * kanban side is unreachable, omitted. */
  by_list: z.record(z.number().int()).nullable(),
  /** Populated when getBoard threw — the agent can still render the
   * other fields and surface this as a soft warning. */
  kanban_error: z.string().nullable(),
});

const statusOutputSchema = z.object({
  scope: z.enum(['mine', 'project']),
  query: z.string().nullable(),
  matched: z.array(projectSummarySchema),
  /** Plain-text reply rendered for chat channels (Telegram, Teams). */
  text: z.string(),
});

type StatusInput = z.infer<typeof statusInputSchema>;
type StatusOutput = z.infer<typeof statusOutputSchema>;
type ProjectSummary = z.infer<typeof projectSummarySchema>;

interface RawProject {
  id: string;
  name: string;
  status: string;
  planka_board_id: string | null;
}

async function findUserProjects(
  userId: string,
  tenantId: string | undefined,
  slug: string | undefined,
): Promise<RawProject[]> {
  // P1-TEAM-a (George 2026-10-15): every project of the caller's tenant, not
  // only the ones they created — any tenant member may read any of them.
  if (!slug) {
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        planka_board_id: projects.planka_board_id,
      })
      .from(projects)
      // tag == the caller's tenant (fail closed; fr row 14b) + the selection hook.
      .where(and(tenantMemberProjectScope(userId, tenantId), projectIsNotPreApproval()))
      .orderBy(projects.created_at)
      .limit(10);
    return rows;
  }
  const cleaned = cleanSlug(slug);
  if (!cleaned) {
    // Slug was all stop-words. Fall back to listing.
    return findUserProjects(userId, tenantId, undefined);
  }
  // Match each whitespace-separated token as a substring of the name.
  // Keep simple: ANY token matches. Multi-token AND would be brittle on
  // hyphenated project names ("fr-test-verification" vs "fr test").
  const tokens = cleaned.split(' ');
  const tokenLikes = tokens.map((t) => ilike(projects.name, `%${t}%`));
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      planka_board_id: projects.planka_board_id,
    })
    .from(projects)
    .where(and(tenantMemberProjectScope(userId, tenantId), projectIsNotPreApproval(), or(...tokenLikes)))
    .limit(5);
  return rows;
}

async function summarizeBoard(boardId: string): Promise<{ count: number; byList: Record<string, number> }> {
  // plankaClient.asAgent() uses the cached agent Planka token (login via
  // PLANKA_AGENT_EMAIL/PASSWORD against /api/access-tokens). Required because
  // agent-initiated webhook calls have no human bearer token in the AsyncLocalStorage
  // RequestContext, so the integrations/kanban path 401s. See services/planka/auth.ts.
  const board: BoardDetail = await plankaClient.asAgent().boards.get(boardId);
  const listById = new Map<string, string>();
  for (const list of board.included.lists ?? []) {
    if (list.id && list.name) listById.set(list.id, list.name);
  }
  const byList: Record<string, number> = {};
  for (const card of board.included.cards ?? []) {
    const listName = (card.listId && listById.get(card.listId)) || 'unknown';
    byList[listName] = (byList[listName] ?? 0) + 1;
  }
  const count = (board.included.cards ?? []).length;
  return { count, byList };
}

async function buildSummary(p: RawProject): Promise<ProjectSummary> {
  if (!p.planka_board_id) {
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      card_count: null,
      by_list: null,
      kanban_error: null,
    };
  }
  try {
    const { count, byList } = await summarizeBoard(p.planka_board_id);
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      card_count: count,
      by_list: byList,
      kanban_error: null,
    };
  } catch (err) {
    // Planka/upstream errors carry internal paths and raw bodies: logged,
    // never returned to the agent-token caller.
    console.warn('[agui.status] kanban summary failed:', err);
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      card_count: null,
      by_list: null,
      kanban_error: clientSafeCaughtErrorText(err, 'kanban summary unavailable'),
    };
  }
}

function renderText(scope: 'mine' | 'project', query: string | null, matched: ProjectSummary[]): string {
  if (matched.length === 0) {
    if (scope === 'project' && query) {
      return `No project matches "${query}".`;
    }
    return 'You have no projects yet.';
  }
  const lines = matched.map((p) => {
    const head = `• ${p.name} [${p.status}]`;
    if (p.kanban_error) {
      return `${head} — kanban summary unavailable (${p.kanban_error.slice(0, 80)})`;
    }
    if (p.card_count === null || p.by_list === null) {
      return `${head} — no kanban board provisioned yet`;
    }
    const breakdown = Object.entries(p.by_list)
      .map(([k, v]) => `${k}:${v}`)
      .join(' · ');
    return `${head} — ${p.card_count} cards (${breakdown || 'empty'})`;
  });
  const header = scope === 'project' && query ? `Status of "${query}":` : 'Your projects:';
  return [header, ...lines].join('\n');
}

const statusAction: AgentCallableAction<StatusInput, StatusOutput> = {
  name: 'status.summary',
  kind: 'read',
  description:
    'Summarize the user\'s projects (scope="mine") or one project matched by slug (scope="project"). Returns kanban list/card counts when the board is provisioned.',
  input: statusInputSchema,
  output: statusOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (i) => `status.summary:${i.scope}:${i.slug ?? ''}`,
  rbac: { type: 'public' },
  handler: async (input, ctx: ActionContext): Promise<StatusOutput> => {
    const rawSlug = input.scope === 'project' ? (input.slug ?? '').trim() : undefined;
    const rawProjects = await findUserProjects(ctx.userId, ctx.tenantId, rawSlug);
    const matched = await Promise.all(rawProjects.map(buildSummary));
    // Display the cleaned slug, not the raw input. "status of fr-test"
    // should render as `Status of "fr-test":` not `Status of "of fr-test":`.
    // findUserProjects already normalises internally; this just mirrors
    // that to the user-facing fields.
    const displayQuery =
      rawSlug && rawSlug.length > 0
        ? cleanSlug(rawSlug) || rawSlug
        : null;
    return {
      scope: input.scope,
      query: displayQuery,
      matched,
      text: renderText(input.scope, displayQuery, matched),
    };
  },
};

// ---------------------------------------------------------------------------
// help.list_commands
// ---------------------------------------------------------------------------

const helpInputSchema = z.object({}).strict();
const helpOutputSchema = z.object({
  text: z.string(),
});

type HelpInput = z.infer<typeof helpInputSchema>;
type HelpOutput = z.infer<typeof helpOutputSchema>;

// One list with the Communication settings page: domain/engagement/channel-commands.ts.
const HELP_TEXT = helpText();

const helpAction: AgentCallableAction<HelpInput, HelpOutput> = {
  name: 'help.list_commands',
  kind: 'read',
  description: 'Return the list of supported chat verbs (status, start, approve, reject, help).',
  input: helpInputSchema,
  output: helpOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: () => 'help.list_commands',
  rbac: { type: 'public' },
  handler: async (_input, _ctx: ActionContext): Promise<HelpOutput> => ({ text: HELP_TEXT }),
};

// ---------------------------------------------------------------------------
// Registration (idempotent — module gets imported by server.ts side effects)
// ---------------------------------------------------------------------------

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Registers this module's actions (idempotent); `registerAllActions` calls it at boot. */
export function registerStatusActions(): void {
  safeRegister(statusAction);
  safeRegister(helpAction);
}

registerStatusActions();

// Export for test direct-invoke.
export { statusAction, helpAction, cleanSlug };
