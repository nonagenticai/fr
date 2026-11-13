<script lang="ts">
  // Non-Agentic AI brand mark — the dot-grid logo shared with the nonagentic.ai
  // marketing site. The vertical lines use currentColor (set by the parent's
  // text colour) so the mark reads on both the light and dark/midnight chrome;
  // the teal/coral dots are fixed brand colours. Lives under components/ui/**
  // (design-system; exempt from the design-token lint) so the brand hexes are OK.
  interface Props {
    /** Square size of the mark in px. */
    size?: number;
    /** Render the "Non-Agentic AI" wordmark next to the mark. */
    showWord?: boolean;
    /** Extra classes on the wordmark (e.g. `hidden md:inline` to drop it on narrow bars). */
    wordClass?: string;
    /** Extra classes on the wrapper. */
    class?: string;
  }
  let { size = 28, showWord = false, wordClass = '', class: klass = '' }: Props = $props();
</script>

<span class={`inline-flex items-center gap-2 ${klass}`}>
  <svg
    width={size}
    height={size}
    viewBox="0 0 36 36"
    fill="none"
    role="img"
    aria-label="Non-Agentic AI"
    style="color: var(--color-text-muted)"
  >
    <line x1="6" y1="4" x2="6" y2="32" stroke="currentColor" stroke-width="0.8" opacity="0.55" />
    <line x1="14" y1="4" x2="14" y2="32" stroke="currentColor" stroke-width="0.8" opacity="0.55" />
    <line x1="22" y1="4" x2="22" y2="32" stroke="currentColor" stroke-width="0.8" opacity="0.55" />
    <line x1="30" y1="4" x2="30" y2="32" stroke="currentColor" stroke-width="0.8" opacity="0.55" />
    <circle cx="6" cy="8" r="2.4" fill="#14b8a6" />
    <circle cx="14" cy="14" r="2.4" fill="#14b8a6" />
    <circle cx="22" cy="18" r="2.4" fill="#14b8a6" />
    <circle cx="30" cy="14" r="2.4" fill="#14b8a6" />
    <circle cx="6" cy="28" r="2.4" fill="#f97316" />
    <circle cx="14" cy="22" r="2.4" fill="#f97316" />
    <circle cx="22" cy="18" r="2.4" fill="#f97316" opacity="0.6" />
    <circle cx="30" cy="22" r="2.4" fill="#f97316" />
  </svg>
  {#if showWord}
    <span
      class={`font-semibold leading-none text-[var(--color-text)] ${wordClass}`}
      style="font-family: var(--font-display)"
    >
      Non-Agentic AI
    </span>
  {/if}
</span>
