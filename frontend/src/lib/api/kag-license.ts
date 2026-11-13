// KAG add-on license gap — the honest, KAG-SCOPED outcome (coding D3).
//
// The backend package-license gate (server.ts → lib/require-kag-license.ts)
// throws `ForbiddenError('kag_license_required')` — HTTP 403 with body
// `{ error: 'kag_license_required' }` — when the request's tenant lacks the
// `kag` add-on entitlement.
//
// DESIGN CONSTRAINT (why this is its own outcome, not the global gate):
//   `licenseGate` (stores/licenseGate.svelte.ts) is the fr-LICENSE hard block
//   for the WHOLE app — when it trips, the root layout blanks the entire fr UI
//   behind a renewal screen. A missing KAG *add-on* is a much smaller thing: it
//   only means the knowledge (KAG) surface is unavailable. Routing
//   `kag_license_required` through `licenseGate.handleForbidden()` would wrongly
//   black out all of fr for a KAG-only entitlement gap.
//
// So both API layers recognise this code and surface it as a distinct, honest,
// KAG-scoped result (a `kagLicenseRequired` flag + a human message the KAG tabs
// already render inline via `err.message`), and NEVER touch `licenseGate`.
export const KAG_LICENSE_REQUIRED_CODE = 'kag_license_required';

export const KAG_LICENSE_REQUIRED_MESSAGE =
  'This workspace needs a KAG license to use knowledge features.';
