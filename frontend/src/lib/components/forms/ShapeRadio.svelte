<script lang="ts">
  // Spec 2 §4 — project shape selector for the project-create form.
  // Pure presentational: bind:value drives the parent form's state, and
  // the optional `onchange` callback fires when the user picks a value.
  import type { ProjectShape } from '$lib/types/api';

  let {
    value = $bindable('deliverable'),
    onchange,
    disabled = false,
  }: {
    value?: ProjectShape;
    onchange?: (v: ProjectShape) => void;
    disabled?: boolean;
  } = $props();

  function pick(v: ProjectShape) {
    value = v;
    onchange?.(v);
  }
</script>

<fieldset class="shape-radio" data-testid="shape-radio">
  <legend>Project shape</legend>
  <label class="opt">
    <input
      type="radio"
      name="project_shape"
      value="deliverable"
      checked={value === 'deliverable'}
      {disabled}
      onchange={() => pick('deliverable')}
    />
    <div class="text">
      <span class="title">Deliverable</span>
      <span class="hint">Has a target output and end date — burndown chart enabled.</span>
    </div>
  </label>
  <label class="opt">
    <input
      type="radio"
      name="project_shape"
      value="continuous_flow"
      checked={value === 'continuous_flow'}
      {disabled}
      onchange={() => pick('continuous_flow')}
    />
    <div class="text">
      <span class="title">Continuous flow</span>
      <span class="hint">Open-ended kanban with recurring intake — throughput chart enabled.</span>
    </div>
  </label>
</fieldset>

<style>
  .shape-radio {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 16px;
    display: grid;
    gap: 8px;
  }
  .shape-radio legend {
    padding: 0 6px;
    font-weight: 600;
  }
  .opt {
    display: grid;
    grid-template-columns: 24px 1fr;
    column-gap: 8px;
    align-items: start;
    cursor: pointer;
  }
  .opt input {
    margin-top: 4px;
  }
  .text {
    display: grid;
    gap: 2px;
  }
  .title {
    font-weight: 500;
  }
  .hint {
    font-size: 0.85em;
    color: var(--color-text-muted);
  }
</style>
