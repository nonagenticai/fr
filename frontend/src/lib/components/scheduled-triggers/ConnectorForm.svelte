<script lang="ts">
  // ConnectorForm.svelte — Spec 2 §2-B
  // Parent wrapper that renders the appropriate per-kind subform.
  // Exposes a `validate()` method that delegates to the active subform.
  //
  // Spec 2 Plan 2-C Phase 3 Task 3.3 — adds a "Test connection" button
  // beneath the active subform that drives
  // POST /api/connectors/test-connection. State machine:
  //   'idle'    — initial; pristine config or has been edited
  //   'loading' — fetch in flight (button disabled)
  //   'ok'      — last test returned ok: true; show green panel
  //   'err'     — last test returned ok: false OR threw; show red panel
  //
  // On any config edit (handleChange), state resets to 'idle' so the
  // user must re-test after edits. The reset uses a one-shot
  // `hasInitialized` guard to avoid the Svelte 5 $effect default-fill
  // race that bit Plan 2-C: bind:value=$bindable(...) triggers a
  // synthetic on-mount effect run that would otherwise immediately
  // clobber a parent-driven `value` prop.
  //
  // H1: there is NO `file` subform. That connector read an arbitrary path on
  // the fr-backend pod and the backend refuses it on every path; a legacy row
  // whose kind is still `file` renders a refusal notice, never a form, and
  // validate() returns false for it.

  import RssConnectorForm from './RssConnectorForm.svelte';
  import GithubQueryConnectorForm from './GithubQueryConnectorForm.svelte';
  import S3ConnectorForm from './S3ConnectorForm.svelte';
  import N8nWebhookConnectorForm from './N8nWebhookConnectorForm.svelte';
  import type { ConnectorKind, UserConnectorKind } from '$lib/types/api';
  import {
    testConnection,
    type DryRunResult,
    type DryRunSample,
  } from '$lib/api/connectors';

  // Connector config union — mirrors backend zod discriminated union.
  type RssConfig = {
    kind: 'rss';
    secret_id: string | null;
    feed_url: string;
    max_items: number;
  };
  type GithubConfig = {
    kind: 'github_query';
    secret_id: string;
    query: string;
    search_type: 'issues' | 'pulls' | 'code' | 'repositories';
    max_results: number;
  };
  type S3Config = {
    kind: 's3';
    secret_id: string;
    bucket: string;
    prefix: string;
    endpoint?: string;
    region: string;
    max_objects: number;
  };
  type N8nConfig = {
    kind: 'n8n_webhook';
    secret_id: string | null;
    webhook_url: string;
    expected_records_path: string;
  };

  type ConnectorConfig = RssConfig | GithubConfig | S3Config | N8nConfig;

  type Props = {
    kind: ConnectorKind;
    value?: ConnectorConfig;
    onChange?: (config: ConnectorConfig) => void;
    disabled?: boolean;
  };

  let {
    kind,
    value = $bindable<ConnectorConfig>(defaultForKind(kind === 'file' ? 'rss' : kind)),
    onChange,
    disabled = false,
  }: Props = $props();

  function defaultForKind(k: UserConnectorKind): ConnectorConfig {
    switch (k) {
      case 'rss':
        return { kind: 'rss', secret_id: null, feed_url: '', max_items: 50 };
      case 'github_query':
        return {
          kind: 'github_query',
          secret_id: '',
          query: '',
          search_type: 'issues',
          max_results: 100,
        };
      case 's3':
        return {
          kind: 's3',
          secret_id: '',
          bucket: '',
          prefix: '',
          region: 'us-east-1',
          max_objects: 100,
        };
      case 'n8n_webhook':
        return {
          kind: 'n8n_webhook',
          secret_id: null,
          webhook_url: '',
          expected_records_path: '$',
        };
    }
  }

  // When kind changes, reset value to the appropriate default.
  $effect(() => {
    if (kind !== 'file' && value.kind !== kind) {
      value = defaultForKind(kind);
    }
  });

  // Per-subform component refs for validate() delegation.
  let rssForm: RssConnectorForm | undefined = $state();
  let githubForm: GithubQueryConnectorForm | undefined = $state();
  let s3Form: S3ConnectorForm | undefined = $state();
  let n8nForm: N8nWebhookConnectorForm | undefined = $state();

  // ---- Test connection state machine ---------------------------------
  // Plan 2-C learned that $effect default-fill races first child render —
  // a value→state effect runs once on mount before the user has touched
  // anything, which would briefly flash the connector through 'idle' and
  // emit spurious resets to 'idle' on top of the user's intentional state
  // transitions. The hasInitialized guard ensures the value-change effect
  // only fires for *real* user edits, not the synthetic mount-time
  // initialization pass.

  type TestState = 'idle' | 'loading' | 'ok' | 'err';
  let testState = $state<TestState>('idle');
  let testResult = $state<DryRunResult | null>(null);
  let testErrorThrown = $state<string | null>(null);
  let hasInitialized = $state(false);

  $effect(() => {
    // Re-run when `value` reference changes (an edit). On mount, the
    // first run sets the guard and exits — subsequent runs (driven by
    // handleChange) reset to idle.
    void value;
    if (!hasInitialized) {
      hasInitialized = true;
      return;
    }
    testState = 'idle';
    testResult = null;
    testErrorThrown = null;
  });

  function handleChange(config: ConnectorConfig) {
    value = config;
    onChange?.(config);
  }

  export function validate(): boolean {
    switch (kind) {
      case 'file':
        return false;
      case 'rss':
        return rssForm?.validate() ?? false;
      case 'github_query':
        return githubForm?.validate() ?? false;
      case 's3':
        return s3Form?.validate() ?? false;
      case 'n8n_webhook':
        return n8nForm?.validate() ?? false;
    }
  }

  /**
   * Resolve the optional secret_id from the current config (may be a
   * UUID string, an empty string, or null depending on connector kind).
   * Empty string and null both map to undefined so the backend accepts
   * the absence cleanly.
   */
  function getSecretId(cfg: ConnectorConfig): string | undefined {
    const sid = (cfg as { secret_id: string | null }).secret_id;
    if (sid && typeof sid === 'string' && sid.length > 0) return sid;
    return undefined;
  }

  async function handleTest() {
    if (!validate()) {
      testState = 'err';
      testErrorThrown = 'Fix validation errors before testing';
      testResult = null;
      return;
    }
    testState = 'loading';
    testResult = null;
    testErrorThrown = null;
    try {
      const result = await testConnection({
        kind,
        config: value,
        secret_id: getSecretId(value),
      });
      testResult = result;
      testState = result.ok ? 'ok' : 'err';
    } catch (err) {
      testErrorThrown =
        err instanceof Error ? err.message : 'Test connection failed';
      testState = 'err';
    }
  }

  // Helpers for the panel — pull a sensible "title" out of a sample
  // record so the OK panel can show what the connector actually saw.
  function previewTitleOf(sample: DryRunSample): string {
    const raw = sample.raw as Record<string, unknown> | null | undefined;
    if (raw && typeof raw === 'object') {
      for (const key of ['title', 'name', 'subject', 'summary']) {
        const v = raw[key];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
    return sample.stable_id;
  }
</script>

<div data-testid="connector-form" data-kind={kind}>
  {#if kind === 'file'}
    <p class="panel panel-err" data-testid="connector-kind-refused" role="alert">
      The file connector is disabled and cannot run. Choose another source kind.
    </p>
  {:else if kind === 'rss'}
    <RssConnectorForm
      bind:this={rssForm}
      value={value as RssConfig}
      onChange={handleChange}
      {disabled}
    />
  {:else if kind === 'github_query'}
    <GithubQueryConnectorForm
      bind:this={githubForm}
      value={value as GithubConfig}
      onChange={handleChange}
      {disabled}
    />
  {:else if kind === 's3'}
    <S3ConnectorForm
      bind:this={s3Form}
      value={value as S3Config}
      onChange={handleChange}
      {disabled}
    />
  {:else if kind === 'n8n_webhook'}
    <N8nWebhookConnectorForm
      bind:this={n8nForm}
      value={value as N8nConfig}
      onChange={handleChange}
      {disabled}
    />
  {/if}

  {#if kind !== 'file'}
  <div class="test-connection" data-testid="test-connection-block">
    <button
      type="button"
      data-testid="test-connection-button"
      onclick={handleTest}
      disabled={disabled || testState === 'loading'}
    >
      {testState === 'loading' ? 'Testing…' : 'Test connection'}
    </button>

    {#if testState === 'ok' && testResult && testResult.ok}
      <div
        class="panel panel-ok"
        data-testid="test-connection-ok-panel"
        role="status"
      >
        <strong>Connection ok.</strong>
        Got {testResult.sample_count} sample record{testResult.sample_count === 1
          ? ''
          : 's'}.
        {#if testResult.sample.length > 0}
          <div data-testid="test-connection-ok-first-sample">
            First sample: {previewTitleOf(testResult.sample[0]!)}
          </div>
        {/if}
      </div>
    {:else if testState === 'err'}
      <div
        class="panel panel-err"
        data-testid="test-connection-err-panel"
        role="alert"
      >
        {#if testErrorThrown}
          <strong>Test connection failed:</strong>
          <span data-testid="test-connection-err-message">{testErrorThrown}</span>
        {:else if testResult && !testResult.ok}
          <strong data-testid="test-connection-err-code">{testResult.error.code}</strong>:
          <span data-testid="test-connection-err-message">{testResult.error.message}</span>
        {/if}
      </div>
    {/if}
  </div>
  {/if}
</div>

<style>
  .test-connection {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .panel {
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font-size: 0.9em;
  }
  .panel-ok {
    background: var(--color-surface-strong);
    color: var(--color-success);
    border: 1px solid var(--color-border);
  }
  .panel-err {
    background: var(--color-surface-strong);
    color: var(--color-danger);
    border: 1px solid var(--color-border);
  }
</style>
