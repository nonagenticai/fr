<!--
  DeliveredBadge — a delivered project (backend migration 173, `status =
  'delivered'`: RM closed it, or an older bug hunt whose PR exists — only that
  evidence carries a PR). Renders NOTHING for any other status.

  `linkPr = false` renders the PR number as text: the projects list row is one
  big <a>, and an <a> inside an <a> is invalid HTML.
-->
<script lang="ts">
  import type { ProjectDeliveryEvidence } from '$lib/types/api';

  interface Props {
    status: string | null | undefined;
    deliveredAt?: string | Date | null;
    evidence?: ProjectDeliveryEvidence | null;
    linkPr?: boolean;
  }
  let { status, deliveredAt = null, evidence = null, linkPr = true }: Props = $props();

  const pr = $derived(evidence && 'pr' in evidence ? evidence.pr : null);
  // Only http(s) becomes an href — evidence is row data, not trusted markup.
  const prHref = $derived(pr && /^https?:\/\//i.test(pr.url) ? pr.url : null);
  const deliveredOn = $derived.by(() => {
    if (!deliveredAt) return null;
    const d = new Date(deliveredAt);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  });
</script>

{#if status === 'delivered'}
  <span class="inline-flex flex-wrap items-center gap-2 text-xs" data-testid="project-delivered">
    <span
      class="rounded-full bg-[var(--color-success-bg)] px-2 py-0.5 font-semibold text-[var(--color-success-text)]"
      data-testid="project-delivered-badge">Delivered</span
    >
    {#if pr}
      {#if linkPr && prHref}
        <a
          href={prHref}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[var(--color-accent)] hover:underline"
          data-testid="project-delivered-pr">PR #{pr.number}</a
        >
      {:else}
        <span class="text-[var(--color-text-muted)]" data-testid="project-delivered-pr-text">PR #{pr.number}</span>
      {/if}
    {/if}
    {#if deliveredOn}
      <time class="text-[var(--color-text-muted)]" datetime={deliveredOn} data-testid="project-delivered-at"
        >{deliveredOn}</time
      >
    {/if}
  </span>
{/if}
