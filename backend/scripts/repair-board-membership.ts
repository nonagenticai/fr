// Repair script: grant a Planka user editor membership on a Planka board.
//
// Plan ref: ~/.claude/plans/i-was-testing-fr-lazy-reef.md (Bug 1 / Part B1).
//
// Why this exists: projects created via the (since retired) AG-UI
// `agent.create_project` action (Signal `start <name>` verb) historically never
// granted the invoking user board membership — the board ended up with only
// the agent SA as a member, so the owning user got a 404 (rewrapped as 502) on
// their own kanban. This script repairs those legacy rows.
//
// It goes through the Planka REST API (via the same `plankaClient.asAgent()`
// the app uses) rather than touching Postgres directly, so Planka's own
// invariants (terms acceptance, role enum, unique membership) are honoured.
// Idempotent: a 409 "already a member" is treated as success.
//
// Usage (run inside the fr-backend pod, which already carries PLANKA_*
// env):
//   bun run scripts/repair-board-membership.ts <boardId> <plankaUserId> [role]
//
// role defaults to "editor". Example (signal-mvp-smoke board, user
// operator@example.com):
//   bun run scripts/repair-board-membership.ts 1764170851143386119 1758342519017441232

import { plankaClient } from '../src/services/planka';
import { PlankaConflictError } from '../src/services/planka/errors';

async function main(): Promise<void> {
  const [boardId, plankaUserId, roleArg] = process.argv.slice(2);
  const role = (roleArg as 'editor' | 'viewer') ?? 'editor';

  if (!boardId || !plankaUserId) {
    console.error(
      'Usage: bun run scripts/repair-board-membership.ts <boardId> <plankaUserId> [role]',
    );
    process.exit(1);
  }
  if (role !== 'editor' && role !== 'viewer') {
    console.error(`Invalid role "${role}" — must be "editor" or "viewer"`);
    process.exit(1);
  }

  const agent = plankaClient.asAgent();

  // Pre-check: is the user already a member? Keeps the script's output
  // honest about whether it changed anything.
  const existing = await agent.members.listBoardMembers(boardId);
  const already = existing.find((m) => m.userId === plankaUserId);
  if (already) {
    console.log(
      `[repair-board-membership] noop — user ${plankaUserId} is already a ${already.role} on board ${boardId}`,
    );
    return;
  }

  try {
    const membership = await agent.members.addBoardMember({
      boardId,
      userId: plankaUserId,
      role,
    });
    console.log(
      `[repair-board-membership] OK — granted ${role} (membership ${membership.id}) to user ${plankaUserId} on board ${boardId}`,
    );
  } catch (err) {
    if (err instanceof PlankaConflictError) {
      console.log(
        `[repair-board-membership] noop — Planka reports user ${plankaUserId} already a member of board ${boardId}`,
      );
      return;
    }
    throw err;
  }
}

await main();
