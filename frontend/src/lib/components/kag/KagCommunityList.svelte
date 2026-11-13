<!--
  KagCommunityList — renders KAG community-detection output as collapsible groups.

  The graph-analytics endpoint returns ONLY `entity_communities` (entityId →
  community number) and `community_sizes` (community number → size). It carries no
  member labels and no per-community name, so members can only be shown as their
  raw entity IDs — there is no human label available upstream. Groups are inverted
  from the entity→community map and sorted by size descending so the largest
  communities lead.
-->
<script lang="ts">
  interface Props {
    entityCommunities: Record<string, number>;
    communitySizes?: Record<string, number>;
  }

  const { entityCommunities, communitySizes }: Props = $props();

  const groups = $derived.by(() => {
    const g = new Map<number, string[]>();
    for (const [entityId, comm] of Object.entries(entityCommunities)) {
      if (!g.has(comm)) g.set(comm, []);
      g.get(comm)!.push(entityId);
    }
    return [...g.entries()]
      .map(([id, members]) => ({ id, members, size: communitySizes?.[String(id)] ?? members.length }))
      .sort((a, b) => b.size - a.size);
  });
</script>

<div data-testid="kag-community-list" class="mt-2 flex flex-col gap-2">
  {#each groups as grp (grp.id)}
    <details class="text-sm border border-[var(--color-border)] rounded" data-testid="kag-community-group">
      <summary class="cursor-pointer font-semibold px-3 py-2">Community {grp.id} ({grp.size})</summary>
      <!-- Members are entity IDs: no labels are available from the analytics endpoint. -->
      <ul class="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
        {#each grp.members as m (m)}
          <li class="px-3 py-1.5 font-mono text-xs text-[var(--color-text-muted)]">{m}</li>
        {/each}
      </ul>
    </details>
  {/each}
</div>
