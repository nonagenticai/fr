import { describe, it, expect } from 'bun:test';
import {
  DEDUP_CARD_TYPES,
  DEFAULT_BLOCKED_SUPPRESSION_TTL_DAYS,
  DETECTOR_SIGNATURE_DEDUP_CARD_TYPES,
  PARENT_APPROVAL_DEDUP_CARD_TYPES,
  assetDedupesAcrossDone,
  isDedupedCardType,
  msInCurrentList,
  partitionBoardLists,
  resolveBlockedSuppressionTtlMs,
} from './dedup';
import { DEFAULT_TTL_DAYS } from '../../lib/approval-deadline';

// The card_types `blocked-escalate.json` (node `Build Learning Request`) emits.
// That workflow passes its `block_reason_class::card_type::subject`
// learning_signature as `asset_id` specifically so THIS module collapses the
// repeats — its own comment names this file. Until 2026-08-26 neither set
// listed these two, so the route computed the key and never consulted it:
// 125 cards carrying 14 distinct signatures, all minted inside 2 days.
//
// ⭐ 2026-09-15 — `procedure_improvement` joined that list the hard way. The
// workflow collapsed its three shapes into this one and the allowlist was not
// updated with it, so the same defect recurred: 281 cards, 258 inside 24h,
// rising 5→21→41→48→63→80 per hour, with fr `approvals` tracking it 1:1 to
// 1293 pending. This array is the regression fixture for BOTH occurrences.
const BLOCKED_ESCALATE_CARD_TYPES = [
  'workflow_development',
  'prompt_improvement',
  'procedure_improvement',
];

describe('isDedupedCardType', () => {
  it('dedupes the card_types blocked-escalate mints on every BLOCKED transition', () => {
    for (const cardType of BLOCKED_ESCALATE_CARD_TYPES) {
      expect(isDedupedCardType(cardType)).toBe(true);
    }
  });

  it('still dedupes the detector/sweep and parent-approval families', () => {
    expect(isDedupedCardType('workflow_statistics_analysis')).toBe(true);
    expect(isDedupedCardType('decision_development')).toBe(true);
  });

  // The regression that must never pass silently again. Stated as its own case
  // rather than folded into the loop above so a failure names the card_type
  // that is unguarded, not "one of three".
  it('dedupes `procedure_improvement` — the shape blocked-escalate emits today', () => {
    expect(DETECTOR_SIGNATURE_DEDUP_CARD_TYPES.has('procedure_improvement')).toBe(true);
    expect(isDedupedCardType('procedure_improvement')).toBe(true);
  });

  it('does not dedupe a card_type in none of the three sets', () => {
    expect(isDedupedCardType('development_bug_fix')).toBe(false);
    expect(isDedupedCardType('change_decision_development')).toBe(false);
  });
});

describe('dedup set invariants', () => {
  it('keeps the three sets disjoint, so a card_type has exactly one rationale', () => {
    const sets: Array<{ name: string; members: ReadonlySet<string> }> = [
      { name: 'DEDUP_CARD_TYPES', members: DEDUP_CARD_TYPES },
      { name: 'PARENT_APPROVAL_DEDUP_CARD_TYPES', members: PARENT_APPROVAL_DEDUP_CARD_TYPES },
      { name: 'DETECTOR_SIGNATURE_DEDUP_CARD_TYPES', members: DETECTOR_SIGNATURE_DEDUP_CARD_TYPES },
    ];
    const overlaps = sets.flatMap((a, i) =>
      sets.slice(i + 1).map((b) => ({
        pair: `${a.name}/${b.name}`,
        overlap: [...a.members].filter((t) => b.members.has(t)),
      })),
    );
    expect(overlaps.filter((o) => o.overlap.length > 0)).toEqual([]);
  });

  it('keeps `change_*_development` out of every set — those are human-authored', () => {
    for (const t of [
      'change_decision_development',
      'change_principle_development',
      'change_requirement_development',
    ]) {
      expect(isDedupedCardType(t)).toBe(false);
    }
  });
});

// ── BLOCKED-suppression TTL ────────────────────────────────────────────────
//
// MEASURED 2026-09-11: of 19 `workflow_statistics_analysis` cards, 18 were
// BLOCKED, covering 16 distinct asset_ids, several still producing telemetry
// that day; the newest such card was 2026-07-12. The open-list rule
// ("everything except DONE") anticipated DONE and not BLOCKED-forever, so for
// those 16 assets the first failure was the last signal ever emitted.
//
// Most of the cases below are REGRESSION guards, not the fix: DONE must still
// never suppress, a card in an in-progress list must still ALWAYS suppress
// (re-minting a duplicate of work someone is doing right now is a worse
// failure than the one fixed), and an unknown age must resolve to the old
// behaviour rather than to the new one.


const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const DAY_MS = 86_400_000;


describe('msInCurrentList', () => {
  it('prefers listChangedAt, then updatedAt, then createdAt', () => {
    expect(
      msInCurrentList(
        {
          listChangedAt: new Date(NOW - 1000).toISOString(),
          updatedAt: new Date(NOW - 2000).toISOString(),
          createdAt: new Date(NOW - 3000).toISOString(),
        },
        NOW,
      ),
    ).toBe(1000);
    expect(
      msInCurrentList(
        {
          listChangedAt: null,
          updatedAt: new Date(NOW - 2000).toISOString(),
          createdAt: new Date(NOW - 3000).toISOString(),
        },
        NOW,
      ),
    ).toBe(2000);
    expect(
      msInCurrentList(
        { createdAt: new Date(NOW - 3000).toISOString() },
        NOW,
      ),
    ).toBe(3000);
  });

  it('answers null for an absent or unparseable timestamp', () => {
    expect(msInCurrentList({}, NOW)).toBeNull();
    expect(msInCurrentList({ listChangedAt: 'not-a-date' }, NOW)).toBeNull();
  });
});

