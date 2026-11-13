<script lang="ts">
  import { ChatBubble, ToolCallCard } from '$lib/components/ui';
  import { threads, type ChatItem } from '$lib/stores/threads.svelte';
  import TocToolResult from '$lib/components/toc/TocToolResult.svelte';
  import ExecutionToolResult from '$lib/components/agent/ExecutionToolResult.svelte';
  import ProjectCreateCard from '$lib/components/agent/ProjectCreateCard.svelte';
  import ApprovalCard from '$lib/components/agent/ApprovalCard.svelte';
  import CapabilityInvokeCard from '$lib/components/agent/CapabilityInvokeCard.svelte';
  import FileUploadCard from '$lib/components/agent/FileUploadCard.svelte';
  import ArtifactReviewCard from '$lib/components/agent/ArtifactReviewCard.svelte';
  import TypedConfirmCard from '$lib/components/agent/TypedConfirmCard.svelte';
  import ModelReviewCard from '$lib/components/agent/ModelReviewCard.svelte';
  import ModelImportCard from '$lib/components/agent/ModelImportCard.svelte';
  import ArtifactDownloadCard from '$lib/components/agent/ArtifactDownloadCard.svelte';
  import { diagramPngCardFor, fileCardFor } from '$lib/components/agent/proposal-cards';
  import DiagramDownloadCard from '$lib/components/agent/DiagramDownloadCard.svelte';
  import { redactedSummary, scrubString } from '$lib/api/agent-redact';
  import ProjectRequestCard from '$lib/components/agent/ProjectRequestCard.svelte';
  import { isAgentProposal, type AgentProposal } from '$lib/agui/types';
  import { agentEmptyStateCopy } from '$lib/agent/empty-state';

  // fr-agui §13 P1c (OQ-17 = c): an unbound thread is the doorway agent, a bound
  // one the project agent — the empty state promises only that catalog.
  const emptyCopy = $derived(
    agentEmptyStateCopy(Boolean(threads.activeThreadProjectId ?? threads.pendingProjectId))
  );

  /** fr-agui SPEC §5.2 (W): a write the agent proposed — rendered as its confirm card. */
  function proposalOf(status: string | undefined, output: unknown): AgentProposal | null {
    return status === 'proposal' && isAgentProposal(output) ? output : null;
  }

  /** A legacy parked write: the approval id to review inline (SPEC §5.2 legacy). */
  function parkedApprovalId(status: string | undefined, output: unknown): string | null {
    if (status !== 'pending' || !output || typeof output !== 'object') return null;
    const id = (output as { approvalId?: unknown }).approvalId;
    return typeof id === 'string' ? id : null;
  }

  /** fr-agui P3: the execution-observability reads render the read they made. */
  const EXECUTION_READS = new Set([
    'projects.list_executions',
    'projects.get_wip',
    'projects.list_blocked_cards',
    'projects.list_agent_actions',
    'projects.list_cards_by_type',
    'projects.list_conveyor_executions',
  ]);
  function isExecutionRead(action: string | undefined, status: string | undefined): boolean {
    return typeof action === 'string' && EXECUTION_READS.has(action) && status === 'success';
  }
  const boundProject = $derived(threads.boundProjectId);

  /** TOC actions get an inline reasoning visualisation in the tool card. */
  function isTocAction(action: string | undefined): boolean {
    return typeof action === 'string' && action.startsWith('toc.');
  }

  // Map ToolCallCard's `running | success | failed` against our wider local
  // status set (which includes `pending` for actions awaiting approval).
  function cardStatus(s: ChatItem & { kind: 'tool-call' }): 'running' | 'success' | 'failed' {
    if (s.status === 'running' || s.status === 'proposal') return 'running';
    if (s.status === 'failed') return 'failed';
    if (s.status === 'pending') return 'running';
    return 'success';
  }

  // fr-agui §10.1 / P1c-b: nothing the agent surfaces is painted unredacted
  // (lib/api/agent-redact.ts, pinned to the backend's shared vectors).
  function summarize(it: ChatItem & { kind: 'tool-call' }): string {
    if (it.error) return scrubString(it.error);
    if (it.status === 'pending') return 'Awaiting approval — review it below';
    if (it.status === 'proposal') return 'Proposed — review and confirm below';
    return redactedSummary(it.output);
  }
</script>

