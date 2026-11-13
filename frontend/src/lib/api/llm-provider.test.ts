import { describe, expect, it } from 'vitest';
import { LLM_MODE_NEUTRAL_NOTE, LLM_MODE_NOTES, llmModeNote } from './llm-provider';

describe('llmModeNote', () => {
  it('maps each known mode to its note', () => {
    for (const [mode, note] of Object.entries(LLM_MODE_NOTES)) expect(llmModeNote(mode)).toBe(note);
  });

  it('a prototype key is not a mode: it gets the neutral note, not a function', () => {
    // `'toString' in LLM_MODE_NOTES` is true; only own keys are modes.
    for (const k of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(llmModeNote(k)).toBe(LLM_MODE_NEUTRAL_NOTE);
    }
  });

  it('absent / unknown modes get the neutral note', () => {
    for (const m of [null, undefined, '', 'byo_allowed']) expect(llmModeNote(m)).toBe(LLM_MODE_NEUTRAL_NOTE);
  });
});