describe('resolveBlockedSuppressionTtlMs', () => {
  it('derives its default from the operator-set approval deadline', () => {
    // ⛔ NOT a restatement of the constant. This pins the DERIVATION: the TTL
    // is "how long a human is still expected to act on the approval holding
    // this card", which is `lib/approval-deadline.ts :: DEFAULT_TTL_DAYS`, set
    // by an explicit operator decision on 2026-09-02. If that is ever
    // revisited, this fails and forces this to be revisited with it.
    expect(DEFAULT_BLOCKED_SUPPRESSION_TTL_DAYS).toBe(DEFAULT_TTL_DAYS);
    expect(resolveBlockedSuppressionTtlMs(undefined)).toBe(
      DEFAULT_TTL_DAYS * DAY_MS,
    );
    expect(resolveBlockedSuppressionTtlMs('')).toBe(DEFAULT_TTL_DAYS * DAY_MS);
  });

  it('honours an override, including 0 (BLOCKED never suppresses)', () => {
    expect(resolveBlockedSuppressionTtlMs('3')).toBe(3 * DAY_MS);
    expect(resolveBlockedSuppressionTtlMs('0.5')).toBe(DAY_MS / 2);
    // 0 is a legitimate full-disable here — it can only mint a duplicate,
    // never destroy or strand anything. See the resolver's doc comment for
    // why this differs from resolveRetentionDays, which refuses 0.
    expect(resolveBlockedSuppressionTtlMs('0')).toBe(0);
  });

  it('refuses a negative or unparseable override back to the default', () => {
    expect(resolveBlockedSuppressionTtlMs('-1')).toBe(DEFAULT_TTL_DAYS * DAY_MS);
    expect(resolveBlockedSuppressionTtlMs('soon')).toBe(
      DEFAULT_TTL_DAYS * DAY_MS,
    );
  });
});

describe('partitionBoardLists', () => {
  // The canonical board, `services/planka/intake.ts :: DEFAULT_LIST_NAMES`.
  const BOARD_LISTS = [
    { id: 'l-todo', name: 'TODO' },
    { id: 'l-ready', name: 'READY' },
    { id: 'l-doing', name: 'DOING' },
    { id: 'l-qa', name: 'QA' },
    { id: 'l-blocked', name: 'BLOCKED' },
    { id: 'l-done', name: 'DONE' },
  ];

  it('treats every list except DONE as open', () => {
    const { openListIds } = partitionBoardLists(BOARD_LISTS);
    expect([...openListIds].sort()).toEqual(
      ['l-blocked', 'l-doing', 'l-qa', 'l-ready', 'l-todo'].sort(),
    );
    expect(openListIds.has('l-done')).toBe(false);
  });

  it('includeDone (C1-58 ruling 4) adds DONE to the open set and nothing to blocked', () => {
    const { openListIds, blockedListIds } = partitionBoardLists(BOARD_LISTS, { includeDone: true });
    expect(openListIds.has('l-done')).toBe(true);
    expect(openListIds.size).toBe(6);
    expect([...blockedListIds]).toEqual(['l-blocked']);
  });

  it('assetDedupesAcrossDone is true for the deliv:, split: and a3: prefixes ONLY', () => {
    expect(assetDedupesAcrossDone('a3:0df7f61c-8107-40e9-a673-6a1b08d77040:u1')).toBe(true);
    expect(assetDedupesAcrossDone('xa3:abc')).toBe(false);
    expect(assetDedupesAcrossDone('A3:abc')).toBe(false);
    expect(assetDedupesAcrossDone('a3abc')).toBe(false);
    expect(assetDedupesAcrossDone('deliv:0df7f61c-8107-40e9-a673-6a1b08d77040')).toBe(true);
    expect(assetDedupesAcrossDone('split:0df7f61c-8107-40e9-a673-6a1b08d77040:0')).toBe(true);
    expect(assetDedupesAcrossDone('3f2a9c01b7d4e8a6.0')).toBe(false);
    expect(assetDedupesAcrossDone('xdeliv:abc')).toBe(false);
    expect(assetDedupesAcrossDone('DELIV:abc')).toBe(false);
    expect(assetDedupesAcrossDone('xsplit:abc')).toBe(false);
    expect(assetDedupesAcrossDone('SPLIT:abc')).toBe(false);
  });

  it('marks BLOCKED, and ONLY blocked, as blocked', () => {
    // If this ever returned the in-progress lists too, the TTL would start
    // un-suppressing work someone is actively doing.
    const { blockedListIds } = partitionBoardLists(BOARD_LISTS);
    expect([...blockedListIds]).toEqual(['l-blocked']);
  });

  it('never reports a DONE list as blocked', () => {
    // A board with a list named e.g. "DONE" must not leak into either set via
    // the substring matcher.
    const { blockedListIds } = partitionBoardLists(BOARD_LISTS);
    expect(blockedListIds.has('l-done')).toBe(false);
  });

  it('tolerates an unnamed list without calling it blocked', () => {
    const { openListIds, blockedListIds } = partitionBoardLists([
      { id: 'l-x', name: null },
      { id: 'l-y' },
    ]);
    expect(openListIds.size).toBe(2);
    expect(blockedListIds.size).toBe(0);
  });
});
