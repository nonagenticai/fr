// frontend/src/lib/cards/done-equivalent.ts
//
// ⛔ MIRRORS backend/src/lib/done-equivalent.ts — the ONE predicate for "this Planka list means
// DONE" (exact normalized allowlist; read that file's header for the WHY). The frontend image is
// built from frontend/ alone, so it cannot import the backend file; everything from the SHARED
// BODY marker down is a BYTE-IDENTICAL copy. Change both or neither — pinned by
// done-equivalent.test.ts beside this file (body bytes, allowlist set equality, and normalizer
// output over the shared name table backend/tests/fixtures/done-equivalent-names.ts).

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
