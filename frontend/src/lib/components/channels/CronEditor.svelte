<!--
  CronEditor.svelte — Plan 2-C Phase 2 (Task 2.1)

  Two-input cron expression editor with humanized live preview via cronstrue.
  Used by ScheduleIntakeEditor.

  Both `value` (cron) and `timezone` are $bindable so parents can
  `bind:value={trigger.cron} bind:timezone={trigger.timezone}`.
-->
<script lang="ts">
  import cronstrue from 'cronstrue';

  type Props = {
    value?: string;
    timezone?: string;
    disabled?: boolean;
  };

  let {
    value = $bindable(''),
    timezone = $bindable('UTC'),
    disabled = false,
  }: Props = $props();

  // Humanized cron preview. cronstrue throws on syntactically invalid
  // expressions; surface that as an `(invalid: …)` line rather than a crash.
  const preview = $derived.by(() => {
    if (!value) return '';
    try {
      return cronstrue.toString(value, { use24HourTimeFormat: true });
    } catch (err) {
      return `(invalid: ${(err as Error).message})`;
    }
  });

  const isInvalid = $derived(preview.startsWith('(invalid'));
</script>

<div class="cron-editor flex flex-col gap-2" data-testid="cron-editor">
  <label class="flex flex-col gap-1 text-sm">
    <span class="font-medium">Cron expression</span>
    <input
      type="text"
      bind:value
      placeholder="0 9 * * 1"
      {disabled}
      class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm font-mono dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
      data-testid="cron-input"
      aria-invalid={isInvalid}
    />
  </label>

  <label class="flex flex-col gap-1 text-sm">
    <span class="font-medium">Timezone</span>
    <input
      type="text"
      bind:value={timezone}
      placeholder="UTC"
      {disabled}
      class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm font-mono dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
      data-testid="cron-timezone"
    />
  </label>

  <p
    class="cron-preview text-xs italic"
    class:invalid={isInvalid}
    data-testid="cron-preview"
  >
    {preview || '(enter a cron expression to preview)'}
  </p>
</div>

<style>
  .cron-preview {
    color: var(--color-text-muted, #666);
  }
  .cron-preview.invalid {
    color: var(--color-danger);
  }
</style>
