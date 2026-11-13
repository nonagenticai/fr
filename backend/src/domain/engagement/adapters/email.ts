// src/domain/engagement/adapters/email.ts
// E-10: Email channel adapter. Two transports, tried in this order:
//
//   1. SMTP  — FR_SMTP_HOST (+ PORT/USER/PASSWORD/FROM). This is how the REST
//      of the fleet sends mail: alertmanager, control-service, provisioning,
//      book-fulfillment, n8n and keycloak all talk STARTTLS to smtp.gmail.com
//      as no-reply@example.com with a shared App Password.
//   2. HTTP  — FR_EMAIL_API_URL + FR_EMAIL_API_KEY, posting {to, subject, body}.
//
// The HTTP path came first but was speculative: nothing in the fleet ever
// implemented that contract (a repo-wide search for a handler destructuring
// {to, subject, body} matches only this file), so email silently never sent.
// SMTP is therefore the real path; HTTP is kept as a fallback so an internal
// mail gateway can still be dropped in later without touching this adapter.
//
// When NEITHER transport is configured, `send`/`sendMessage` short-circuit to
// {success:false, error:'channel-disabled'} without throwing.
import { approvalNotificationText } from '../approval-menu';
import type { Transporter } from 'nodemailer';
import type {
  NotificationChannel,
  ApprovalWithDetails,
  ChannelMessage,
  SendResult,
} from '../notifications';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  /** true = implicit TLS (465); false = STARTTLS upgrade (587, what Gmail uses). */
  secure: boolean;
}

/** Read SMTP settings from env; null unless a host AND a from-address exist. */
export function smtpConfigFromEnv(): SmtpConfig | null {
  const env = process.env;
  const host = (env.FR_SMTP_HOST ?? '').trim();
  const from = (env.FR_SMTP_FROM ?? env.FR_SMTP_USER ?? '').trim();
  if (!host || !from) return null;
  const port = Number.parseInt(env.FR_SMTP_PORT ?? '587', 10);
  return {
    host,
    port: Number.isFinite(port) ? port : 587,
    user: (env.FR_SMTP_USER ?? '').trim(),
    password: env.FR_SMTP_PASSWORD ?? '',
    from,
    // Only 465 is implicit-TLS. 587 must start plaintext and STARTTLS-upgrade;
    // setting secure:true there makes the handshake hang until timeout.
    secure: (env.FR_SMTP_SECURE ?? '').toLowerCase() === 'true' || port === 465,
  };
}

export class EmailAdapter implements NotificationChannel {
  name = 'email';

  private apiUrl: string;
  private apiKey: string;
  private smtp: SmtpConfig | null;
  private transporter: Pick<Transporter<unknown>, 'sendMail'> | null = null;

  constructor() {
    this.apiUrl = process.env.FR_EMAIL_API_URL ?? '';
    this.apiKey = process.env.FR_EMAIL_API_KEY ?? '';
    this.smtp = smtpConfigFromEnv();
  }

  private get smtpEnabled(): boolean {
    return this.smtp !== null || this.transporter !== null;
  }

  private get httpEnabled(): boolean {
    return Boolean(this.apiUrl) && Boolean(this.apiKey);
  }

  /** True when EITHER transport is configured. SMTP is preferred. */
  isEnabled(): boolean {
    return this.smtpEnabled || this.httpEnabled;
  }

  async send(approval: ApprovalWithDetails, recipientAddress: string): Promise<SendResult> {
    if (!this.isEnabled()) {
      return { success: false, error: 'channel-disabled' };
    }
    const subject = approval.status === 'pending'
      ? `Approval required: ${approval.description.slice(0, 80)}`
      : `Approval ${approval.status}: ${approval.description.slice(0, 80)}`;
    // The SAME notification every channel sends (approval-menu.ts), and the tag in the subject
    // too: a mail client's reply keeps the subject, while quotes are stripped on the way in.
    const body = await approvalNotificationText(approval, 'email');
    return this.post(recipientAddress, `${subject} [ApprovalId:${approval.id}]`, body);
  }

  async sendMessage(address: string, message: ChannelMessage): Promise<SendResult> {
    if (!this.isEnabled()) {
      return { success: false, error: 'channel-disabled' };
    }
    if (message.kind === 'approval-request') {
      const approvalId = message.meta?.approvalId;
      if (typeof approvalId !== 'string' || approvalId.length === 0) {
        return { success: false, error: 'approval-request kind requires meta.approvalId' };
      }
    }
    const subject = subjectForKind(message);
    const body = formatEmailBody(message);
    return this.post(address, subject, body);
  }

  /** Route to whichever transport is configured. SMTP wins when both are. */
  private async post(to: string, subject: string, body: string): Promise<SendResult> {
    if (!to) {
      return { success: false, error: 'missing recipient address' };
    }
    if (this.smtpEnabled) {
      return this.sendViaSmtp(to, subject, body);
    }
    return this.postViaHttp(to, subject, body);
  }

  private async sendViaSmtp(to: string, subject: string, body: string): Promise<SendResult> {
    try {
      const transporter = await this.getTransporter();
      const info = await transporter.sendMail({
        from: this.smtp?.from,
        to,
        subject,
        text: body,
      });
      return { success: true, metadata: { messageId: (info as { messageId?: string })?.messageId, to } };
    } catch (err) {
      // Never throw: fanOutEventToUser treats a channel failure as a per-channel
      // problem, not a reason to abort the whole notification.
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `SMTP: ${msg}` };
    }
  }

  /** Lazily build the pooled transporter so no connection is made at import. */
  private async getTransporter(): Promise<Pick<Transporter<unknown>, 'sendMail'>> {
    if (this.transporter) return this.transporter;
    const cfg = this.smtp;
    if (!cfg) throw new Error('smtp not configured');
    const nodemailer = await import('nodemailer');
    this.transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      // Omit auth entirely for relays that authenticate by network identity
      // (e.g. an in-cluster relay); passing {user:'',pass:''} makes them 5xx.
      ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.password } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    return this.transporter;
  }

  private async postViaHttp(to: string, subject: string, body: string): Promise<SendResult> {
    try {
      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ to, subject, body }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, error: `Email API ${res.status}: ${text.slice(0, 256)}` };
      }
      let parsed: any = null;
      try {
        parsed = await res.json();
      } catch {
        // some email APIs return empty body on success
      }
      const messageId = parsed?.messageId || parsed?.id || undefined;
      return { success: true, metadata: { messageId, to } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}

function subjectForKind(message: ChannelMessage): string {
  switch (message.kind) {
    case 'approval-request':
      return `Approval required (cid:${message.correlationId})`;
    case 'action-result':
      return `Action result (cid:${message.correlationId})`;
    case 'action-error':
      return `Action error (cid:${message.correlationId})`;
    default:
      return `FR notification (cid:${message.correlationId})`;
  }
}

function formatEmailBody(message: ChannelMessage): string {
  const cidTag = message.correlationId ? `\n\n[cid:${message.correlationId}]` : '';
  if (message.kind === 'approval-request') {
    const approvalId = typeof message.meta?.approvalId === 'string'
      ? (message.meta.approvalId as string)
      : '';
    return `${message.text}\n\n[ApprovalId:${approvalId}]${cidTag}`;
  }
  return `${message.text}${cidTag}`;
}

export const emailAdapter = new EmailAdapter();
