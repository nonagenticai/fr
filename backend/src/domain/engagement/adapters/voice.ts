// src/domain/engagement/adapters/voice.ts
// E-10: voice channel STUB. Construction never crashes; both `send` and
// `sendMessage` return {success:false, error:'voice-not-implemented'} so the
// adapter is safely registerable without a real telephony provider wired in.
import type {
  NotificationChannel,
  ApprovalWithDetails,
  ChannelMessage,
  SendResult,
} from '../notifications';

const NOT_IMPL: SendResult = { success: false, error: 'voice-not-implemented' };

export class VoiceAdapter implements NotificationChannel {
  name = 'voice';

  // ApprovalWithDetails / ChannelMessage signatures preserved verbatim from the
  // NotificationChannel interface; the adapter accepts them but does no work.
  async send(_approval: ApprovalWithDetails, _recipientAddress: string): Promise<SendResult> {
    return NOT_IMPL;
  }

  async sendMessage(_address: string, _message: ChannelMessage): Promise<SendResult> {
    return NOT_IMPL;
  }
}

export const voiceAdapter = new VoiceAdapter();
