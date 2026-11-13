/**
 * Per-asset-type empty-state copy.
 *
 * Keys match the AssetType union in /library/[type]/+page.svelte. New asset
 * types added there must also get an entry here, or the empty page will fall
 * back to a generic message.
 */

export type AssetTypeKey =
  | 'requirement'
  | 'principle'
  | 'decision'
  | 'kag_document'
  | 'workflow'
  | 'trigger'
  | 'artifact'
  | 'channel';

export interface AssetExplainer {
  what: string;
  how: string;
  agentPrompt: string;
  /** If set, the empty-state renders a direct CTA link instead of (or alongside) "Ask the agent". */
  createHref?: string;
  createLabel?: string;
}

export const ASSET_EXPLAINERS: Record<AssetTypeKey, AssetExplainer> = {
  requirement: {
    what: 'Requirements describe what the system must do — testable, scoped to a project or workspace.',
    how: 'Created by the agent during card work, or promoted from another scope.',
    agentPrompt: 'Help me draft a requirement for ',
    createHref: '/requirements/new',
    createLabel: 'Create a requirement',
  },
  principle: {
    what: 'Principles are durable design tenets that govern decisions across cards.',
    how: 'Created by the agent or curated by a workspace admin.',
    agentPrompt: 'Help me write a principle about ',
    createHref: '/principles/new',
    createLabel: 'Create a principle',
  },
  decision: {
    what: 'Decisions record an architectural or operational choice and its tradeoffs.',
    how: 'Captured by the agent at the end of a discussion thread.',
    agentPrompt: 'Help me record a decision about ',
    createHref: '/decisions/new',
    createLabel: 'Create a decision',
  },
  kag_document: {
    what: 'Knowledge documents are sources the agent can retrieve from during reasoning.',
    how: 'Ingested via /kag, scraped from a URL, or uploaded as a file.',
    agentPrompt: 'Help me find documents about ',
  },
  workflow: {
    what: 'Workflows are n8n automations registered to this workspace.',
    how: 'Authored in n8n; tagged for discovery here.',
    agentPrompt: 'Help me design a workflow that ',
  },
  trigger: {
    what: 'Triggers fire workflows on a schedule or event.',
    how: 'Configured at /channels.',
    agentPrompt: 'Help me set up a trigger that ',
  },
  artifact: {
    what: 'Artifacts are durable outputs of card work — files, transcripts, builds.',
    how: 'Produced by card work and pinned to a card.',
    agentPrompt: 'Help me find artifacts for ',
  },
  channel: {
    what: 'Channels are notification destinations — email, Slack, webhook. Add one to start receiving improvement-card alerts, scheduled reports, and andon notifications for this workspace.',
    how: 'Managed at /channels by a workspace admin.',
    agentPrompt: 'Help me set up notifications for ',
    createHref: '/channels/new',
    createLabel: 'Add a channel',
  },
};
