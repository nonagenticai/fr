// tests/fixtures/done-equivalent-names.ts
//
// THE shared list-name table for the ONE DONE predicate. Imported by
//   (the backend done-equivalent-single-sourced suite that also consumed it was
//   deleted 2026-10-29 under the no-test-doubles ruling)
//   - frontend/src/lib/cards/done-equivalent.test.ts (the frontend copy's normalizer and allowlist
//     EQUAL the backend's on every row).
// Plain data, no imports — so both the Bun backend suite and the Vite frontend suite can load it.

/**
 * Table: name → done-equivalent? EXACT NORMALIZED ALLOWLIST (validator V3, 2026-10-06): the
 * substring match (V1) and the whole-token-with-negators match (V2) both kept classifying
 * natural-language names ("Won't ship", "Not yet done", "Half-complete", …) as DONE.
 */
export const DONE_TABLE: ReadonlyArray<readonly [string, boolean]> = [
  // positives — the allowlist, under normalization ONLY (NFKC, \p{Cf} removal, trim, collapse
  // internal whitespace, upper-case)
  ['DONE', true],
  ['Done', true],
  ['done', true],
  [' Done ', true],
  ['  done\t', true],
  ['dOnE', true],
  ['DONE\u200B', true], // trailing zero-width (Cf) is removed
  ['\u200BDONE', true],
  ['D\u200BONE', true], // Cf removal is ANYWHERE (ruling r17): an invisible char is not a different name
  ['DONE\uFEFF', true], // BOM / ZWNBSP is Cf too
  ['ｄｏｎｅ', true], // fullwidth lower — NFKC folds compatibility forms
  ['ＤＯＮＥ', true], // fullwidth upper
  ['SHIPPED', true],
  ['Shipped', true],
  ['Published', true],
  ['PUBLISHED', true],
  ['PUBLISHING', true], // origin/main lib/phase.ts + frontend phase.ts key
  ['COMPLETED', true],
  ['Complete', true],
  ['RELEASED', true],
  ['DONE/RELEASED', true], // n8n receiver normalize() alias (origin/main isFinishedList)
  ['Done/Released', true],
  // negatives — NO symbol stripping (validator V4 NO-A, ruling r17): a symbol can negate
  ['❌ DONE', false],
  ['🚫 DONE', false],
  ['✗ DONE', false],
  ['DONE 🚫', false],
  ['DONE?', false],
  ['¿DONE?', false],
  ['Done ✅', false],
  [' Done ✅', false],
  ['DONE!', false],
  ['D-O-N-E', false],
  ['COMPLETED ✔', false],
  ['Completed?', false],
  ['Released?', false],
  ['DONE.', false],
  ['"DONE"', false],
  ['Done_Done', false],
  ['DONE_RELEASED', false],
  // negatives — anything that is not EXACTLY an allowlisted name
  ['QA DONE', false],
  ['DONE (archive)', false],
  ['Release SHIP', false],
  ['Ready to publish', false],
  ['Ready-to-publish', false],
  ['READY TO SHIP', false],
  ['Ready for QA done', false],
  ["Won't ship", false],
  ["DON'T SHIP", false],
  ['Not yet done', false],
  ['To be done', false],
  ['Almost done', false],
  ['In-complete', false],
  ['Half-complete', false],
  ['Already done', false],
  ['WIP done', false],
  ['Readiness done', false],
  ['Déjà done', false],
  ['Done-ish', false],
  ['Done-Done', false],
  ['DONE / RELEASED', false],
  ['Ship it', false],
  ['Shipping', false],
  ['Published v2', false],
  ['ABANDONED', false],
  ['Abandoned', false],
  ['DROPPED', false],
  ['Dropped', false],
  ['UNDONE', false],
  ['UN-DONE', false],
  ['Un done', false],
  ['NOT DONE', false],
  ['Not-done', false],
  ['NOT_DONE', false],
  ['NOTDONE', false],
  ['Do not ship', false],
  ['No-ship', false],
  ['never shipped', false],
  ['UNPUBLISHED', false],
  ['Incomplete', false],
  ['Not complete', false],
  ['RELATIONSHIPS', false],
  ['Shipments', false],
  ['OWNERSHIP', false],
  ['Pre-release', false],
  ['RELEASE', false],
  ['SHIP', false],
  ['PUBLISH', false],
  ['D0NE', false], // zero, not O
  ['Dоne', false], // Cyrillic о
  ['DONÉ', false],
  ['ÐONE', false],
  ['Donè', false],
  ['İDONE', false],
  ['✅', false],
  ['TODO', false],
  ['READY', false],
  ['DOING', false],
  ['QA', false],
  ['BLOCKED', false],
  ['E2E', false],
  ['INSPECTING', false],
  ['', false],
  ['   ', false],
];
