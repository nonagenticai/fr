<!--
  /projects/[id]/library/requirements

  Project-scoped Requirements tab. Pilot pattern, now driven by the
  shared ProjectLibraryTab component so all 9 kinds share one
  implementation.
-->
<script lang="ts">
  import { ProjectLibraryTab } from '$lib/components/library';
</script>

<ProjectLibraryTab kind="requirement" pluralLabel="Requirements" />
