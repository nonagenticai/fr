/**
 * IdentityResolver — resolves an inbound channel sender to a Keycloak user id.
 *
 * `NullIdentityResolver` is the safe default when no real lookup is wired:
 * the dispatcher will reply "I couldn't identify you" rather than acting on
 * behalf of an unknown sender.
 *
 * ⚠️ `null` from a resolver means "the directory answered and nobody matched".
 * It does NOT mean "the lookup failed" — the Keycloak finders THROW for that,
 * and `dispatchInbound` REFUSES a thrown failure with a retriable HTTP 503
 * (`{error:'identity_unavailable', retryable:true}` + `Retry-After`), so the
 * sender re-delivers. ⚠️ It used to render one as a 200 ack with a reply;
 * fr#1292 removed both, because a 2xx tells a machine sender the delivery
 * SUCCEEDED and suppresses the only recovery path there was, and the reply
 * leg can itself fail in the same outage. Do not add a `.catch(() => null)`
 * to the calls
 * below: it would put an outage back into the "you are a stranger, go link
 * your address" branch, which is the defect those throws exist to remove.
 *
 * `KeycloakIdentityResolver` uses `keycloak.findUserByAadObjectId` for Teams,
 * `keycloak.findUserByEmail` for Email, and the `user_channel_prefs` reverse
 * lookup (`findUserIdsByChannelAddress`) for Telegram — whose sender is a
 * numeric id a user registers on their profile, not a Keycloak attribute.
 * Activated via env flag `CHANNEL_IDENTITY_RESOLVER=keycloak` so CI / local dev
 * keep the null default and only production opts in.
 */
import type { InboundMessage } from '../channels';
import type { IdentityResolution, IdentityResolver } from './types';
import { keycloak } from '../services/keycloak';
import { findUserIdsByChannelAddress } from '../domain/engagement/channel-prefs';
import { findAgentMemberByAddress, isAgentMemberId } from '../domain/engagement/agent-members';

export class NullIdentityResolver implements IdentityResolver {
  async resolveIdentity(_msg: InboundMessage): Promise<IdentityResolution | null> {
    return null;
  }
}

export class KeycloakIdentityResolver implements IdentityResolver {
  async resolveIdentity(msg: InboundMessage): Promise<IdentityResolution | null> {
    let userId: string | null = null;
    let linked: string[] | undefined;
    if (msg.channel === 'teams') userId = await keycloak.findUserByAadObjectId(msg.address);
    else if (msg.channel === 'email') userId = await keycloak.findUserByEmail(msg.address);
    else if (msg.channel === 'telegram' || msg.channel === 'mcp') {
      // `mcp` addresses are client-scoped ids (`care-bus:<tenant>:<staff id>`) a user
      // links on Communication settings exactly like a Telegram id, so the same
      // reverse lookup and the same fail-closed rules apply.
      //
      // Telegram id → fr user via the registered channel address (the same
      // lookup the approval path's findApproverByTelegramId uses). An
      // unregistered id yields null → "unknown sender" reply.
      //
      // ⛔ A link row is fr data, not a directory answer: it can outlive the
      // Keycloak account it names (live 2026-10-23: the first of 12 rows named a
      // sub deleted 2026-08-27 → role read 404 → swallowed to [] → no tenant →
      // "I didn't recognize that as an action"). So a candidate the user realm
      // answers 404 for is DROPPED, never acted as.
      //
      // ⛔ FAIL CLOSED ON AMBIGUITY (George 2026-10-23): exactly ONE live account
      // → that account. MORE than one live → unknown sender (null): never pick
      // between them, or a person's message could run as e.g. a machine
      // operator account linked to the same address. A non-404 Keycloak failure
      // keeps the candidate (with [] roles), so an outage can only make the
      // answer MORE ambiguous, never resolve it to the wrong account.
      const ids = await findUserIdsByChannelAddress(msg.channel, msg.address);
      // fr #1683: an `agent:` address on mcp is an agent product's own member (no
      // Keycloak user). It speaks only as the agent_members row that owns the address,
      // and only through that row's own link; every other id on it is a person and is
      // checked against Keycloak as usual, so a squatted link makes it ambiguous.
      const agent = msg.channel === 'mcp' ? await findAgentMemberByAddress(msg.address) : null;
      const live: Array<{ id: string; roles: string[] }> = [];
      for (const id of [...new Set(ids)]) {
        if (isAgentMemberId(id)) {
          if (agent?.user_id === id) live.push({ id, roles: [] });
          continue;
        }
        const roles = await keycloak.getUserRealmRolesIfUserExists(id);
        if (roles !== null) live.push({ id, roles });
      }
      if (live.length > 1) {
        console.warn(
          JSON.stringify({
            telemetry: 'channel_identity_ambiguous',
            channel: msg.channel,
            correlation_id: msg.correlationId,
            linked_accounts: ids.length,
            live_accounts: live.length,
            message: `${msg.channel} address is linked to ${live.length} live fr accounts (${ids.length} linked in total); treating the sender as unknown — link exactly one account`,
          }),
        );
        return null;
      }
      const only = live[0];
      // Dead links are not carried as linkedAccountIds: a decide narrows that set
      // by tenant membership and must never attribute to a deleted account.
      if (!only) return null;
      return agent?.user_id === only.id
        ? { userId: only.id, tenantRoles: [], agentMember: { tenantId: agent.tenant_id, product: agent.product } }
        : { userId: only.id, tenantRoles: only.roles };
    }
    if (userId === null) return null;
    const tenantRoles = await keycloak.getUserRealmRoles(userId);
    return linked ? { userId, tenantRoles, linkedAccountIds: linked } : { userId, tenantRoles };
  }
}

export function selectDefaultIdentityResolver(): IdentityResolver {
  return process.env.CHANNEL_IDENTITY_RESOLVER === 'keycloak'
    ? new KeycloakIdentityResolver()
    : new NullIdentityResolver();
}

export const defaultIdentityResolver: IdentityResolver = selectDefaultIdentityResolver();
