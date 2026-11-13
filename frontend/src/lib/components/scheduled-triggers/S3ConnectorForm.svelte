<script lang="ts">
  // S3ConnectorForm.svelte — Spec 2 §2-B
  // Fields: bucket (required), prefix, region, endpoint (optional, for MinIO),
  //         max_objects (1-1000), secret_id (required — holds JSON creds).
  // Mirrors S3ConnectorConfig zod schema.

  import SecretPicker from '$lib/components/ui/SecretPicker.svelte';

  type S3ConnectorConfig = {
    kind: 's3';
    secret_id: string;
    bucket: string;
    prefix: string;
    endpoint?: string;
    region: string;
    max_objects: number;
  };

  type Props = {
    value?: S3ConnectorConfig;
    onChange?: (config: S3ConnectorConfig) => void;
    disabled?: boolean;
  };

  let {
    value = $bindable<S3ConnectorConfig>({
      kind: 's3',
      secret_id: '',
      bucket: '',
      prefix: '',
      endpoint: undefined,
      region: 'us-east-1',
      max_objects: 100,
    }),
    onChange,
    disabled = false,
  }: Props = $props();

  let errors = $state<{
    bucket?: string;
    secret_id?: string;
    endpoint?: string;
    max_objects?: string;
  }>({});

  function emit() {
    onChange?.(value);
  }

  function validateBucket() {
    if (!value.bucket.trim()) {
      errors.bucket = 'Bucket name is required';
    } else {
      errors.bucket = undefined;
    }
  }

  function validateSecret() {
    if (!value.secret_id) {
      errors.secret_id = 'AWS credentials secret is required';
    } else {
      errors.secret_id = undefined;
    }
  }

  function validateEndpoint() {
    if (value.endpoint && value.endpoint.trim()) {
      try {
        new URL(value.endpoint);
        errors.endpoint = undefined;
      } catch {
        errors.endpoint = 'Must be a valid URL';
      }
    } else {
      errors.endpoint = undefined;
    }
  }

  function validateMaxObjects() {
    const n = value.max_objects;
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      errors.max_objects = 'Must be an integer between 1 and 1000';
    } else {
      errors.max_objects = undefined;
    }
  }

  function onBucketInput(e: Event) {
    value.bucket = (e.target as HTMLInputElement).value;
    if (errors.bucket) validateBucket();
    emit();
  }

  function onBucketBlur() {
    validateBucket();
  }

  function onPrefixInput(e: Event) {
    value.prefix = (e.target as HTMLInputElement).value;
    emit();
  }

  function onRegionInput(e: Event) {
    value.region = (e.target as HTMLInputElement).value;
    emit();
  }

  function onEndpointInput(e: Event) {
    const v = (e.target as HTMLInputElement).value.trim();
    value.endpoint = v || undefined;
    if (errors.endpoint) validateEndpoint();
    emit();
  }

  function onEndpointBlur() {
    validateEndpoint();
  }

  function onMaxObjectsInput(e: Event) {
    value.max_objects = parseInt((e.target as HTMLInputElement).value, 10) || 100;
    if (errors.max_objects) validateMaxObjects();
    emit();
  }

  function onMaxObjectsBlur() {
    validateMaxObjects();
  }

  function onSecretSelect(id: string | null) {
    value.secret_id = id ?? '';
    if (errors.secret_id) validateSecret();
    emit();
  }

  export function validate(): boolean {
    validateBucket();
    validateSecret();
    validateEndpoint();
    validateMaxObjects();
    return !errors.bucket && !errors.secret_id && !errors.endpoint && !errors.max_objects;
  }
</script>

<div class="flex flex-col gap-4" data-testid="s3-connector-form">
  <!-- AWS Credentials Secret (required) -->
  <div class="flex flex-col gap-1">
    <p class="text-sm font-medium">
      AWS Credentials Secret <span class="text-[var(--color-danger)]">*</span>
    </p>
    <p class="text-xs text-[var(--color-text-muted,#888)]">
      JSON with keys: <code>access_key_id</code>, <code>secret_access_key</code>
    </p>
    <SecretPicker
      value={value.secret_id || null}
      kind="custom"
      placeholder="Select AWS credentials secret…"
      allowCreate={true}
      {disabled}
      onSelect={onSecretSelect}
      data-testid="s3-secret-picker"
    />
    {#if errors.secret_id}
      <p class="text-xs text-[var(--color-danger)]" data-testid="s3-secret-error">{errors.secret_id}</p>
    {/if}
  </div>

  <!-- Bucket -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="s3-bucket">
      Bucket <span class="text-[var(--color-danger)]">*</span>
    </label>
    <input
      id="s3-bucket"
      type="text"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 {errors.bucket ? 'border-[var(--color-danger)]' : ''}"
      value={value.bucket}
      placeholder="my-bucket"
      oninput={onBucketInput}
      onblur={onBucketBlur}
      data-testid="s3-bucket-input"
    />
    {#if errors.bucket}
      <p class="text-xs text-[var(--color-danger)]" data-testid="s3-bucket-error">{errors.bucket}</p>
    {/if}
  </div>

  <!-- Prefix -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="s3-prefix">
      Prefix <span class="text-xs text-[var(--color-text-muted,#888)]">(optional)</span>
    </label>
    <input
      id="s3-prefix"
      type="text"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
      value={value.prefix}
      placeholder="data/incoming/"
      oninput={onPrefixInput}
      data-testid="s3-prefix-input"
    />
  </div>

  <!-- Region -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="s3-region">Region</label>
    <input
      id="s3-region"
      type="text"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
      value={value.region}
      placeholder="us-east-1"
      oninput={onRegionInput}
      data-testid="s3-region-input"
    />
  </div>

  <!-- Endpoint (MinIO) -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="s3-endpoint">
      Endpoint <span class="text-xs text-[var(--color-text-muted,#888)]">(optional — for MinIO / non-AWS)</span>
    </label>
    <input
      id="s3-endpoint"
      type="url"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 {errors.endpoint ? 'border-[var(--color-danger)]' : ''}"
      value={value.endpoint ?? ''}
      placeholder="https://s3.example.com"
      oninput={onEndpointInput}
      onblur={onEndpointBlur}
      data-testid="s3-endpoint-input"
    />
    {#if errors.endpoint}
      <p class="text-xs text-[var(--color-danger)]" data-testid="s3-endpoint-error">{errors.endpoint}</p>
    {/if}
  </div>

  <!-- Max objects -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="s3-max-objects">
      Max objects <span class="text-xs text-[var(--color-text-muted,#888)]">(1 – 1000)</span>
    </label>
    <input
      id="s3-max-objects"
      type="number"
      min="1"
      max="1000"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 {errors.max_objects ? 'border-[var(--color-danger)]' : ''}"
      value={value.max_objects}
      oninput={onMaxObjectsInput}
      onblur={onMaxObjectsBlur}
      data-testid="s3-max-objects-input"
    />
    {#if errors.max_objects}
      <p class="text-xs text-[var(--color-danger)]" data-testid="s3-max-objects-error">{errors.max_objects}</p>
    {/if}
  </div>
</div>
