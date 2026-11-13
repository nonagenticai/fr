<script lang="ts">
  type Variant = 'box' | 'text';

  let {
    variant = 'box',
    height = '1rem',
    count = 1,
    class: className = ''
  }: {
    variant?: Variant;
    height?: string;
    count?: number;
    class?: string;
  } = $props();

  const radiusClass = $derived(
    {
      box: 'rounded-md',
      text: 'rounded-sm'
    }[variant]
  );

  // For `text` variant with count > 1, rotate widths for visual variety.
  const TEXT_WIDTHS = ['60%', '90%', '70%'];

  function widthFor(i: number): string {
    if (variant === 'text' && count > 1) {
      return TEXT_WIDTHS[i % TEXT_WIDTHS.length] ?? '100%';
    }
    return '100%';
  }

  function dimsFor(i: number): { width: string; height: string } {
    return { width: widthFor(i), height };
  }

  const items = $derived(
    Array.from({ length: Math.max(1, count) }, (_, i) => ({ i, ...dimsFor(i) }))
  );
</script>

<div class={`flex flex-col gap-2 ${className}`} data-testid="skeleton-root">
  {#each items as item (item.i)}
    <div
      data-testid="skeleton-item"
      class={`block bg-[var(--color-surface-strong)] motion-safe:animate-pulse ${radiusClass}`}
      style="width: {item.width}; height: {item.height};"
      aria-hidden="true"
    ></div>
  {/each}
</div>
