// E-10: Voice inbound channel — STUB.
//
// `parseWebhook` always returns null (no telephony provider wired in yet).
// `postReply` likewise no-ops. Registering this channel is safe and lets
// the route handler return 501 when the user-facing webhook eventually
// gets wired up.
import type { ChannelInbound, InboundMessage } from './index';
import type { ChannelMessage } from '../domain/engagement/notifications';

export const voiceChannel: ChannelInbound = {
  name: 'voice',

  async parseWebhook(_req: Request): Promise<InboundMessage | null> {
    return null;
  },

  async postReply(_threadId: string | undefined, _message: ChannelMessage): Promise<void> {
    // Intentionally empty — voice replies require a telephony integration
    // that is out of scope for the E-10 stub.
  },
};
