/**
 * fr-agui SPEC §6.0 / §13 P1c (OQ-17 = c): the agent's empty-thread copy.
 *
 * The server decides the catalog from the thread (routes/agent.ts): a thread
 * bound to a project gets the PROJECT agent; an unbound one — every tenant page
 * — gets the DOORWAY (the `request-intake` pack: project types, create a
 * project, the project-request lifecycle). The copy must promise only what that
 * catalog offers: no library search, no workflows, no tenant tools.
 */
export const DOORWAY_EMPTY_STATE =
	'Start a conversation. Here the agent can help you start a project: list the project types, create a project, and draft, submit and track project requests. Open a project to work with its board, cards and approvals.';

export const PROJECT_EMPTY_STATE =
	"Start a conversation. The agent works on this project: its brief, plan, board and cards, approvals, requirements and TOC.";

export function agentEmptyStateCopy(projectBound: boolean): string {
	return projectBound ? PROJECT_EMPTY_STATE : DOORWAY_EMPTY_STATE;
}
