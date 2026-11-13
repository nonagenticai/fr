<!--
  Shared header for the project-scoped Inspect routes (/projects/[id]/<view>).
  A back-link to the cockpit + a title/subtitle, so every Inspect surface reads
  as "evidence reached from the cockpit", not a standalone page.

  Thin wrapper over the shared <PageHeader variant="inspect"> so page titles have
  a single source of truth. Public Props are unchanged — 13 Inspect routes consume this.
-->
<script lang="ts">
  import { projectNavHref } from '$lib/layout/navConfig';
  import PageHeader from '$lib/components/PageHeader.svelte';

  interface Props {
    projectId: string;
    title: string;
    subtitle?: string;
    /** Optional right-aligned actions (snippet). */
    actions?: import('svelte').Snippet;
  }
  let { projectId, title, subtitle, actions }: Props = $props();
</script>

<PageHeader
  variant="inspect"
  backHref={projectNavHref(projectId, '')}
  backLabel="Cockpit"
  {title}
  {subtitle}
  {actions}
/>
