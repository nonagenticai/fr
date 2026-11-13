<script lang="ts">
  // Project-shell thread view (fr-agui SPEC §7.3 "Agent"): one of the caller's
  // project-bound agent threads, inside /projects/[id].
  import { page } from '$app/state';
  import ThreadFocusView from '$lib/components/chat/ThreadFocusView.svelte';

  const projectId = $derived(page.params.id ?? '');
  const threadId = $derived(page.params.threadId ?? '');
</script>

<ThreadFocusView {threadId} routeProjectId={projectId} />
