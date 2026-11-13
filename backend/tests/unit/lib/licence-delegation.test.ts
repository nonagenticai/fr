import { afterEach, describe, expect, test } from 'bun:test';
import {
  licenceUser,
  resolveDelegatedTenant,
  type LicenceIdentity,
} from '../../../src/lib/licence-introspect';

/**
 * The licence delegation lane (lib/licence-introspect.ts).
 *
 * A licence resolves to ONE tenant. Only a NAMED conveyor subject may act for a
 * different one, and only by naming a well-formed uuid. Everything else must
 * behave byte-identically to before this lane existed — that "no change" half is
 * the part most likely to rot, so it is tested as hard as the positive case.
 */

const HOME = '5f868d42-03f8-51f0-a93c-3e83070dc196';
const CONVEYOR = '01a12af1-c4b7-7453-bc8f-4012dfe39afb';
const OTHER = '01a19140-088b-70c2-9f7a-3ebc610d0f10';

const identity = (over: Partial<LicenceIdentity> = {}): LicenceIdentity => ({
  tenantId: HOME,
  licenseId: 'lic-fr',
  licenceSubjectId: CONVEYOR,
  userId: 'user-1',
  appKey: 'fr',
  planCode: 'standard',
  ...over,
});

const req = (headers: Record<string, string> = {}) =>
  new Request('http://fr.test/api/projects', { headers });

afterEach(() => {
  delete process.env.AUTH_DELEGATING_SUBJECTS;
});

describe('resolveDelegatedTenant — refuses everything it should', () => {
  test('no licence (a user JWT) never delegates', () => {
    process.env.AUTH_DELEGATING_SUBJECTS = CONVEYOR;
    expect(resolveDelegatedTenant(req({ 'X-Tenant-Id': OTHER }), null)).toBeUndefined();
  });

  test('env unset ⇒ nobody delegates, even the conveyor subject', () => {
    expect(resolveDelegatedTenant(req({ 'X-Tenant-Id': OTHER }), identity())).toBeUndefined();
  });

  test('a licence subject NOT in the allowlist is ignored', () => {
    process.env.AUTH_DELEGATING_SUBJECTS = 'someone-else';
    expect(resolveDelegatedTenant(req({ 'X-Tenant-Id': OTHER }), identity())).toBeUndefined();
  });

  test('no delegation header ⇒ own tenant', () => {
    process.env.AUTH_DELEGATING_SUBJECTS = CONVEYOR;
    expect(resolveDelegatedTenant(req(), identity())).toBeUndefined();
  });

  test('a header naming the licence OWN tenant is a no-op, not a delegation', () => {
    process.env.AUTH_DELEGATING_SUBJECTS = CONVEYOR;
    expect(resolveDelegatedTenant(req({ 'X-Tenant-Id': HOME }), identity())).toBeUndefined();
  });

  test('a malformed tenant is refused rather than trusted', () => {
    process.env.AUTH_DELEGATING_SUBJECTS = CONVEYOR;
    for (const bad of ['', '   ', 'not-a-uuid', '01a19140-088b-70c2-9f7a', 'x'.repeat(36)]) {
      expect(resolveDelegatedTenant(req({ 'X-Tenant-Id': bad }), identity())).toBeUndefined();
    }
  });

  test('a licence with no subject id never delegates', () => {
    process.env.AUTH_DELEGATING_SUBJECTS = CONVEYOR;
    const anon = identity({ licenceSubjectId: null });
    expect(resolveDelegatedTenant(req({ 'X-Tenant-Id': OTHER }), anon)).toBeUndefined();
  });
});

describe('resolveDelegatedTenant — the allowlisted conveyor', () => {
  test('honours X-Tenant-Id, the header the n8n fr node emits', () => {
    process.env.AUTH_DELEGATING_SUBJECTS = CONVEYOR;
    expect(resolveDelegatedTenant(req({ 'X-Tenant-Id': OTHER }), identity())).toBe(OTHER);
  });

  test('honours X-Effective-Tenant-Id, the canonical name RM uses', () => {
    process.env.AUTH_DELEGATING_SUBJECTS = CONVEYOR;
    expect(resolveDelegatedTenant(req({ 'X-Effective-Tenant-Id': OTHER }), identity())).toBe(OTHER);
  });

  test('allowlist parsing tolerates spaces, case and several subjects', () => {
    process.env.AUTH_DELEGATING_SUBJECTS = ` other-subject , ${CONVEYOR.toUpperCase()} `;
    expect(resolveDelegatedTenant(req({ 'X-Tenant-Id': OTHER }), identity())).toBe(OTHER);
  });

  test('an empty allowlist entry does not match an empty subject', () => {
    process.env.AUTH_DELEGATING_SUBJECTS = ' , , ';
    expect(
      resolveDelegatedTenant(req({ 'X-Tenant-Id': OTHER }), identity({ licenceSubjectId: '' })),
    ).toBeUndefined();
  });
});

describe('licenceUser — the delegated tenant must reach BOTH scoping fields', () => {
  test('without delegation it is the introspected tenant, unchanged', () => {
    const user = licenceUser(identity());
    expect(user.tenantId).toBe(HOME);
    expect(user.tenantClaim).toBe(HOME);
    expect(user.roles).toEqual([]);
    expect(user.authKind).toBe('licence');
  });

  test('with delegation tenantId AND tenantClaim are the card tenant', () => {
    // project-access.ts derives `licenceTenantId` from tenantId; service-card-tenant.ts
    // compares against tenantClaim. A half-applied delegation would scope writes to
    // one tenant and card checks to another.
    const user = licenceUser(identity(), OTHER);
    expect(user.tenantId).toBe(OTHER);
    expect(user.tenantClaim).toBe(OTHER);
  });

  test('delegation never grants a role — a licence stays member-level', () => {
    const user = licenceUser(identity(), OTHER);
    expect(user.roles).toEqual([]);
    expect(user.authKind).toBe('licence');
    expect(user.licenceSubjectId).toBe(CONVEYOR);
  });
});
