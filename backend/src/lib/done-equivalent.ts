// src/lib/done-equivalent.ts
//
// ⛔ THE ONE PREDICATE FOR "THIS PLANKA LIST MEANS DONE". Every fr site that classifies a list
// name as DONE imports this function — the DONE-move guard (services/done-guard.ts), the
// break-glass route, improvement create-into-DONE, the list-rename guard (routes/assets/kanban.ts),
// the cockpit phase rail (services/cockpit/project-cockpit.ts normalizePhase), the /api/measure
// and card-page phase mirror (lib/phase.ts phaseFromListName) and the finished-card approval
// refusal (services/toc-hooks.ts isFinishedList).
//
// WHY ONE FUNCTION: the guard used an EXACT name set while the cockpit counted any list whose
// name CONTAINS DONE/SHIP/PUBLISH as done, so a move to e.g. "SHIPPED" was unguarded yet scored
// as DONE (validator NO-3c, 2026-10-05). A guard narrower than any consumer is a hole; two
// spellings drift.
//
// WHY AN EXACT ALLOWLIST (validator V3, 2026-10-06): a substring match (V1) and then a
// whole-token match with a negator list (V2) both kept classifying natural-language names as
// DONE — "Won't ship", "DON'T SHIP", "Not yet done", "To be done", "Almost done", "In-complete",
// "Half-complete". Parsing negation out of free text never converges, so there is none: the
// NORMALIZED WHOLE NAME must be exactly one of DONE_EQUIVALENT_NAMES.
//
// WHY NO SYMBOL STRIPPING (validator V4 NO-A, ruling r17, 2026-10-06): stripping edge
// emoji/punctuation made "❌ DONE", "🚫 DONE", "✗ DONE", "DONE 🚫", "DONE?" and "¿DONE?" DONE.
// A symbol can negate, so normalization is ONLY, in this order:
//   NFKC → remove format characters (\p{Cf}: zero-width etc., anywhere) → trim → collapse
//   internal whitespace runs to one space → upper-case.
// No punctuation, emoji, check-mark, hyphen or underscore handling. So "Done ✅", "DONE!" and
// "DONE?" are NOT DONE; "  done ", "ＤＯＮＥ" and "DONE<zero-width>" are.
//
// The set is exactly origin/main's DONE names, plus the receiver's aliases:
//   - DONE, PUBLISHED, PUBLISHING — the PUBLISHING keys of origin/main's lib/phase.ts and
//     frontend/src/lib/cards/phase.ts;
//   - DONE/RELEASED, COMPLETED — the n8n receiver's normalize() DONE aliases (isFinishedList on
//     main), which fr must answer "finished" for;
//   - SHIPPED, COMPLETE, RELEASED — plain done synonyms (the cockpit counted SHIP* as DONE).
//
// ⛔ DROPPED and ABANDONED are NOT done-equivalent (a dropped card is not done work) — pinned by
// test.
//
// ⛔ frontend/src/lib/cards/done-equivalent.ts is a BYTE-IDENTICAL copy of everything below the
// SHARED BODY marker (the frontend image is built from frontend/ alone, so it cannot import this
// file). Change both or neither — pinned by frontend/src/lib/cards/done-equivalent.test.ts
// (body bytes, allowlist set equality, and normalizer output over the shared name table).

// ===== SHARED BODY (byte-identical in backend/src/lib + frontend/src/lib/cards) =====

export const DONE_EQUIVALENT_NAMES: ReadonlySet<string> = new Set([
  'DONE',
  'DONE/RELEASED',
  'SHIPPED',
  'PUBLISHED',
  'PUBLISHING',
  'COMPLETED',
  'COMPLETE',
  'RELEASED',
]);

/** The normalized form a list name is compared under (exported for tests). */
export function normalizeListName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function isDoneEquivalentListName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  return DONE_EQUIVALENT_NAMES.has(normalizeListName(name));
}
