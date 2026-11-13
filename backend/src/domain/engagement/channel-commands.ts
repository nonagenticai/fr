// src/domain/engagement/channel-commands.ts
//
// What a user can do in fr from outside the web app, in ONE place: the chat
// `help` reply (agui/actions/status.ts) and the Communication settings page
// (GET /api/me/channel-commands) both read this, so they cannot drift apart.
//
// The verbs mirror `command-grammar.ts`. When the grammar gains a verb, add it here.

export interface ChannelCommand {
  usage: string;
  description: string;
  /** The capability the command runs. */
  capability: string;
  /** A write that may park for an explicit `approve <id>` before it runs (kanban writes
   * auto-approve for the human who typed them; `start` always parks; `<action>` per its policy). */
  confirms: boolean;
}

export const CHANNEL_COMMANDS: readonly ChannelCommand[] = [
  { usage: 'status', description: 'list your projects', capability: 'status.summary', confirms: false },
  { usage: 'status <slug>', description: 'summary for a specific project (e.g. "status fr-test")', capability: 'status.summary', confirms: false },
  { usage: 'start <type> <title>', description: 'request a new project (fr replies with how to confirm it)', capability: 'projects.create', confirms: true },
  { usage: 'card <project>: <title>', description: 'create a kanban card on a project', capability: 'kanban.create_card', confirms: false },
  { usage: 'comment <card-id>: <text>', description: 'add a comment to a kanban card', capability: 'kanban.add_comment', confirms: false },
  { usage: 'approve <id> [comment]', description: 'approve a pending approval by its id (an agent action: only where this channel verifies you, else in fr)', capability: 'approvals.decide', confirms: false },
  { usage: 'reject <id> [reason]', description: 'reject a pending approval by its id (an agent action: only where this channel verifies you, else in fr)', capability: 'approvals.decide', confirms: false },
  { usage: '<action> {json}', description: 'run any fr action by name (e.g. status.summary {}); a change runs now or replies with an approval id to confirm, per its approval rules (web-only changes are refused)', capability: '*', confirms: true },
  { usage: 'help', description: 'this list', capability: 'help.list_commands', confirms: false },
];

export interface ChannelGuide {
  channel: string;
  label: string;
  /** Messages from this channel are run as commands (not only notifications out). */
  commands: boolean;
  /** How the user finds the address to link on Communication settings. */
  link: string;
}

export const CHANNEL_GUIDES: readonly ChannelGuide[] = [
  { channel: 'telegram', label: 'Telegram', commands: true, link: 'Send /start to the fr bot; it replies with your Telegram id. Add it here as a Telegram address.' },
  { channel: 'email', label: 'Email', commands: true, link: 'Add your email address. Commands are read from mail you send to fr from that address.' },
  { channel: 'teams', label: 'Microsoft Teams', commands: true, link: 'Your Teams account is matched to your fr account by your organisation directory.' },
  { channel: 'mcp', label: 'MCP client (e.g. care-bus)', commands: true, link: 'Your client shows the address to link (for example care-bus:<workspace>:<your id>). Add it here as an MCP address for the workspace it acts in. The client then acts as you in that workspace, with your role there.' },
  { channel: 'websocket', label: 'fr web app', commands: false, link: 'Live alerts while fr is open in your browser. Nothing to link.' },
];

export function helpText(): string {
  const width = Math.max(...CHANNEL_COMMANDS.map((c) => c.usage.length)) + 2;
  return [
    'Available commands:',
    ...CHANNEL_COMMANDS.map((c) => `• ${c.usage.padEnd(width)}— ${c.description}`),
    `• ${'yes / no'.padEnd(width)}— not accepted on their own: use approve / reject <id>, or decide in fr`,
  ].join('\n');
}
