// fr-agui SPEC §7.4 — the Execution hub's "Ask the agent" affordance: each
// panel PRE-FILLS the project agent's rail with the panel's context. It never
// sends: the person reads the question, edits it if they like, and sends it
// themselves (fr is a facilitator — nothing is asked in their name).
//
// The draft rides the threads store's `restoredDraft`, the same seam ChatInput
// already consumes for a retry-exhausted send, so the rail needs no new input
// path. Outside a project there is no project agent: the rail opens on its gate
// ("Open a project to use the agent") and no draft is left behind.
import { agentRail } from '$lib/stores/agentRail.svelte';
import { threads } from '$lib/stores/threads.svelte';
import { scrubString } from '$lib/api/agent-redact';

/** Longest draft a panel may pre-fill (a question, not a data dump). */
export const ASK_DRAFT_MAX = 600;

/** Pre-fill the project agent with `prompt`; true when a project agent will receive it. */
export function askAgentAbout(prompt: string): boolean {
	if (!agentRail.projectId) {
		agentRail.openAgentTab();
		return false;
	}
	threads.restoredDraft = scrubString(prompt).slice(0, ASK_DRAFT_MAX);
	agentRail.openAgentTab();
	return true;
}
