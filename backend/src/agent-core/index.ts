/**
 * agent-core module-global.
 *
 * Exposes a single `agentCore` facade that the channel dispatcher calls
 * for identity + intent resolution. The intent resolver is installed at boot
 * (server.ts); the identity resolver is the default.
 */
import type { InboundMessage } from '../channels';
import type {
  IdentityResolution,
  IdentityResolver,
  IntentResolution,
  IntentResolver,
} from './types';
import { defaultIntentResolver } from './resolver';
import { defaultIdentityResolver } from './identity';

let intentResolver: IntentResolver = defaultIntentResolver;
const identityResolver: IdentityResolver = defaultIdentityResolver;

export const agentCore = {
  resolveIntent(msg: InboundMessage): Promise<IntentResolution> {
    return intentResolver.resolveIntent(msg);
  },
  resolveIdentity(msg: InboundMessage): Promise<IdentityResolution | null> {
    return identityResolver.resolveIdentity(msg);
  },
};

export function setIntentResolver(r: IntentResolver): void {
  intentResolver = r;
}

export type {
  IntentResolution,
  IntentResolver,
  IdentityResolution,
  IdentityResolver,
} from './types';
export { HeuristicIntentResolver } from './resolver';
export {
  NullIdentityResolver,
  KeycloakIdentityResolver,
  selectDefaultIdentityResolver,
} from './identity';
