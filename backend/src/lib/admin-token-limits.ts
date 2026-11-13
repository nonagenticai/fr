// src/lib/admin-token-limits.ts
//
// The licences token-mint bounds fr applies, moved verbatim out of
// services/licenses.ts (fr-agui P4c part 3) so the super-admin mint-token body
// schema (routes/admin/licenses-admin-schemas.ts) and its capability declaration
// share them without importing a module that reads config. Side-effect free.

/** Token types the licenses service accepts (upstream `TokenType` enum). */
export const ADMIN_TOKEN_TYPES = ['api', 'node', 'internal'] as const;
export type AdminTokenType = (typeof ADMIN_TOKEN_TYPES)[number];

/**
 * Expiry applied when the caller names none. Upstream's own default for an
 * omitted `expires_days` is PERPETUAL (valid until revoked), so fr never omits
 * it: a token minted through the console is always bounded (fr#1372).
 */
export const DEFAULT_ADMIN_TOKEN_EXPIRES_DAYS = 365;
/** Upper bound fr will request; upstream only enforces `>= 1`. */
export const MAX_ADMIN_TOKEN_EXPIRES_DAYS = 3650;
