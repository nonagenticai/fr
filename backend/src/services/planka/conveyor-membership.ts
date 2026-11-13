// Grant the n8n conveyor's Planka user `editor` on a newly created board —
// for PLATFORM tenants only (deployment#4397, M1).
//
// Planka 2.1.0 only lets a user write cards/custom fields on boards where it
// holds an `editor` BoardMembership; without it the conveyor gets
// CARD_NOT_FOUND. Customer-tenant boards must NEVER receive the conveyor
// (strict tenant separation), so the tenant check FAILS CLOSED: a missing or
// unknown tenant is treated as "not platform".
//
// Never throws: board creation must not fail because of this grant. Every
// non-success outcome is logged with the board id and the reason so a skipped
// or failed grant is observable.

import { config } from '../../config';
import { isPlatformTenant } from '../../routes/assets/_lib/system-union';
import { PlankaConflictError } from './errors';
import type { BoardMembershipInput } from './members';

export interface ConveyorMembershipAgent {
  members: {
    addBoardMember(input: BoardMembershipInput): Promise<unknown>;
  };
}

type ConveyorMembershipResult =
  | { added: true }
  | { alreadyMember: true }
  | { skipped: 'unset' | 'not_platform' }
  | { error: string };

export async function ensureConveyorMembership(
  agent: ConveyorMembershipAgent,
  params: { boardId: string; tenantId?: string | null },
): Promise<ConveyorMembershipResult> {
  const userId = config.services.planka.conveyorUserId;
  if (!userId) return { skipped: 'unset' };

  const { boardId, tenantId } = params;
  if (!isPlatformTenant(tenantId)) {
    console.info(
      `[planka.conveyor-membership] skipped board=${boardId} tenant=${tenantId ?? 'none'} reason=not_platform`,
    );
    return { skipped: 'not_platform' };
  }

  try {
    await agent.members.addBoardMember({ boardId, userId, role: 'editor' });
    return { added: true };
  } catch (err) {
    if (err instanceof PlankaConflictError) return { alreadyMember: true };
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[planka.conveyor-membership] FAILED board=${boardId} tenant=${tenantId} reason=${reason} — ` +
        `the conveyor cannot write cards on this board until it is granted editor ` +
        `(repair: bun run scripts/repair-board-membership.ts ${boardId} <conveyorUserId>)`,
    );
    return { error: reason };
  }
}
