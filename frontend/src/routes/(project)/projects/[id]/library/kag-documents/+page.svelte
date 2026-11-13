<script lang="ts">
  import { ProjectLibraryTab } from '$lib/components/library';

  // KAG documents have their own detail surface at /library/kag/<id>,
  // not /library/kag-documents/<id>.
  const link = (id: string): string => `/library/kag/${encodeURIComponent(id)}`;
</script>

<ProjectLibraryTab kind="kag_document" pluralLabel="KAG documents" linkBuilder={link} />