{#snippet confirmCards(status: string | undefined, output: unknown)}
  {@const proposal = proposalOf(status, output)}
  {@const parkedId = parkedApprovalId(status, output)}
  {#if proposal?.card === 'project-create'}
    <ProjectCreateCard {proposal} />
  {:else if proposal?.card === 'project-request'}
    <ProjectRequestCard {proposal} />
  {:else if proposal?.card === 'capability-invoke'}
    <CapabilityInvokeCard {proposal} />
  {:else if proposal?.card === 'file-upload'}
    <FileUploadCard {proposal} />
  {:else if proposal?.card === 'artifact-review'}
    <ArtifactReviewCard {proposal} />
  {:else if proposal?.card === 'typed-confirm'}
    <TypedConfirmCard {proposal} />
  {:else if proposal?.card === 'model-review'}
    <ModelReviewCard {proposal} />
  {:else if proposal?.card === 'model-import'}
    <ModelImportCard {proposal} />
  {:else if proposal?.card === 'approval-decide' && typeof proposal.input.approvalId === 'string'}
    <ApprovalCard
      approvalId={proposal.input.approvalId}
      prefill={{
        decision: proposal.input.decision === 'reject' ? 'reject' : 'approve',
        ...(typeof proposal.input.comment === 'string' ? { comment: proposal.input.comment } : {}),
        ...(typeof proposal.input.reason === 'string' ? { reason: proposal.input.reason } : {})
      }}
    />
  {:else if parkedId}
    <ApprovalCard approvalId={parkedId} />
  {/if}
{/snippet}

<div class="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" data-agent-surface="messages" data-testid="agent-messages">
  {#if threads.items.length === 0 && !threads.streaming}
    <div class="m-auto max-w-md text-center text-sm text-[var(--color-text-muted)]">
      {emptyCopy}
    </div>
  {/if}

  {#each threads.items as item, i (i)}
    {#if item.kind === 'message'}
      {#if item.message.role === 'user'}
        <div class="flex flex-col items-end">
          <ChatBubble role="user">{item.message.content}</ChatBubble>
        </div>
      {:else if item.message.role === 'assistant'}
        <div class="flex flex-col items-start">
          <ChatBubble role="agent">{scrubString(item.message.content)}</ChatBubble>
        </div>
      {:else}
        <div class="flex flex-col items-start">
          <ToolCallCard
            toolName={item.message.action}
            status={item.message.status === 'failed' ? 'failed' : 'success'}
            summary={item.message.status === 'proposal'
              ? 'Proposed — review and confirm below'
              : redactedSummary(item.message.output)}
          >
            {@render confirmCards(item.message.status, item.message.output)}
            {@const fileCard = fileCardFor(item.message.action, item.message.status, item.message.output, boundProject)}
            {#if fileCard}
              <ArtifactDownloadCard file={fileCard} />
            {/if}
            {@const diagramCard = diagramPngCardFor(item.message.action, item.message.status, item.message.output)}
            {#if diagramCard}
              <DiagramDownloadCard card={diagramCard} />
            {/if}
            {#if isExecutionRead(item.message.action, item.message.status)}
              <ExecutionToolResult action={item.message.action} output={item.message.output} projectId={boundProject} />
            {/if}
            {#if isTocAction(item.message.action) && item.message.status !== 'proposal' && item.message.status !== 'pending'}
              <TocToolResult
                action={item.message.action}
                output={item.message.output}
              />
            {/if}
          </ToolCallCard>
        </div>
      {/if}
    {:else if item.kind === 'intent'}
      <div class="flex flex-col items-start">
        {#if item.ok}
          <a
            href={item.route}
            data-testid="agent-intent-chip"
            class="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >{item.label}</a
          >
        {:else}
          <span
            data-testid="agent-intent-refused"
            class="rounded-full border border-[var(--color-danger)] px-2.5 py-0.5 text-xs text-[var(--color-danger)]"
            >{item.label}: {item.reason}</span
          >
        {/if}
      </div>
    {:else}
      <div class="flex flex-col items-start">
        <ToolCallCard
          toolName={item.action}
          status={cardStatus(item)}
          summary={summarize(item)}
        >
          {@render confirmCards(item.status, item.output)}
          {@const fileCard = fileCardFor(item.action, item.status, item.output, boundProject)}
          {#if fileCard}
            <ArtifactDownloadCard file={fileCard} />
          {/if}
          {@const diagramCard = diagramPngCardFor(item.action, item.status, item.output)}
          {#if diagramCard}
            <DiagramDownloadCard card={diagramCard} />
          {/if}
          {#if isExecutionRead(item.action, item.status)}
            <ExecutionToolResult action={item.action} output={item.output} projectId={boundProject} />
          {/if}
          {#if isTocAction(item.action) && item.status !== 'pending' && item.status !== 'proposal'}
            <TocToolResult action={item.action} output={item.output} />
          {/if}
        </ToolCallCard>
      </div>
    {/if}
  {/each}

  {#if threads.lastError}
    <div class="mx-auto max-w-md rounded border border-[var(--color-danger)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-danger)]">
      {threads.lastError}
    </div>
  {/if}
</div>
