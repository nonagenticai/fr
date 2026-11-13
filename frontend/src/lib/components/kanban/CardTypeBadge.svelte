<!-- CardTypeBadge.svelte -->
<!--
  Small colored dot indicating a card's AA-spec card_group.
  Surfaces card_type as a tooltip; renders gray "Unclassified" when the
  card has no Metadata.card_type (e.g. created outside the improvement flow).
-->
<script lang="ts">
  import { getGroupColors } from '$lib/utils/cardTypeColors';

  interface Props {
    cardType: string | null | undefined;
    cardGroup: string | null | undefined;
  }
  let { cardType, cardGroup }: Props = $props();

  const colors = $derived(getGroupColors(cardGroup));
  const tooltip = $derived(
    cardType ? `${colors.label} — ${cardType}` : 'Unclassified',
  );
</script>

<span
  class="inline-block w-2 h-2 rounded-full flex-shrink-0 {colors.bgClass}"
  title={tooltip}
  aria-label={tooltip}
  data-testid="card-type-badge"
></span>
