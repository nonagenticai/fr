<script lang="ts">
  // Tenant thread view. A thread bound to a project redirects into the project
  // shell (/projects/P/threads/[id], fr-agui SPEC §7.5).
  import ThreadFocusView from '$lib/components/chat/ThreadFocusView.svelte';

  let { data }: { data: { threadId: string } } = $props();
</script>

<ThreadFocusView threadId={data.threadId} routeProjectId={null} />
