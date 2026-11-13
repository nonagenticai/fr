<script lang="ts">
  // N8nWebhookConnectorForm.svelte — Spec 2 §2-B
  // Fields: webhook_url (required URL), expected_records_path (default "$"),
  //         secret_id (optional HMAC signing key).
  // Mirrors N8nWebhookConnectorConfig zod schema.

  import SecretPicker from '$lib/components/ui/SecretPicker.svelte';

  type N8nWebhookConnectorConfig = {
    kind: 'n8n_webhook';
    secret_id: string | null;
    webhook_url: string;
    expected_records_path: string;
  };

  type Props = {
    value?: N8nWebhookConnectorConfig;
    onChange?: (config: N8nWebhookConnectorConfig) => void;
    disabled?: boolean;
  };

  let {
    value = $bindable<N8nWebhookConnectorConfig>({
      kind: 'n8n_webhook',
      secret_id: null,
      webhook_url: '',
      expected_records_path: '$',
    }),
    onChange,
    disabled = false,
  }: Props = $props();

  let errors = $state<{ webhook_url?: string; expected_records_path?: string }>({});

  function emit() {
    onChange?.(value);
  }

  function validateWebhookUrl() {
    if (!value.webhook_url.trim()) {
      errors.webhook_url = 'Webhook URL is required';
    } else {
      try {
        new URL(value.webhook_url);
        errors.webhook_url = undefined;
      } catch {
        errors.webhook_url = 'Must be a valid URL';
      }
    }
  }

  function validateRecordsPath() {
    const p = value.expected_records_path.trim();
    if (!p.startsWith('$')) {
      errors.expected_records_path = 'Must start with $';
    } else if (/\[\?\(/.test(p) || /\[\(/.test(p)) {
      errors.expected_records_path = 'Filter/script expressions are not allowed';
    } else {
      errors.expected_records_path = undefined;
    }
  }

  function onWebhookUrlInput(e: Event) {
    value.webhook_url = (e.target as HTMLInputElement).value;
    if (errors.webhook_url) validateWebhookUrl();
    emit();
  }

  function onWebhookUrlBlur() {
    validateWebhookUrl();
  }

  function onRecordsPathInput(e: Event) {
    value.expected_records_path = (e.target as HTMLInputElement).value;
    if (errors.expected_records_path) validateRecordsPath();
    emit();
  }

  function onRecordsPathBlur() {
    validateRecordsPath();
  }

  function onSecretSelect(id: string | null) {
    value.secret_id = id;
    emit();
  }

  export function validate(): boolean {
    validateWebhookUrl();
    validateRecordsPath();
    return !errors.webhook_url && !errors.expected_records_path;
  }
</script>

<div class="flex flex-col gap-4" data-testid="n8n-webhook-connector-form">
  <!-- Webhook URL -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="n8n-webhook-url">
      Webhook URL <span class="text-[var(--color-danger)]">*</span>
    </label>
    <input
      id="n8n-webhook-url"
      type="url"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 {errors.webhook_url ? 'border-[var(--color-danger)]' : ''}"
      value={value.webhook_url}
      placeholder="https://n8n.nonagentic.ai/webhook/abc123"
      oninput={onWebhookUrlInput}
      onblur={onWebhookUrlBlur}
      data-testid="n8n-webhook-url-input"
    />
    {#if errors.webhook_url}
      <p class="text-xs text-[var(--color-danger)]" data-testid="n8n-webhook-url-error">{errors.webhook_url}</p>
    {/if}
  </div>

  <!-- Expected records path -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="n8n-records-path">
      Records path <span class="text-xs text-[var(--color-text-muted,#888)]">(JSONPath into incoming payload)</span>
    </label>
    <input
      id="n8n-records-path"
      type="text"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 {errors.expected_records_path ? 'border-[var(--color-danger)]' : ''}"
      value={value.expected_records_path}
      placeholder="$"
      oninput={onRecordsPathInput}
      onblur={onRecordsPathBlur}
      data-testid="n8n-records-path-input"
    />
    {#if errors.expected_records_path}
      <p class="text-xs text-[var(--color-danger)]" data-testid="n8n-records-path-error">{errors.expected_records_path}</p>
    {/if}
  </div>

  <!-- Optional HMAC secret -->
  <div class="flex flex-col gap-1">
    <p class="text-sm font-medium">
      HMAC signing secret <span class="text-xs text-[var(--color-text-muted,#888)]">(optional)</span>
    </p>
    <SecretPicker
      value={value.secret_id}
      placeholder="Select HMAC secret…"
      {disabled}
      onSelect={onSecretSelect}
      data-testid="n8n-secret-picker"
    />
  </div>
</div>
