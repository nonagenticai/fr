# License-state pattern (enforcement + expired/expiring UX)

How fr surfaces license validity in the browser, and how to port it to the
other frontends. The **backend is the real enforcer** — every license-gated
route 403s `fr_license_required` when the workspace has no active license. This
pattern makes the SPA render an accurate experience on top of that instead of a
broken shell or raw error toasts.

## Contract: `GET /api/license/status` (per-app, gate-exempt)
fr-backend (`src/server.ts` + `src/lib/license-status.ts`) returns:
```json
{ "appKey":"fr", "gateEnabled":true, "hasLicense":false,
  "state":"expired", "expiresAt":"2026-06-01T00:00:00Z",
  "daysRemaining":-23, "planCode":"standard" }
```
`state ∈ active | expiring_soon | expired | revoked | none | unknown`.
- Derived from the licenses service: `GET /licenses/active` (200 ⇒ active, with
  `expires_at`; 404 ⇒ not active) then the subject inventory
  (`/licenses/user/{sub}`) to tell `expired` / `revoked` / `none` apart.
- `expiring_soon` is computed server-side at ≤30 days.
- **Fail-soft:** any upstream error ⇒ `state:"unknown"` (NOT blocking). The
  per-request 403 is the real-time enforcer, so a licenses blip can't lock out
  an entitled user.
- `hasLicense`/`hasFrLicense`/`hasKagLicense` kept for back-compat.

## The four moving parts (fr)
1. **`src/lib/stores/licenseGate.svelte.ts`** — the single authoritative store
   (the ONLY license model in the app). Polls `/api/license/status` (loaded
   reactively the moment auth flips authenticated + 15-min interval + on tab
   focus). Exposes `state`, `expiresAt`, `daysRemaining`, `planCode`, `isValid`
   (`active|expiring_soon|unknown` — fail-soft so a blip never shows "invalid"),
   `isExpiringSoon`, `isBlocked` (`expired|revoked|none` OR a live 403),
   `statusMessage`, `load()`, `refresh()`, `handleForbidden()`. Also exports
   `navigateToRenew()` — the one renewal-navigation helper every "Renew" CTA
   calls (handles absolute + protocol-relative URLs).
2. **403 interceptor** — `src/lib/api/unified-client.ts`: on `403` with body
   `error === 'fr_license_required'`, call `licenseGate.handleForbidden()` so a
   mid-session expiry blocks immediately (status/me endpoints are gate-exempt,
   so no loop). Distinguish the license 403 from any *other* 403 (a normal authz
   403 must NOT trigger the full-screen block).
3. **Root gate** — `src/routes/+layout.svelte`: when authenticated and
   `licenseGate.isBlocked` (and NOT on the renew route), render
   `<LicenseBlocked>` instead of the app shell — for BOTH products. Otherwise
   render the shell with `<LicenseExpiringBanner>` on top when
   `isExpiringSoon`. The KagShell badge + dashboard license card read THIS store
   (not any separate model).
4. **UI** — `src/lib/components/LicenseBlocked.svelte` (full-screen: Renew +
   Log out) and `LicenseExpiringBanner.svelte` (dismissible). Both Renew CTAs
   call `navigateToRenew()`.

## Renewal CTA knob
`VITE_LICENSE_RENEW_URL` (read in `licenseGate.svelte.ts` as `LICENSE_RENEW_URL`).
- Default: in-app `/license-upgrade` (an honest "contact sales" page — there is
  no self-serve purchase yet).
- When the customer portal e-commerce ships, set `VITE_LICENSE_RENEW_URL` to the
  portal URL — absolute URLs trigger a full redirect; one change ports renewals
  out of every app and applies to n8n nodes too.

## Porting to other frontends
- **commonpractice** (`commonpractice/frontend`, SvelteKit) — FIRST port (in
  progress). Its backend ALREADY enforces (Gate 2, `middleware/license-gate.ts`,
  default-OFF via `config.license.enforceGate2`) but via license-token
  **introspection**, and it returns **402** codes (`license_required |
  license_inactive | license_expired | license_unavailable`), NOT fr's 403
  `fr_license_required`. So the port: add a gate-exempt `GET /api/license/status`
  (derive state from the tenant's introspect), copy the store + 2 components +
  root-layout gate, and key the interceptor on **402** (not 403). Introspect
  can't tell `revoked` from `expired`/`none` (no inventory), so cp's states are a
  subset (active/expiring_soon/expired/none/unknown).
- **w2v** (`w2v/w2v_frontend`, SvelteKit) — has NO app key in the licenses seed
  and no backend license endpoint yet; seed the `w2v` app first, then port.
- **kanban/planka** (`planka-private/client`, React) — only seeded as an n8n
  *module*, not a standalone per-tenant product. Needs an architectural decision
  (per-customer licensed vs. fr-internal) BEFORE any gate, then a React port.
- General rule: confirm each product's licensing model AND its gate's error
  shape (status code + body) before wiring the interceptor.

## Not covered here (separate concerns)
- Feature/tier entitlement (per-feature/per-tier gating) — a different axis from
  expiry. fr's fictional free/pro/enterprise tier scaffolding
  (`LicenseProtectedFeature`, `guards/license-guard.ts`) and the broken legacy
  license model (`stores/license.svelte.ts`, `services/license.ts`,
  `components/LicenseStatus.svelte`, the `auth.license`/`getUserLicense` path)
  were REMOVED — `licenseGate` is now the single model. A real (non-fictional)
  entitlement axis, if needed later, should be built fresh on real plan data.
