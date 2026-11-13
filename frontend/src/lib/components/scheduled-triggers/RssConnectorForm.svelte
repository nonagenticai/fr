<script lang="ts">
  // RssConnectorForm.svelte — Spec 2 §2-B
  // Fields: feed_url (required URL), max_items (1-500, default 50).
  // Mirrors RssConnectorConfig zod schema.

  type RssConnectorConfig = {
    kind: 'rss';
    secret_id: string | null;
    feed_url: string;
    max_items: number;
  };

  type Props = {
    value?: RssConnectorConfig;
    onChange?: (config: RssConnectorConfig) => void;
    disabled?: boolean;
  };

  let {
    value = $bindable<RssConnectorConfig>({
      kind: 'rss',
      secret_id: null,
      feed_url: '',
      max_items: 50,
    }),
    onChange,
    disabled = false,
  }: Props = $props();

  let errors = $state<{ feed_url?: string; max_items?: string }>({});

  function emit() {
    onChange?.(value);
  }

  function validateFeedUrl() {
    if (!value.feed_url.trim()) {
      errors.feed_url = 'Feed URL is required';
    } else {
      try {
        new URL(value.feed_url);
        errors.feed_url = undefined;
      } catch {
        errors.feed_url = 'Must be a valid URL';
      }
    }
  }

  function validateMaxItems() {
    const n = value.max_items;
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      errors.max_items = 'Must be an integer between 1 and 500';
    } else {
      errors.max_items = undefined;
    }
  }

  function onFeedUrlInput(e: Event) {
    value.feed_url = (e.target as HTMLInputElement).value;
    if (errors.feed_url) validateFeedUrl();
    emit();
  }

  function onFeedUrlBlur() {
    validateFeedUrl();
  }

  function onMaxItemsInput(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    value.max_items = parseInt(raw, 10) || 50;
    if (errors.max_items) validateMaxItems();
    emit();
  }

  function onMaxItemsBlur() {
    validateMaxItems();
  }

  export function validate(): boolean {
    validateFeedUrl();
    validateMaxItems();
    return !errors.feed_url && !errors.max_items;
  }
</script>

<div class="flex flex-col gap-4" data-testid="rss-connector-form">
  <!-- Feed URL -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="rss-feed-url">
      Feed URL <span class="text-[var(--color-danger)]">*</span>
    </label>
    <input
      id="rss-feed-url"
      type="url"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 {errors.feed_url ? 'border-[var(--color-danger)]' : ''}"
      value={value.feed_url}
      placeholder="https://example.com/feed.xml"
      oninput={onFeedUrlInput}
      onblur={onFeedUrlBlur}
      data-testid="rss-feed-url-input"
    />
    {#if errors.feed_url}
      <p class="text-xs text-[var(--color-danger)]" data-testid="rss-feed-url-error">{errors.feed_url}</p>
    {/if}
  </div>

  <!-- Max items -->
  <div class="flex flex-col gap-1">
    <label class="text-sm font-medium" for="rss-max-items">
      Max items <span class="text-xs text-[var(--color-text-muted,#888)]">(1 – 500)</span>
    </label>
    <input
      id="rss-max-items"
      type="number"
      min="1"
      max="500"
      {disabled}
      class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 {errors.max_items ? 'border-[var(--color-danger)]' : ''}"
      value={value.max_items}
      oninput={onMaxItemsInput}
      onblur={onMaxItemsBlur}
      data-testid="rss-max-items-input"
    />
    {#if errors.max_items}
      <p class="text-xs text-[var(--color-danger)]" data-testid="rss-max-items-error">{errors.max_items}</p>
    {/if}
  </div>
</div>
