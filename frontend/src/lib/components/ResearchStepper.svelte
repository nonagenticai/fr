<!--
  ResearchStepper — a sequential, gated stage rail for the research studio.

  Unlike AssetTabs (parallel `?tab=` panels), this is an ordered stepper: you
  advance one stage at a time, and a stage only unlocks when the previous one is
  satisfied (`canAdvance`). It is a CONTROLLED component — the parent owns the
  active `current` stage and the `maxReached` high-water mark and reacts to
  `onnavigate`; the stepper itself holds no state and touches no SvelteKit
  stores, so it unit-tests without `$app` mocks. The parent is free to mirror
  `current` into a `?stage=` query param for deep-linking.

  Rail click rules: you may always jump back to any already-reached stage, and
  forward exactly one step when `canAdvance` is true (or to any stage already
  unlocked via `maxReached`). Everything further ahead is locked.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  export interface StepDef {
    id: string;
    label: string;
  }

  interface Props {
    steps: readonly StepDef[];
    /** 1-based active stage. */
    current: number;
    /** May move from `current` → `current + 1`. */
    canAdvance?: boolean;
    /** Highest 1-based stage already unlocked (defaults to `current`). */
    maxReached?: number;
    /** Renders the body for the active step id. */
    panel: Snippet<[string]>;
    /** Called with the requested 1-based stage when a (reachable) target is chosen. */
    onnavigate?: (stage: number) => void;
  }

  const {
    steps,
    current,
    canAdvance = false,
    maxReached,
    panel,
    onnavigate,
  }: Props = $props();

  const unlocked = $derived(Math.max(current, maxReached ?? current));
  const activeStep = $derived(steps[current - 1]);

  function reachable(stage: number): boolean {
    if (stage < 1 || stage > steps.length) return false;
    if (stage <= unlocked) return true;
    return stage === current + 1 && canAdvance;
  }

  function go(stage: number): void {
    if (stage === current || !reachable(stage)) return;
    onnavigate?.(stage);
  }

  function stateOf(stage: number): 'done' | 'active' | 'upcoming' {
    if (stage === current) return 'active';
    if (stage < current) return 'done';
    return 'upcoming';
  }

  const canGoBack = $derived(current > 1);
  const canGoForward = $derived(canAdvance && current < steps.length);
</script>

<div class="flex flex-col gap-4" data-testid="research-stepper">
  <!-- Stage rail -->
  <ol class="flex flex-wrap items-center gap-1" data-testid="research-stepper-rail">
    {#each steps as step, i (step.id)}
      {@const stage = i + 1}
      {@const state = stateOf(stage)}
      {@const isReachable = reachable(stage)}
      <li class="flex items-center gap-1">
        <button
          type="button"
          class="flex items-center gap-2 rounded px-2 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50
            {state === 'active'
            ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]'
            : state === 'done'
              ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]'
              : 'bg-[var(--color-surface)] text-[var(--color-text-muted)]'}"
          data-testid={`research-stepper-step-${step.id}`}
          data-state={state}
          aria-current={state === 'active' ? 'step' : undefined}
          disabled={!isReachable}
          onclick={() => go(stage)}
        >
          <span
            class="flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-border)] text-xs"
          >
            {state === 'done' ? '✓' : stage}
          </span>
          <span>{step.label}</span>
        </button>
        {#if i < steps.length - 1}
          <span class="text-[var(--color-text-muted)]" aria-hidden="true">→</span>
        {/if}
      </li>
    {/each}
  </ol>

  <!-- Active stage body -->
  <div data-testid="research-stepper-panel">
    {#if activeStep}
      {@render panel(activeStep.id)}
    {/if}
  </div>

  <!-- Navigation controls -->
  <div class="flex items-center justify-between">
    <button
      type="button"
      class="rounded border border-[var(--color-border)] px-3 py-1 text-sm text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
      data-testid="research-stepper-back"
      disabled={!canGoBack}
      onclick={() => go(current - 1)}
    >
      ← Back
    </button>
    <button
      type="button"
      class="rounded bg-[var(--color-accent)] px-3 py-1 text-sm text-[var(--color-on-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      data-testid="research-stepper-advance"
      disabled={!canGoForward}
      onclick={() => go(current + 1)}
    >
      Next →
    </button>
  </div>
</div>
