// Repair script: licence the signup app keys (incl. the gate's `fr`) an approved early-access
// signup's tenant is missing.
//
// Why this exists: until 2026-10-20 the signup approve licensed `fr-frontend` (+ the conveyor
// bundle) and never `fr` — the key fr's own gate (src/lib/require-fr-license.ts) requires. The
// approve completed, the set-password email went out, and the person landed on "No active license
// for this workspace". The approve now always licenses `fr`; this repairs signups approved before.
//
// What it does (services/signup/core.ts `ensureSignupLicences`):
//   * refuses unless the signup is `approved` AND its recorded `tenant_id` was FOUNDED by it
//     (`tenant_attempts[tenant_slug].state === 'founded'` with that id) — never another tenant;
//   * refuses (`tenant_mismatch`, exit 1, nothing granted) when the row's tenant disagrees with the
//     provision step's recorded tenant or the identity's `tenant_id` stamp — checked BEFORE any grant;
//   * the app keys are the ones the approve REQUESTED (recorded on `steps.provision.detail`), falling
//     back to the current FR_SIGNUP_APPS only when the row records none — always plus the gate's `fr`;
//   * reads, per signup app key, whether the tenant holds an ACTIVE licence (licences
//     `GET /licenses/active`, the gate's own check);
//   * with --apply, grants ONLY the missing keys to that tenant for the identity the signup minted
//     (provisioning `POST /api/licenses/grant`, the engine's add-a-licence op), aborts if the engine
//     answers a different tenant, drops fr's cached gate answer once any grant landed (even if a later
//     one fails), and records `steps.licence_repair`.
//
// SAFETY: dry-run by DEFAULT — it only reports. Pass --apply to write.
//
// Usage (inside the fr-backend container, which carries DATABASE_URL + the service credentials):
//   bun run scripts/signup-ensure-licences.ts <signupId>
//   bun run scripts/signup-ensure-licences.ts <signupId> --apply

import { closeConnection } from '../src/db/client';
import { redis } from '../src/services/redis';
import { ensureSignupLicences, SignupError } from '../src/services/signup/core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const ids = args.filter((a) => !a.startsWith('--'));
  if (ids.length !== 1 || !UUID_RE.test(ids[0]!)) {
    console.error('Usage: bun run scripts/signup-ensure-licences.ts <signupId> [--apply]');
    return 2;
  }
  const id = ids[0]!;
  console.log(`[signup-ensure-licences] mode: ${apply ? 'APPLY (will grant missing licences)' : 'DRY-RUN (report only)'}`);
  try {
    const r = await ensureSignupLicences(id, { apply });
    console.log(`[signup-ensure-licences] signup=${r.signupId} tenant=${r.tenantId} slug=${r.tenantSlug}`);
    console.log(`[signup-ensure-licences] apps=${r.apps.join(',')} (${r.appsSource}) missing=${r.missing.join(',') || '-'}`);
    if (!r.applied) {
      console.log(r.missing.length ? '[signup-ensure-licences] dry run: re-run with --apply to grant the missing keys' : '[signup-ensure-licences] nothing missing');
      return 0;
    }
    const granted = Object.entries(r.granted).map(([k, v]) => `${k}=${v}`).join(',') || '-';
    console.log(`[signup-ensure-licences] granted=${granted} still_missing=${r.stillMissing.join(',') || '-'} partial=${r.partialFailures.join(',') || '-'}`);
    if (r.cacheInvalidationError) console.error(`[signup-ensure-licences] gate cache NOT invalidated (stale until TTL): ${r.cacheInvalidationError}`);
    return r.stillMissing.length === 0 && r.partialFailures.length === 0 && !r.cacheInvalidationError ? 0 : 1;
  } catch (err) {
    if (err instanceof SignupError) {
      console.error(`[signup-ensure-licences] REFUSED ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

let code = 1;
try {
  code = await main();
} finally {
  await closeConnection();
  await redis.close().catch(() => {});
}
process.exit(code);
