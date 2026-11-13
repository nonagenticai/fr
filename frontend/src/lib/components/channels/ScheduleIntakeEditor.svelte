<!--
  ScheduleIntakeEditor.svelte — Plan 2-C Phase 2 (Task 2.2)

  Composes the Plan 2-B substrate (CronEditor + ConnectorForm + MapperEditor)
  into a single editor for `ScheduledTriggerCreate` rows.

  Wire shape: mirrors backend `CreateBodySchema.strict()` in
  routes/scheduled-triggers.ts. Required fields with no backend default —
  `card_template` (object with required `card_type`) and `payload_mapper` —
  are default-filled on mount so a freshly opened editor produces a body
  the strict zod will accept once name + cron + connector_config are filled.
-->
<script lang="ts">
  import CronEditor from './CronEditor.svelte';
  import ConnectorForm from '$lib/components/scheduled-triggers/ConnectorForm.svelte';
  import MapperEditor from '$lib/components/scheduled-triggers/MapperEditor.svelte';
  import JsonObjectInput from '$lib/components/forms/JsonObjectInput.svelte';
  import SchemaForm from '$lib/components/forms/SchemaForm.svelte';
  import { getCustomFieldSchema } from '$lib/types/custom-fields';
  import type {
    ScheduledTriggerCreate,
    ConnectorKind,
  } from '$lib/types/api';

  type Mode = 'create' | 'edit';

  type Props = {
    value?: Partial<ScheduledTriggerCreate>;
    projectId: string;
    mode: Mode;
    disabled?: boolean;
  };

  let {
    value = $bindable<Partial<ScheduledTriggerCreate>>({}),
    projectId,
    mode: _mode,
    disabled = false,
  }: Props = $props();

  // Default-fill empty fields synchronously — runs BEFORE the first render
  // so `bind:value={value.cron}` / `bind:timezone={value.timezone}` never
  // see `undefined` (Svelte 5 rejects bind:X={undefined} when the child
  // declares a fallback default).
  //
  // Required-no-default fields (card_template, payload_mapper) must be
  // present on the wire or backend `CreateBodySchema.strict()` rejects.
  if (value.name === undefined) value.name = '';
  if (value.cron === undefined) value.cron = '';
  if (value.timezone === undefined) value.timezone = 'UTC';
  if (!value.source_connector) value.source_connector = 'rss';
  if (!value.connector_config) {
    value.connector_config = {
      kind: 'rss',
      secret_id: null,
      feed_url: '',
      max_items: 50,
    };
  }
  if (!value.payload_mapper) value.payload_mapper = {};
  if (value.target_list === undefined) value.target_list = 'INBOX';
  if (!value.card_template) {
    // Spec 2 §4.5 — continuous_flow projects accept `work_intake_record`.
    value.card_template = { card_type: 'work_intake_record' };
  } else if (!value.card_template.card_type) {
    value.card_template.card_type = 'work_intake_record';
  }
  // SchemaForm's value prop has a fallback default; Svelte 5 rejects
  // bind:value={undefined} against a fallback. Seed custom_fields to {}.
  if (value.card_template.custom_fields === undefined) {
    value.card_template.custom_fields = {};
  }
  if (value.enabled === undefined) value.enabled = true;
  // Keep value.project_id in sync if the parent ever swaps the prop.
  $effect(() => {
    value.project_id = projectId;
  });

  let connectorFormRef: { validate: () => boolean } | undefined = $state();
  let mapperEditorRef: { validate: () => boolean } | undefined = $state();

  // Comma-split labels textbox — round-trips into card_template.labels.
  // Avoids derived state by doing the parse on input.
  function onLabelsInput(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    const parsed = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!value.card_template) {
      value.card_template = { card_type: 'work_intake_record' };
    }
    value.card_template.labels = parsed.length > 0 ? parsed : undefined;
  }

  export function validate(): boolean {
    if (!value.name || !value.name.trim()) return false;
    if (!value.cron || !value.cron.trim()) return false;
    if (!value.card_template?.card_type || !value.card_template.card_type.trim()) {
      return false;
    }
    if (!connectorFormRef?.validate()) return false;
    if (!mapperEditorRef?.validate()) return false;
    return true;
  }
</script>

