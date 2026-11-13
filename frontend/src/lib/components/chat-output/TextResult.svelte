<script lang="ts">
  // Plain-text rendering for the free-text path AND the during-streaming
  // fallback for typed schemas (raw JSON characters before the `result`
  // frame lands). Extracted from the inline bubble in +page.svelte so the
  // four-way dispatch is symmetric. Kept dumb on purpose — no markdown
  // parsing, no link autolinking — that's a separate scope decision.
  let {
    content,
    placeholder = ''
  }: { content: string; placeholder?: string } = $props();
</script>

<span class="whitespace-pre-wrap">{content || placeholder}</span>
