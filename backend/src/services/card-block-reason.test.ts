import { describe, it, expect } from 'bun:test';
import {
  BLOCK_REASON_FIELD,
  BLOCK_REASON_GROUP,
  FALLBACK_BLOCK_REASON_CLASS,
  fallbackBlockReason,
  resolveBlockReason,
} from './card-block-reason';
import { GROUP_FIELDS } from './improvement-cards/field-groups';

// MEASURED 2026-09-11: all 19 `workflow_statistics_analysis` cards carried an
// empty/NULL `block_reason`, and 15 of the 106 BLOCKED `workflow_development`
// cards carried none either. An empty one is not untidy — `blocked-escalate ::
// __deriveReason` classifies the card `unknown_no_reason_persisted`, which
// makes the escalation a QUESTION, which `approval-callback :: Resolve Target
// List` treats as a deliberate HOLD, so the card can never leave BLOCKED.

describe('resolveBlockReason', () => {
  it('writes the fallback when the caller states nothing and the card holds nothing', () => {
    const r = resolveBlockReason({ source: 'fr.test' });
    expect(r.outcome).toBe('wrote_fallback');
    expect(r.content).toBe(fallbackBlockReason('fr.test'));
    expect(r.content.length).toBeGreaterThan(0);
  });

  it('treats whitespace-only as nothing stated — the measured rows were empty, not absent', () => {
    for (const empty of ['', '   ', '\n\t', null, undefined]) {
      const r = resolveBlockReason({ callerReason: empty, source: 'fr.test' });
      expect(r.outcome).toBe('wrote_fallback');
    }
  });

  it("prefers the caller's reason over a value left by a PREVIOUS block", () => {
    // ⛔ Load-bearing ordering. A card can be blocked, released and blocked
    // again; the previous block's reason describes the wrong event, and a
    // stale-but-specific reason misleads worse than an empty one because it
    // reads as an answer.
    const r = resolveBlockReason({
      callerReason: 'wip_limit_hold: DOING is at its WIP limit',
      existingReason: 'qa_gate_failed: oracle G3',
      source: 'fr.test',
    });
    expect(r.outcome).toBe('wrote_caller');
    expect(r.content).toBe('wip_limit_hold: DOING is at its WIP limit');
  });

  it('keeps an existing reason when this caller has nothing to say', () => {
    const r = resolveBlockReason({
      existingReason: 'qa_gate_failed: oracle G3',
      source: 'fr.test',
    });
    expect(r.outcome).toBe('kept_existing');
    expect(r.content).toBe('qa_gate_failed: oracle G3');
  });

  it('trims the caller reason rather than storing the padding', () => {
    const r = resolveBlockReason({ callerReason: '  why  ', source: 'fr.test' });
    expect(r.content).toBe('why');
  });
});

describe('fallbackBlockReason', () => {
  it('is actionable, not decorative', () => {
    const text = fallbackBlockReason('fr.kanban.move_card');
    // Names the class, so __deriveReason can classify it…
    expect(text.startsWith(`${FALLBACK_BLOCK_REASON_CLASS}:`)).toBe(true);
    // …names the writer, so a human knows what put the card here…
    expect(text).toContain('fr.kanban.move_card');
    // …and says what to do next. "blocked" on its own would fail this.
    expect(text).toContain('comments');
    expect(text.length).toBeGreaterThan(80);
  });

  it('does NOT reuse the degenerate class __deriveReason already invents', () => {
    // If the fallback said `unknown_no_reason_persisted`, "fr stamped a
    // fallback" would be indistinguishable from "fr stamped nothing" — the
    // exact ambiguity this module exists to remove.
    expect(FALLBACK_BLOCK_REASON_CLASS).not.toBe('unknown_no_reason_persisted');
    expect(fallbackBlockReason('fr.test')).not.toContain(
      'unknown_no_reason_persisted',
    );
  });

  it('fits Planka\'s 512-char customFieldValue cap without truncation', () => {
    expect(fallbackBlockReason('fr.cards.improvement.create').length).toBeLessThanOrEqual(512);
  });
});

describe('stampBlockReason', () => {

  it('block_reason is a field of the RM template group fr writes it in', () => {
    expect(GROUP_FIELDS[BLOCK_REASON_GROUP]).toContain(BLOCK_REASON_FIELD);
  });
});

