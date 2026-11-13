<!--
  /workflows layout — keeps the tag tree mounted while navigating
  between workflows so the customer never feels "thrown back to the
  dashboard". Data is loaded by +page.ts at each level.
-->
<script lang="ts">
  let { children } = $props();
</script>

<div class="workflows-shell">
  {@render children?.()}
</div>

<style>
  .workflows-shell {
    display: contents;
  }
</style>
