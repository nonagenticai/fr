// System-asset write gate (frontend mirror of the backend rule).
//
// Product-owner rule 2026-09-30: a customer workspace admin must NOT be able to
// edit or delete ANY system-tenant asset. The backend enforces it — a write that
// resolves to a system-tenant row answers 403 `system_asset_read_only` for
// anyone but a super-admin (`backend/src/routes/assets/_lib/system-union.ts`).
// This helper only keeps the UI from OFFERING what the server will refuse.
//
// `is_system` is stamped on every row the asset list/detail routes return
// (`listWithSystemUnion` / `getWithSystemUnion` → `tag()`), so it is the one
// field to key on. Only a literal `true` locks: an asset type whose route does
// not stamp the flag stays editable, and the backend remains the enforcement.

/** The notice shown in place of the editor's Save / Delete affordances. */
export const SYSTEM_ASSET_READ_ONLY_NOTICE =
  "This is a system asset and can't be edited by workspace admins.";

/** Backend error code for a refused write to a system-tenant asset. */
export const SYSTEM_ASSET_READ_ONLY_CODE = 'system_asset_read_only';

/** True when `item` is a system-tenant asset. */
export function isSystemAsset(item: unknown): boolean {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { is_system?: unknown }).is_system === true
  );
}

/**
 * True when the viewer may NOT edit or delete `item`: it is a system asset and
 * the viewer is not a super-admin.
 */
export function isSystemReadOnly(item: unknown, isSuperAdmin: boolean): boolean {
  return !isSuperAdmin && isSystemAsset(item);
}
