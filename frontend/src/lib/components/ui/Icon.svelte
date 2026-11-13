<script lang="ts">
  // lucide-svelte 1.0.1 still ships SvelteComponentTyped (legacy typing).
  // We accept any component-like value for `icon` so both legacy and
  // Svelte-5 `Component<>` shapes pass through without a type clash.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyComponent = any;

  let {
    icon,
    size = 18,
    strokeWidth = 2,
    class: className = ''
  }: {
    icon: AnyComponent;
    size?: number;
    strokeWidth?: number;
    class?: string;
  } = $props();

  const Comp = $derived(icon);
</script>

<Comp {size} {strokeWidth} class={className} />
