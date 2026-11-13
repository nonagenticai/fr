<script lang="ts">
  // FileDropzone.svelte — styled dropzone supporting click-to-choose +
  // drag-and-drop. Replaces bare native file inputs (e.g. /tools/kag) which
  // were effectively invisible. Bind `file` to receive the selected File.

  type Props = {
    file?: File | null;
    accept?: string;
    disabled?: boolean;
    helperText?: string;
  };

  let {
    file = $bindable<File | null>(null),
    accept,
    disabled = false,
    helperText = 'Drag a file here or click to choose',
  }: Props = $props();

  let inputEl: HTMLInputElement | undefined = $state();
  let dragActive = $state(false);

  function openPicker() {
    if (disabled) return;
    inputEl?.click();
  }

  function onInputChange(e: Event) {
    const target = e.target as HTMLInputElement;
    file = target.files?.[0] ?? null;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  }

  function onDragEnter(e: DragEvent) {
    if (disabled) return;
    e.preventDefault();
    dragActive = true;
  }

  function onDragOver(e: DragEvent) {
    if (disabled) return;
    e.preventDefault();
    dragActive = true;
  }

  function onDragLeave(e: DragEvent) {
    if (disabled) return;
    // Only flip false when the pointer actually leaves the dropzone element,
    // not when it crosses into a child node.
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget instanceof Node && (e.currentTarget as Node).contains(related)) {
      return;
    }
    dragActive = false;
  }

  function onDrop(e: DragEvent) {
    if (disabled) return;
    e.preventDefault();
    dragActive = false;
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) {
      file = dropped;
      // Also reflect into the hidden input so re-selecting the same file works
      // via the picker afterward (input change events fire only on diff).
      if (inputEl) inputEl.value = '';
    }
  }

  function clearFile(e: Event) {
    e.stopPropagation();
    file = null;
    if (inputEl) inputEl.value = '';
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
</script>

<div
  role="button"
  tabindex={disabled ? -1 : 0}
  aria-label={helperText}
  aria-disabled={disabled}
  onclick={openPicker}
  onkeydown={onKeyDown}
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  class="block w-full rounded border-2 border-dashed p-8 text-center transition-colors"
  class:cursor-pointer={!disabled}
  class:cursor-not-allowed={disabled}
  class:opacity-60={disabled}
  class:border-[var(--color-accent)]={dragActive && !disabled}
  class:bg-[var(--color-surface)]={dragActive && !disabled}
  data-testid="file-dropzone"
>
  <input
    type="file"
    bind:this={inputEl}
    onchange={onInputChange}
    {accept}
    {disabled}
    class="hidden"
    tabindex="-1"
    aria-hidden="true"
  />

  {#if file}
    <div class="flex items-center justify-center gap-3 text-sm">
      <span class="font-medium text-[var(--color-text)]">{file.name}</span>
      <span class="text-[var(--color-text-muted)]">({formatSize(file.size)})</span>
      <button
        type="button"
        onclick={clearFile}
        class="rounded border px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]"
        {disabled}
      >
        Remove
      </button>
    </div>
  {:else}
    <p class="text-sm text-[var(--color-text-muted)]">{helperText}</p>
    {#if accept}
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">Accepted: {accept}</p>
    {/if}
  {/if}
</div>
