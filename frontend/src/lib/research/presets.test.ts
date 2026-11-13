import { describe, it, expect } from 'vitest';
import {
  PRESETS,
  PRESET_LABELS,
  PRESET_ORDER,
  presetKnobs,
  type RigorPreset,
} from './presets';

describe('rigor presets', () => {
  it('defines quick / standard / rigorous in order, each labelled', () => {
    expect(PRESET_ORDER).toEqual(['quick', 'standard', 'rigorous']);
    for (const p of PRESET_ORDER) {
      expect(PRESET_LABELS[p]).toBeTruthy();
      expect(PRESETS[p]).toBeDefined();
    }
  });

  it('rigor escalates the pipeline (quick ⊂ standard ⊂ rigorous)', () => {
    expect(PRESETS.quick.cove).toBe(false);
    expect(PRESETS.standard.cove).toBe(true);
    expect(PRESETS.rigorous.ragas).toBe(true);
    expect(PRESETS.rigorous.subgraphx).toBe(true);
    // maxPerSource is non-decreasing across the rigor ladder.
    expect(PRESETS.quick.maxPerSource).toBeLessThanOrEqual(
      PRESETS.standard.maxPerSource,
    );
    expect(PRESETS.standard.maxPerSource).toBeLessThanOrEqual(
      PRESETS.rigorous.maxPerSource,
    );
  });

  it('only rigorous enables snowball + deep ingest', () => {
    expect(PRESETS.quick.snowball).toBe(false);
    expect(PRESETS.standard.snowball).toBe(false);
    expect(PRESETS.rigorous.snowball).toBe(true);
    expect(PRESETS.rigorous.ingestMode).toBe('deep_discovery');
    expect(PRESETS.quick.ingestMode).toBe('quick_ingest');
  });

  it('no preset enables formal verification by default (heavy/optional)', () => {
    for (const p of PRESET_ORDER) {
      expect(PRESETS[p].formal).toBe(false);
    }
  });

  it('presetKnobs returns a fresh, mutable copy (does not alias the shared default)', () => {
    const a = presetKnobs('standard');
    a.cove = false;
    a.maxPerSource = 999;
    // The shared default is untouched.
    expect(PRESETS.standard.cove).toBe(true);
    expect(PRESETS.standard.maxPerSource).toBe(25);
    // A second copy is independent of the first.
    const b = presetKnobs('standard');
    expect(b.cove).toBe(true);
  });

  it('max_results_per_source values are within the engine 1–100 range', () => {
    for (const p of PRESET_ORDER as RigorPreset[]) {
      expect(PRESETS[p].maxPerSource).toBeGreaterThanOrEqual(1);
      expect(PRESETS[p].maxPerSource).toBeLessThanOrEqual(100);
    }
  });
});
