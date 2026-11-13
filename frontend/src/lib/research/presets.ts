// Rigor presets for the research studio.
//
// A preset is a STARTING POINT, not a lock: it seeds every stage's knobs, and
// each stage still exposes an Advanced override. `quick` favours speed (few
// sources, no expensive verification); `rigorous` turns the full pipeline on
// (snowball, deep ingest, CoVe + RAGAS + contradictions + SubgraphX + trend).
// Only knobs whose endpoints exist on the live Scientific Processor are wired
// (no meta-analysis / confidence-interval / pipeline). Pure + unit-tested.

export type RigorPreset = 'quick' | 'standard' | 'rigorous';

export type IngestMode = 'quick_ingest' | 'deep_discovery';

export interface StageKnobs {
  /** Discovery: results requested per source (engine clamps 1–100). */
  maxPerSource: number;
  /** Discovery: default result ordering. */
  sortBy: 'relevance' | 'citation_count' | 'year';
  /** Discovery: run an async citation-graph snowball after search. */
  snowball: boolean;
  /** Discovery: snowball walk depth. */
  snowballDepth: number;
  /** Appraise: minimum 7-signal trust to highlight a paper (0 = highlight none). */
  scoreThreshold: number;
  /** Verify: Chain-of-Verification on claims. */
  cove: boolean;
  /** Verify: RAGAS faithfulness scoring on the synthesized answer. */
  ragas: boolean;
  /** Verify: contradiction detection around each pushed entity. */
  contradictions: boolean;
  /** Verify: async SubgraphX explainability. */
  subgraphx: boolean;
  /** Verify: statistical trend analysis. */
  trend: boolean;
  /** Verify: formal (Z3/SymPy/Lean4) verification. */
  formal: boolean;
  /** Build: ingest depth passed to the orchestrator push. */
  ingestMode: IngestMode;
}

export const PRESETS: Record<RigorPreset, Readonly<StageKnobs>> = {
  quick: {
    maxPerSource: 15,
    sortBy: 'relevance',
    snowball: false,
    snowballDepth: 1,
    scoreThreshold: 0,
    cove: false,
    ragas: false,
    contradictions: false,
    subgraphx: false,
    trend: false,
    formal: false,
    ingestMode: 'quick_ingest',
  },
  standard: {
    maxPerSource: 25,
    sortBy: 'relevance',
    snowball: false,
    snowballDepth: 1,
    scoreThreshold: 0.5,
    cove: true,
    ragas: false,
    contradictions: true,
    subgraphx: false,
    trend: false,
    formal: false,
    ingestMode: 'quick_ingest',
  },
  rigorous: {
    maxPerSource: 50,
    sortBy: 'citation_count',
    snowball: true,
    snowballDepth: 2,
    scoreThreshold: 0.6,
    cove: true,
    ragas: true,
    contradictions: true,
    subgraphx: true,
    trend: true,
    formal: false,
    ingestMode: 'deep_discovery',
  },
};

export const PRESET_LABELS: Record<RigorPreset, string> = {
  quick: 'Quick',
  standard: 'Standard',
  rigorous: 'Rigorous',
};

export const PRESET_ORDER: readonly RigorPreset[] = [
  'quick',
  'standard',
  'rigorous',
];

/** A fresh, mutable copy of a preset's knobs (so stage-local overrides never mutate the shared default). */
export function presetKnobs(preset: RigorPreset): StageKnobs {
  return { ...PRESETS[preset] };
}