<div class="schedule-intake-editor flex flex-col gap-4" data-testid="schedule-intake-editor">
  <label class="flex flex-col gap-1 text-sm">
    <span class="font-medium">Name</span>
    <input
      type="text"
      bind:value={value.name}
      required
      maxlength="200"
      placeholder="e.g. RSS — engineering blog"
      class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
      {disabled}
      data-testid="trigger-name"
    />
  </label>

  <CronEditor bind:value={value.cron} bind:timezone={value.timezone} {disabled} />

  <fieldset class="border border-[var(--color-border)] rounded p-3 space-y-3 dark:border-[var(--color-border)]">
    <legend class="text-xs font-semibold uppercase text-[var(--color-text-muted)] px-1">
      Source connector
    </legend>
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Kind</span>
      <select
        bind:value={value.source_connector}
        class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm bg-[var(--color-bg)] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
        {disabled}
        data-testid="connector-kind"
      >
        <option value="rss">rss</option>
        <option value="github_query">github_query</option>
        <option value="s3">s3</option>
        <option value="n8n_webhook">n8n_webhook</option>
      </select>
    </label>
    {#if value.source_connector && value.connector_config}
      <ConnectorForm
        bind:this={connectorFormRef}
        kind={value.source_connector as ConnectorKind}
        bind:value={
          value.connector_config as Parameters<
            typeof ConnectorForm
          >[1] extends { value?: infer V } ? V : never
        }
        {disabled}
      />
    {/if}
  </fieldset>

  <fieldset class="border border-[var(--color-border)] rounded p-3 space-y-2 dark:border-[var(--color-border)]">
    <legend class="text-xs font-semibold uppercase text-[var(--color-text-muted)] px-1">
      Payload mapper
    </legend>
    <MapperEditor
      bind:this={mapperEditorRef}
      bind:value={value.payload_mapper as Record<string, string>}
      sample={undefined}
      {disabled}
    />
  </fieldset>

  <fieldset class="border border-[var(--color-border)] rounded p-3 space-y-3 dark:border-[var(--color-border)]">
    <legend class="text-xs font-semibold uppercase text-[var(--color-text-muted)] px-1">
      Routing
    </legend>
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Target list</span>
      <input
        type="text"
        bind:value={value.target_list}
        placeholder="INBOX"
        class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
        {disabled}
        data-testid="trigger-target-list"
      />
      <span class="text-xs text-[var(--color-text-muted)]">
        Project list new cards land in. Defaults to INBOX.
      </span>
    </label>
  </fieldset>

  <fieldset class="border border-[var(--color-border)] rounded p-3 space-y-3 dark:border-[var(--color-border)]">
    <legend class="text-xs font-semibold uppercase text-[var(--color-text-muted)] px-1">
      Card template
    </legend>
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Card type</span>
      <input
        type="text"
        value={value.card_template?.card_type ?? 'work_intake_record'}
        oninput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          if (!value.card_template) {
            value.card_template = { card_type: v };
          } else {
            value.card_template.card_type = v;
          }
        }}
        required
        placeholder="work_intake_record"
        class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
        {disabled}
        data-testid="trigger-card-type"
      />
      <span class="text-xs text-[var(--color-text-muted)]">
        Continuous-flow projects only accept work intake records.
      </span>
    </label>
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Labels (comma-separated)</span>
      <input
        type="text"
        value={(value.card_template?.labels ?? []).join(', ')}
        oninput={onLabelsInput}
        placeholder="e.g. inbound, rss"
        class="border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] disabled:opacity-50"
        {disabled}
        data-testid="trigger-card-labels"
      />
    </label>
    {#if getCustomFieldSchema(value.card_template?.card_type)}
      {@const schema = getCustomFieldSchema(value.card_template?.card_type)!}
      <fieldset class="border border-[var(--color-border)] rounded p-3 space-y-2 dark:border-[var(--color-border)]">
        <legend class="text-xs font-semibold uppercase text-[var(--color-text-muted)] px-1">
          Custom fields
        </legend>
        <SchemaForm
          {schema}
          bind:value={
            value.card_template!.custom_fields as Record<string, unknown>
          }
          {disabled}
        />
      </fieldset>
    {:else}
      <JsonObjectInput
        label="Custom fields (JSON, optional)"
        bind:value={value.card_template!.custom_fields}
        placeholder={'{"priority": "high"}'}
        hint="Free-form key/value pairs merged into the created card."
        rows={3}
        {disabled}
      />
    {/if}
  </fieldset>

  <label class="flex items-center gap-2 text-sm">
    <input
      type="checkbox"
      bind:checked={value.enabled}
      {disabled}
      data-testid="trigger-enabled"
    />
    Enabled
  </label>
</div>
