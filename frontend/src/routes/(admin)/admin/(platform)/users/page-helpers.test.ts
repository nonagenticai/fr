// page-helpers.test.ts
//
// The honesty contract for the provision-result panel. Since fr was repointed
// onto the provisioning engine, `temporary_password: null` is a REAL state on
// two paths, and the UI must name which one and what to do about it — never
// render a blank credential.

import { describe, it, expect } from 'vitest';
import type { AdminUser, AdminUserWorkspace } from '$lib/api/super-admin';
import type { AppRecord, PlanRecord, TenantRecord } from '$lib/api/licenses-admin';
import { shortId } from '$lib/utils/shortId';
import {
  additionalSeatsPayload,
  appByKey,
  appPlansPayload,
  canUntickApp,
  defaultPersonApps,
  FR_PERSON_APPS,
  frPersonApps,
  asWorkspaceRole,
  credentialState,
  customPlanRequest,
  existingTenantOptions,
  isTenantId,
  mergeTenants,
  danglingCount,
  describeGrantOutcome,
  describeRevokeOutcome,
  describeRoleRevoke,
  describeSeatOutcome,
  emptyCustomPlanDraft,
  filterAdminUsers,
  holdsGrant,
  isSeedArtifact,
  looksLikeEmail,
  MAX_ADDITIONAL_SEATS,
  noTokensMessage,
  personLabel,
  planChoicesForUnselectedApps,
  planPickerEmptyLabel,
  planPickerOptions,
  prunePlanChoices,
  roleOptions,
  seatCountProblem,
  seatCredentialState,
  seatProblemMessage,
  seatStatusHeadline,
  seatStatusTone,
  seatTokensMessage,
  seatsBlockSubmit,
  seedArtifactCount,
  SEED_USER_ID,
  tallySeats,
  unresolvedBadge,
  unresolvedLabel,
  validateSeatRows,
  workspaceLabel,
  type CustomPlanDraft,
  type SeatResultView,
} from './page-helpers';

const fresh = {
  temporary_password: 'engine-minted-pw',
  already_existed: false,
  replayed: false,
  magic_link_sent: true,
  tokens: { 'fr-frontend': 'tok-1' },
  license_ids: { 'fr-frontend': 'lic-1' },
};

describe('credentialState', () => {
  it('shows the password when the engine actually minted one', () => {
    const state = credentialState(fresh);
    expect(state.kind).toBe('password');
    expect(state).toEqual({ kind: 'password', password: 'engine-minted-pw' });
  });

  it('null on an already-existing account → explains the password was NOT rotated', () => {
    const state = credentialState({
      ...fresh,
      temporary_password: null,
      already_existed: true,
      replayed: false,
      magic_link_sent: true,
    });
    expect(state.kind).toBe('none');
    if (state.kind !== 'none') throw new Error('unreachable');
    expect(state.reason).toMatch(/already existed/i);
    expect(state.reason).toMatch(/not rotated/i);
    // The recovery path is stated, not left to the operator to guess.
    expect(state.recovery).toMatch(/set-your-password link/i);
  });

  it('null on a replay → says the secret was issued on the original call', () => {
    const state = credentialState({
      ...fresh,
      temporary_password: null,
      already_existed: true,
      replayed: true,
      magic_link_sent: false,
    });
    expect(state.kind).toBe('none');
    if (state.kind !== 'none') throw new Error('unreachable');
    expect(state.reason).toMatch(/replayed/i);
    expect(state.reason).toMatch(/not re-fetchable/i);
    // No magic link was sent, so the recovery text must not claim one was.
    expect(state.recovery).not.toMatch(/has been emailed/i);
    expect(state.recovery).toMatch(/password-reset from Keycloak/i);
  });

  it('an EMPTY-STRING password is never rendered as a credential', () => {
    // Defence-in-depth against the exact bug this replaced: a `?? ''` anywhere
    // upstream must still not produce a blank credential box that reads as
    // "here is the password".
    const state = credentialState({
      ...fresh,
      temporary_password: '',
      already_existed: true,
    });
    expect(state.kind).toBe('none');
  });
});

describe('noTokensMessage', () => {
  it('returns null when there ARE tokens to render', () => {
    expect(noTokensMessage(fresh)).toBeNull();
  });

  it('explains a known license whose one-time token cannot be re-read', () => {
    const msg = noTokensMessage({
      ...fresh,
      tokens: {},
      license_ids: { 'fr-frontend': 'lic-1' },
    });
    expect(msg).toMatch(/already existed/i);
    expect(msg).toMatch(/cannot be re-read/i);
    // Singular for one license.
    expect(msg).toMatch(/The license below/);
  });

  it('pluralises for multiple licenses', () => {
    const msg = noTokensMessage({
      ...fresh,
      tokens: {},
      license_ids: { 'fr-frontend': 'lic-1', 'w2v-frontend': 'lic-2' },
    });
    expect(msg).toMatch(/The licenses below/);
  });

  it('says so plainly when NO license was minted at all', () => {
    const msg = noTokensMessage({ ...fresh, tokens: {}, license_ids: {} });
    expect(msg).toMatch(/No licenses were minted/i);
  });
});

// ---------------------------------------------------------------------------
// Access list — grant/revoke derivations.
// ---------------------------------------------------------------------------

const ws = (
  tenant_id: string,
  role: string,
  tenant_name: string | null = null,
): AdminUserWorkspace => ({
  tenant_id,
  tenant_name,
  role,
  granted_at: '2026-08-01T00:00:00Z',
  granted_by: null,
});

const user = (over: Partial<AdminUser> = {}): AdminUser => ({
  user_id: 'u-1',
  email: 'alice@example.com',
  name: 'Alice Example',
  resolved: true,
  workspaces: [ws('t-1', 'workspace-admin', 'Acme')],
  ...over,
});

describe('asWorkspaceRole', () => {
  it('accepts exactly the two roles the API takes', () => {
    expect(asWorkspaceRole('workspace-admin')).toBe('workspace-admin');
    expect(asWorkspaceRole('workspace-member')).toBe('workspace-member');
    expect(roleOptions.map((o) => o.value)).toEqual([
      'workspace-admin',
      'workspace-member',
    ]);
  });

  it('refuses a legacy stored role instead of sending it for a 422', () => {
    // `user_roles.role` is a free string that predates this endpoint's enum.
    expect(asWorkspaceRole('admin')).toBeNull();
    expect(asWorkspaceRole('owner')).toBeNull();
    expect(asWorkspaceRole('')).toBeNull();
  });
});

describe('personLabel / workspaceLabel', () => {
  it('falls back through email → name → id, never rendering blank', () => {
    expect(personLabel(user())).toBe('alice@example.com');
    expect(personLabel(user({ email: null }))).toBe('Alice Example');
    expect(personLabel(user({ email: null, name: null }))).toBe('u-1');
  });

  it('shows the tenant id when the name did not resolve', () => {
    expect(workspaceLabel(ws('t-9', 'workspace-member'))).toBe('t-9');
    expect(workspaceLabel(ws('t-9', 'workspace-member', 'Acme'))).toBe('Acme');
  });

  // 10 of the 14 live grants point at an id Keycloak 404s on. None of them may
  // render a raw UUID where a person's name goes.
  it('never renders a full user id for an UNRESOLVED grant', () => {
    const gone = user({
      user_id: '3f6a1c22-9b4e-4d71-8a0e-2c5d7e9f1b33',
      email: null,
      name: null,
      resolved: false,
    });
    const label = personLabel(gone);
    expect(label).not.toContain('3f6a1c22-9b4e-4d71-8a0e-2c5d7e9f1b33');
    // ⚠️ CHANGED ON PURPOSE, same reason as the `shortId` case below — this was
    // a FIFTH site pinning the leading-8 algorithm fr#1203 refuted (52 apps
    // collapsed onto 27 distinct leading-8 values, 13 of them all rendering
    // `06954722…`, versus 52 distinct trailing-8). It is caught here rather
    // than by review only because the suite was actually executed.
    expect(label).toBe('Deleted account · …7e9f1b33');
    // And the leading-8 must NOT survive anywhere in the label, or the two
    // algorithms would be rendering side by side.
    expect(label).not.toContain('3f6a1c22');
  });

  it('calls the AUTH_BYPASS placeholder seed data, not a deleted person', () => {
    const seed = user({ user_id: SEED_USER_ID, email: null, name: null, resolved: false });
    expect(personLabel(seed)).toBe('Seed artifact (dev placeholder)');
    expect(personLabel(seed)).not.toContain(SEED_USER_ID);
    expect(personLabel(seed)).not.toMatch(/deleted/i);
  });

  it('still prefers a stored email/name over the deleted-account label', () => {
    const gone = user({ resolved: false });
    expect(personLabel(gone)).toBe('alice@example.com');
  });

  it('leaves a RESOLVED row on the plain id fallback', () => {
    // `resolved === false` is the trigger, not "falsy": a caller that carries
    // no flag is not claiming the directory failed.
    expect(personLabel({ user_id: 'u-1', email: null, name: null })).toBe('u-1');
    expect(personLabel(user({ email: null, name: null }))).toBe('u-1');
  });
});

describe('unresolvedBadge / short id / isSeedArtifact', () => {
  it('names the kind of row, replacing "unknown to directory"', () => {
    expect(unresolvedBadge('3f6a1c22-9b4e-4d71-8a0e-2c5d7e9f1b33')).toBe('account deleted');
    expect(unresolvedBadge(SEED_USER_ID)).toBe('seed data');
  });

  it('shortens to the TAIL 8 chars and recognises only the exact nil UUID', () => {
    // ⚠️ THIS EXPECTATION CHANGED ON PURPOSE — it is not a regression.
    // It read `.toBe('3f6a1c22')`, i.e. it PINNED the leading-8 algorithm that
    // fr#1203 refuted: our ids are UUIDv7-shaped, so rows provisioned in one
    // batch necessarily share their leading characters. Measured live in
    // `licenses`, 52 apps collapsed onto 27 distinct leading-8 values (13 of
    // them all rendering `06954722…`) versus 52 distinct trailing-8. fr#1205
    // retired this page's private `shortUserId` onto the shared `shortId`,
    // which takes the tail and leads with the ellipsis.
    expect(shortId('3f6a1c22-9b4e-4d71-8a0e-2c5d7e9f1b33')).toBe('…7e9f1b33');
    // ...and that stub is what the rendered label actually carries.
    expect(unresolvedLabel('3f6a1c22-9b4e-4d71-8a0e-2c5d7e9f1b33')).toBe(
      'Deleted account · …7e9f1b33',
    );
    expect(isSeedArtifact(SEED_USER_ID)).toBe(true);
    // A different all-zero-PREFIX id is a real bootstrap-namespace subject.
    expect(isSeedArtifact('00000000-0000-0000-0000-000000000001')).toBe(false);
  });
});

describe('seedArtifactCount', () => {
  it('counts only the AUTH_BYPASS placeholder rows', () => {
    const rows = [
      user(),
      user({ user_id: SEED_USER_ID, resolved: false }),
      user({ user_id: 'u-3', resolved: false }),
    ];
    expect(seedArtifactCount(rows)).toBe(1);
    expect(danglingCount(rows)).toBe(2);
    expect(seedArtifactCount([])).toBe(0);
  });
});

describe('filterAdminUsers', () => {
  const people = [
    user(),
    user({ user_id: 'u-2', email: 'bob@other.test', name: 'Bob', workspaces: [ws('t-2', 'workspace-member', 'Globex')] }),
  ];

  it('returns everyone for an empty or whitespace query', () => {
    expect(filterAdminUsers(people, '')).toHaveLength(2);
    expect(filterAdminUsers(people, '   ')).toHaveLength(2);
  });

  it('matches on email, name, user id and granted tenant name', () => {
    expect(filterAdminUsers(people, 'BOB').map((u) => u.user_id)).toEqual(['u-2']);
    expect(filterAdminUsers(people, 'alice@').map((u) => u.user_id)).toEqual(['u-1']);
    expect(filterAdminUsers(people, 'u-2').map((u) => u.user_id)).toEqual(['u-2']);
    expect(filterAdminUsers(people, 'globex').map((u) => u.user_id)).toEqual(['u-2']);
  });

  it('does not crash on a null email/name', () => {
    const anon = user({ user_id: 'u-3', email: null, name: null, workspaces: [] });
    expect(filterAdminUsers([anon], 'u-3')).toHaveLength(1);
    expect(filterAdminUsers([anon], 'alice')).toHaveLength(0);
  });
});

describe('danglingCount', () => {
  it('counts only users the directory could not resolve', () => {
    expect(danglingCount([user(), user({ user_id: 'u-2', resolved: false })])).toBe(1);
    expect(danglingCount([])).toBe(0);
  });
});

describe('holdsGrant', () => {
  it('matches on the (tenant, role) PAIR, not the tenant alone', () => {
    const u = user({ workspaces: [ws('t-1', 'workspace-admin')] });
    expect(holdsGrant(u, 't-1', 'workspace-admin')).toBe(true);
    // Same tenant, other role — this grant would be a real new row.
    expect(holdsGrant(u, 't-1', 'workspace-member')).toBe(false);
    expect(holdsGrant(u, 't-2', 'workspace-admin')).toBe(false);
  });
});

describe('describeRoleRevoke', () => {
  it('names the person, the role and the tenant, not "are you sure?"', () => {
    const copy = describeRoleRevoke(user(), ws('t-1', 'workspace-admin', 'Acme'));
    expect(copy).toContain('alice@example.com');
    expect(copy).toContain('workspace-admin');
    expect(copy).toContain('Acme');
  });

  it('warns that a sole grant leaves the person with NO access to fr', () => {
    const copy = describeRoleRevoke(user(), ws('t-1', 'workspace-admin', 'Acme'));
    expect(copy).toMatch(/only grant/i);
    expect(copy).toMatch(/no access to fr at all/i);
  });

  it('does NOT claim they lose the workspace when a sibling role remains', () => {
    // Two rows in ONE tenant: removing one leaves the other standing, so
    // "they lose access to that workspace" would be false.
    const u = user({
      workspaces: [ws('t-1', 'workspace-admin', 'Acme'), ws('t-1', 'workspace-member', 'Acme')],
    });
    const copy = describeRoleRevoke(u, ws('t-1', 'workspace-admin', 'Acme'));
    expect(copy).toMatch(/keep workspace-member in that workspace/);
    expect(copy).toMatch(/do not lose access to it/);
    expect(copy).not.toMatch(/only grant/i);
  });

  it('counts the grants elsewhere rather than implying total loss', () => {
    const u = user({
      workspaces: [
        ws('t-1', 'workspace-admin', 'Acme'),
        ws('t-2', 'workspace-member', 'Globex'),
        ws('t-3', 'workspace-member', 'Initech'),
      ],
    });
    const copy = describeRoleRevoke(u, ws('t-1', 'workspace-admin', 'Acme'));
    expect(copy).toMatch(/keep 2 other grants/);
    expect(copy).not.toMatch(/no access to fr/i);
  });

  it('singularises one remaining grant', () => {
    const u = user({
      workspaces: [ws('t-1', 'workspace-admin', 'Acme'), ws('t-2', 'workspace-member', 'Globex')],
    });
    expect(describeRoleRevoke(u, ws('t-1', 'workspace-admin', 'Acme'))).toMatch(
      /keep 1 other grant\b/,
    );
  });

  it('calls out a dangling grant instead of claiming a person loses access', () => {
    const u = user({ resolved: false, email: null, name: null });
    const copy = describeRoleRevoke(u, ws('t-1', 'workspace-admin', 'Acme'));
    expect(copy).toMatch(/directory does not know/i);
    expect(copy).toMatch(/dangling grant/i);
    // The id is the only handle there is; it must still appear.
    expect(copy).toContain('u-1');
  });

  it('does not call the seed row an account the directory does not know', () => {
    // There is no account and never was, so that sentence would be false and
    // would have the operator hesitate over a row that costs nothing to clear.
    // The live row: one grant, role 'admin', subject the nil UUID.
    const u = user({
      user_id: SEED_USER_ID,
      email: null,
      name: null,
      resolved: false,
      workspaces: [ws('t-1', 'admin', 'Acme')],
    });
    const copy = describeRoleRevoke(u, ws('t-1', 'admin', 'Acme'));
    expect(copy).toMatch(/no person loses access/i);
    expect(copy).toMatch(/seed data/i);
    expect(copy).not.toMatch(/directory does not know/i);
    expect(copy).not.toMatch(/no access to fr at all/i);
  });
});

describe('describeGrantOutcome', () => {
  it('reports a 201 as an actual grant', () => {
    const msg = describeGrantOutcome(
      { created: true, role: 'workspace-admin', tenant_lookup_error: null },
      'alice',
      'Acme',
    );
    expect(msg).toMatch(/^Granted workspace-admin to alice/);
  });

  it('does not claim a 200 changed anything', () => {
    // A 200 is a success status for a call that wrote nothing.
    const msg = describeGrantOutcome(
      { created: false, role: 'workspace-admin', tenant_lookup_error: null },
      'alice',
      'Acme',
    );
    expect(msg).toMatch(/already had/i);
    expect(msg).toMatch(/nothing changed/i);
    expect(msg).not.toMatch(/^Granted/);
  });

  it('a tenant-name lookup failure is reported AFTER the success, not instead of it', () => {
    // The grant is written; only the display name is missing. Leading with the
    // failure would read as "access was not granted", which is the opposite of
    // what happened — and saying nothing leaves a blank workspace in the list
    // with no explanation.
    const msg = describeGrantOutcome(
      { created: true, role: 'workspace-admin', tenant_lookup_error: 'licences unreachable' },
      'alice',
      'Acme',
    );
    expect(msg).toMatch(/^Granted workspace-admin to alice/);
    expect(msg).toMatch(/licences unreachable/);
    expect(msg).toMatch(/may show as blank/i);
  });
});

describe('describeRevokeOutcome', () => {
  it('confirms a 204 removal', () => {
    const msg = describeRevokeOutcome({ removed: true, detail: '' }, 'alice', 'Acme', 'workspace-admin');
    expect(msg).toMatch(/^Revoked workspace-admin from alice/);
  });

  it('a 404 says nothing was revoked and carries the backend reason', () => {
    // 404 also fires for an unknown user id, so this must not assert
    // "already revoked" — that would hide a live grant behind a success line.
    const msg = describeRevokeOutcome(
      { removed: false, detail: 'user not found' },
      'alice',
      'Acme',
      'workspace-admin',
    );
    expect(msg).toMatch(/Nothing was revoked/);
    expect(msg).toContain('user not found');
    expect(msg).not.toMatch(/already revoked/i);
  });

  it('omits the parenthetical when the backend gave no reason', () => {
    const msg = describeRevokeOutcome({ removed: false, detail: '' }, 'alice', 'Acme', 'workspace-member');
    expect(msg).toMatch(/Nothing was revoked/);
    expect(msg).not.toContain('()');
  });
});

// ===========================================================================
// Per-app plan selection — the app → plan cascade.
// ===========================================================================

const app = (key: string, over: Partial<AppRecord> = {}): AppRecord => ({
  id: `app-${key}`,
  key,
  name: key,
  description: null,
  revoked: false,
  audience: 'human',
  created_at: '2026-08-01T00:00:00Z',
  ...over,
});

const plan = (over: Partial<PlanRecord> = {}): PlanRecord => ({
  id: 'plan-1',
  app_id: 'app-fr-frontend',
  code: 'standard',
  name: 'Standard',
  description: null,
  region_id: null,
  duration_days: 30,
  rate_limit_rpm: 60,
  rate_limit_burst: null,
  quota_monthly: 1000,
  token_budget_monthly: null,
  revoked: false,
  created_at: '2026-08-01T00:00:00Z',
  ...over,
});

const CATALOG = [app('fr-frontend'), app('w2v-frontend')];

describe('appByKey', () => {
  it('crosses the key → id boundary the plan endpoints need', () => {
    expect(appByKey(CATALOG, 'w2v-frontend')?.id).toBe('app-w2v-frontend');
  });

  it('returns null rather than throwing for a key the catalogue does not hold', () => {
    // Reachable for real: the catalogue read failed and the form fell back to
    // DEFAULT_APP_KEY, or the app was revoked between loads. The picker must
    // degrade, not crash the whole provisioning form.
    expect(appByKey(CATALOG, 'nope')).toBeNull();
    expect(appByKey([], 'fr-frontend')).toBeNull();
  });
});

describe('planPickerOptions', () => {
  it('offers one app’s live plans once they are loaded', () => {
    const opts = planPickerOptions({
      kind: 'ready',
      plans: [plan({ id: 'p-1', code: 'standard' }), plan({ id: 'p-2', code: 'pro' })],
    });
    expect(opts.map((o) => o.value)).toEqual(['p-1', 'p-2']);
    expect(opts[0].label).toContain('standard');
  });

  it('inherits the sibling’s revoked filter instead of re-deciding it', () => {
    // The whole point of reusing `planOptions`: `selectablePlans` already says a
    // revoked plan is not grantable. A second filter here would be a second
    // thing to drift from it.
    const opts = planPickerOptions({
      kind: 'ready',
      plans: [plan({ id: 'p-1' }), plan({ id: 'p-dead', code: 'legacy', revoked: true })],
    });
    expect(opts.map((o) => o.value)).toEqual(['p-1']);
  });

  it('offers NOTHING before a load, during one, or after a failed one', () => {
    expect(planPickerOptions({ kind: 'idle' })).toEqual([]);
    expect(planPickerOptions({ kind: 'loading' })).toEqual([]);
    // Not a stale list: a picker offering the previous read after a failed
    // refresh lets the operator select a plan that may no longer exist.
    expect(planPickerOptions({ kind: 'error', message: 'licences 503' })).toEqual([]);
  });
});

describe('planPickerEmptyLabel', () => {
  it('says UNSET keeps the backend default — never "Select a plan…"', () => {
    // The field is OPTIONAL. "Select a plan…" would read as required and push
    // the operator into a choice the backend does not need from them.
    const label = planPickerEmptyLabel({ kind: 'ready', plans: [plan()] });
    expect(label).toMatch(/default/i);
    expect(label).not.toMatch(/select a plan/i);
  });

  it('does NOT promise a default when the app has no live plan', () => {
    // There is no first live plan to fall back to, so provisioning that app
    // WILL abort partway through (provisioning is not transactional). Repeating
    // the reassurance here would send the operator to submit a doomed run.
    const label = planPickerEmptyLabel({ kind: 'ready', plans: [] });
    expect(label).toMatch(/FAIL/);
    expect(label).not.toMatch(/backend picks/i);
  });

  it('treats an all-revoked list as no live plan, not as a loadable one', () => {
    expect(planPickerEmptyLabel({ kind: 'ready', plans: [plan({ revoked: true })] })).toMatch(
      /FAIL/,
    );
  });

  it('distinguishes a FAILED read from an empty one and carries the reason', () => {
    const label = planPickerEmptyLabel({ kind: 'error', message: 'licences 503' });
    expect(label).toContain('licences 503');
    // A failed read is not "no plans" — it must not claim the app is unusable.
    expect(label).not.toMatch(/FAIL/);
    expect(planPickerEmptyLabel({ kind: 'loading' })).toMatch(/loading/i);
    expect(planPickerEmptyLabel({ kind: 'idle' })).toMatch(/not loaded/i);
  });
});

describe('prunePlanChoices / planChoicesForUnselectedApps', () => {
  it('drops the choice for an app that was just unticked', () => {
    expect(prunePlanChoices(['fr-frontend'], { 'fr-frontend': 'p-1', 'w2v-frontend': 'p-2' })).toEqual(
      { 'fr-frontend': 'p-1' },
    );
  });

  it('treats an empty plan id as no choice at all', () => {
    expect(prunePlanChoices(['fr-frontend'], { 'fr-frontend': '' })).toEqual({});
  });

  it('NAMES a plan chosen for an unselected app rather than dropping it silently', () => {
    // The invalid state. `prunePlanChoices` makes it unreachable through the UI,
    // which is exactly why it is still detected: a detector that can only ever
    // read zero is how a regression in the prune ships unnoticed. Dropping the
    // entry quietly would provision a DIFFERENT plan from the one last shown.
    expect(
      planChoicesForUnselectedApps(['fr-frontend'], {
        'fr-frontend': 'p-1',
        'w2v-frontend': 'p-2',
        'kag-frontend': 'p-3',
      }),
    ).toEqual(['kag-frontend', 'w2v-frontend']);
  });

  it('is empty for a coherent selection, and for an empty choice map', () => {
    expect(planChoicesForUnselectedApps(['fr-frontend'], { 'fr-frontend': 'p-1' })).toEqual([]);
    expect(planChoicesForUnselectedApps([], {})).toEqual([]);
    // An unselected app with a BLANK choice is not a conflict.
    expect(planChoicesForUnselectedApps([], { 'w2v-frontend': '' })).toEqual([]);
  });
});

describe('appPlansPayload', () => {
  it('OMITS the field rather than sending an empty map', () => {
    // `{}` is a present, explicit, empty plan map; omitting the field is "I am
    // not choosing plans, keep your existing behaviour". The backend's optional
    // field exists so the second statement stays expressible.
    expect(appPlansPayload(['fr-frontend'], {})).toBeUndefined();
    expect(appPlansPayload(['fr-frontend'], { 'fr-frontend': '' })).toBeUndefined();
  });

  it('sends only the chosen plans for the selected apps', () => {
    expect(
      appPlansPayload(['fr-frontend', 'w2v-frontend'], {
        'fr-frontend': 'p-1',
        'kag-frontend': 'p-9',
      }),
    ).toEqual({ 'fr-frontend': 'p-1' });
  });
});

// ===========================================================================
// Create custom plan → POST /api/admin/licenses/plans
// ===========================================================================

const draft = (over: Partial<CustomPlanDraft> = {}): CustomPlanDraft => ({
  ...emptyCustomPlanDraft(),
  code: 'acme-custom',
  name: 'Acme custom',
  ...over,
});

describe('customPlanRequest', () => {
  it('builds exactly the keys CreatePlanBody accepts', () => {
    // The upstream schema is `.strict()`, so an extra key is a 422.
    const req = customPlanRequest('app-fr-frontend', draft({ quota_monthly: '5000', duration_days: '30' }));
    expect(req.ok).toBe(true);
    if (!req.ok) throw new Error('unreachable');
    expect(Object.keys(req.body).sort()).toEqual([
      'app_id',
      'code',
      'duration_days',
      'name',
      'quota_monthly',
      'rate_limit_burst',
      'rate_limit_rpm',
      'token_budget_monthly',
    ]);
    expect(req.body.app_id).toBe('app-fr-frontend');
    expect(req.body.quota_monthly).toBe(5000);
    expect(req.body.duration_days).toBe(30);
  });

  it('maps a BLANK limit to null, never to 0', () => {
    // `Number('') === 0`, and a plan with `quota_monthly: 0` is not unlimited —
    // it denies every request. This is the same claim `planLabel` makes on the
    // licences side by refusing to render null as "0".
    const req = customPlanRequest('app-1', draft());
    if (!req.ok) throw new Error('unreachable');
    expect(req.body.quota_monthly).toBeNull();
    expect(req.body.token_budget_monthly).toBeNull();
    expect(req.body.rate_limit_rpm).toBeNull();
    expect(req.body.rate_limit_burst).toBeNull();
    expect(req.body.duration_days).toBeNull();
  });

  it('keeps an EXPLICIT zero, which is a real (deny-everything) limit', () => {
    const req = customPlanRequest('app-1', draft({ quota_monthly: '0' }));
    if (!req.ok) throw new Error('unreachable');
    expect(req.body.quota_monthly).toBe(0);
  });

  it('refuses before the round trip when the app is unresolved', () => {
    const req = customPlanRequest(null, draft());
    expect(req).toEqual({ ok: false, problem: expect.stringMatching(/app/i) });
  });

  it('requires a code and a name', () => {
    expect(customPlanRequest('app-1', draft({ code: '   ' })).ok).toBe(false);
    expect(customPlanRequest('app-1', draft({ name: '' })).ok).toBe(false);
    expect(customPlanRequest('app-1', draft({ code: 'x'.repeat(65) })).ok).toBe(false);
  });

  it('mirrors the upstream floors: duration_days is positive, limits are non-negative', () => {
    // `duration_days: z.number().int().positive()` — 0 is a 422 there, and the
    // blank field is how you ask for a perpetual plan.
    const zeroDuration = customPlanRequest('app-1', draft({ duration_days: '0' }));
    expect(zeroDuration.ok).toBe(false);
    if (zeroDuration.ok) throw new Error('unreachable');
    expect(zeroDuration.problem).toMatch(/blank for a perpetual plan/i);

    expect(customPlanRequest('app-1', draft({ rate_limit_rpm: '-1' })).ok).toBe(false);
    expect(customPlanRequest('app-1', draft({ quota_monthly: '1.5' })).ok).toBe(false);
    expect(customPlanRequest('app-1', draft({ quota_monthly: 'lots' })).ok).toBe(false);
  });

  it('trims the code and name it sends', () => {
    const req = customPlanRequest('app-1', draft({ code: '  acme  ', name: '  Acme  ' }));
    if (!req.ok) throw new Error('unreachable');
    expect(req.body.code).toBe('acme');
    expect(req.body.name).toBe('Acme');
  });
});

// ===========================================================================
// Seats. ⛔ No seat COUNT is validated anywhere — there is no count field, by
// design: a seat is a licence row held by a named person and the count is
// derived from those rows (see the block comment in page-helpers.ts).
// ===========================================================================

const seat = (email: string, name = 'Somebody') => ({ email, name });

describe('looksLikeEmail', () => {
  it('accepts ordinary addresses and rejects obvious typos', () => {
    expect(looksLikeEmail('bob@example.com')).toBe(true);
    expect(looksLikeEmail('  bob+tag@sub.example.co.uk ')).toBe(true);
    expect(looksLikeEmail('bob')).toBe(false);
    expect(looksLikeEmail('bob@localhost')).toBe(false);
    expect(looksLikeEmail('bob @example.com')).toBe(false);
    expect(looksLikeEmail('@example.com')).toBe(false);
  });
});

describe('validateSeatRows', () => {
  it('passes a clean row', () => {
    expect(validateSeatRows([seat('bob@example.com')], 'alice@example.com')).toEqual([null]);
  });

  it('flags a BLANK row instead of skipping it', () => {
    // "Add another person" created the row, so a blank one is a person the
    // operator started adding. Silently dropping it provisions fewer seats than
    // they believe they asked for, and the result panel would look complete.
    expect(validateSeatRows([{ email: '', name: '' }], 'alice@example.com')).toEqual(['blank']);
    expect(validateSeatRows([{ email: '   ', name: '  ' }], 'a@b.com')).toEqual(['blank']);
  });

  it('requires an email, then a valid one, then a name', () => {
    expect(validateSeatRows([{ email: '', name: 'Bob' }], 'a@b.com')).toEqual(['missing_email']);
    expect(validateSeatRows([{ email: 'bob', name: 'Bob' }], 'a@b.com')).toEqual(['invalid_email']);
    expect(validateSeatRows([{ email: 'bob@example.com', name: '' }], 'a@b.com')).toEqual([
      'missing_name',
    ]);
  });

  it('flags only the LATER of two duplicate rows', () => {
    // The first occurrence is the one that will be provisioned, so blaming both
    // rows would tell the operator to fix a row that is correct.
    expect(
      validateSeatRows([seat('bob@example.com'), seat('BOB@Example.com')], 'alice@example.com'),
    ).toEqual([null, 'duplicate_email']);
  });

  it('flags a seat that repeats the PRIMARY email', () => {
    // The primary is already being provisioned by this same call, so this is
    // not a second seat — it is one seat that replays or collides, and either
    // way the operator's intent (another person) does not happen.
    expect(validateSeatRows([seat('Alice@Example.com')], 'alice@example.com')).toEqual([
      'same_as_primary',
    ]);
  });

  it('does not flag anything against an empty primary email', () => {
    expect(validateSeatRows([seat('bob@example.com')], '')).toEqual([null]);
  });

  it('aligns one problem per row, positionally', () => {
    const problems = validateSeatRows(
      [seat('bob@example.com'), { email: 'nope', name: 'X' }, seat('carol@example.com')],
      'alice@example.com',
    );
    expect(problems).toEqual([null, 'invalid_email', null]);
    expect(seatsBlockSubmit(problems)).toBe(true);
    expect(seatsBlockSubmit([null, null])).toBe(false);
    expect(seatsBlockSubmit([])).toBe(false);
  });

  it('has a message for every problem it can return', () => {
    const problems = [
      'blank',
      'missing_email',
      'invalid_email',
      'missing_name',
      'duplicate_email',
      'same_as_primary',
    ] as const;
    for (const p of problems) {
      expect(seatProblemMessage(p)).toMatch(/\S/);
    }
  });
});

describe('seatCountProblem', () => {
  it('is silent at and below the backend cap', () => {
    const rows = Array.from({ length: MAX_ADDITIONAL_SEATS }, (_, i) => seat(`p${i}@x.com`));
    expect(seatCountProblem(rows)).toBeNull();
    expect(seatCountProblem([])).toBeNull();
  });

  it('refuses locally rather than spending a request that 422s', () => {
    // The enforcing copy is the zod `.max()` upstream. Learning the limit AFTER
    // typing 26 people's names is the outcome this avoids.
    const rows = Array.from({ length: MAX_ADDITIONAL_SEATS + 2 }, (_, i) => seat(`p${i}@x.com`));
    const msg = seatCountProblem(rows);
    expect(msg).toContain(String(MAX_ADDITIONAL_SEATS));
    expect(msg).toMatch(/Remove 2\b/);
  });

  it('mirrors the documented backend maximum', () => {
    // A drift guard with teeth: if the upstream `.max()` changes and this does
    // not, the form starts accepting requests the backend rejects.
    expect(MAX_ADDITIONAL_SEATS).toBe(25);
  });
});

describe('additionalSeatsPayload', () => {
  it('OMITS the field when no seats were added', () => {
    // Absent ⇒ the pre-existing single-seat call this page has always made.
    // `[]` would be an explicit "provision no extra seats" — a different request.
    expect(additionalSeatsPayload([])).toBeUndefined();
    expect(additionalSeatsPayload([{ email: '  ', name: '' }])).toBeUndefined();
  });

  it('trims and sends exactly {email, name}', () => {
    expect(additionalSeatsPayload([{ email: ' bob@example.com ', name: ' Bob ' }])).toEqual([
      { email: 'bob@example.com', name: 'Bob' },
    ]);
  });
});

// ===========================================================================
// Per-seat result rendering.
// ===========================================================================

const seatResult = (over: Partial<SeatResultView> = {}): SeatResultView => ({
  email: 'bob@example.com',
  status: 'provisioned',
  temporary_password: 'seat-pw',
  magic_link_sent: true,
  tokens: { 'fr-frontend': 'seat-tok' },
  license_ids: { 'fr-frontend': 'seat-lic' },
  ...over,
});

describe('seatStatusTone / seatStatusHeadline', () => {
  it('never lets a failure read as healthy', () => {
    expect(seatStatusTone('provisioned')).toBe('success');
    expect(seatStatusTone('replayed')).toBe('warning');
    expect(seatStatusTone('failed')).toBe('danger');
  });

  it('does not call a REPLAY a provision', () => {
    // `replayed` is a success status for a call that created nothing.
    const msg = seatStatusHeadline(seatResult({ status: 'replayed', temporary_password: null }));
    expect(msg).toMatch(/nothing new was created/i);
    expect(msg).not.toMatch(/— provisioned/);
  });

  it('carries the backend’s own failure reason', () => {
    const msg = seatStatusHeadline(
      seatResult({ status: 'failed', error: 'keycloak 409 user exists' }),
    );
    expect(msg).toContain('keycloak 409 user exists');
    expect(msg).toMatch(/FAILED/);
  });

  it('says so when a failure arrived with NO reason, instead of inventing one', () => {
    const msg = seatStatusHeadline(seatResult({ status: 'failed' }));
    expect(msg).toMatch(/gave no reason/i);
  });
});

describe('seatCredentialState', () => {
  it('shows a seat’s real password when one was minted', () => {
    expect(seatCredentialState(seatResult())).toEqual({
      kind: 'password',
      password: 'seat-pw',
    });
  });

  it('renders NO empty credential box for a REPLAYED seat', () => {
    // The rule this route already enforces for the primary account, reached by
    // DELEGATING to `credentialState` rather than a second template branch.
    const state = seatCredentialState(
      seatResult({ status: 'replayed', temporary_password: null, magic_link_sent: false }),
    );
    expect(state?.kind).toBe('none');
    if (state?.kind !== 'none') throw new Error('unreachable');
    expect(state.reason).toMatch(/replayed/i);
    expect(state.reason).toMatch(/not re-fetchable/i);
    expect(state.recovery).toMatch(/password-reset from Keycloak/i);
  });

  it('inherits the empty-string guard from credentialState', () => {
    expect(seatCredentialState(seatResult({ temporary_password: '' }))?.kind).toBe('none');
    // Proof it is the SAME rule, not a parallel one.
    expect(
      credentialState({ temporary_password: '', already_existed: true }).kind,
    ).toBe('none');
  });

  it('reads the backend’s already_existed instead of inferring it from the status', () => {
    // A `provisioned` seat can ALSO have existed already: the run completed, but
    // the password was deliberately not rotated. Deriving the flag from
    // `status === 'replayed'` would report that seat as a fresh account.
    const state = seatCredentialState(
      seatResult({ status: 'provisioned', already_existed: true, temporary_password: null }),
    );
    expect(state?.kind).toBe('none');
    if (state?.kind !== 'none') throw new Error('unreachable');
    expect(state.reason).toMatch(/already existed/i);
    expect(state.reason).toMatch(/not rotated/i);
    // NOT the replay sentence — nothing about this run was a replay.
    expect(state.reason).not.toMatch(/replayed/i);
  });

  it('renders NOTHING for a FAILED seat', () => {
    // `credentialState` would otherwise answer "no password was set, this
    // account already existed, send them a reset" — a sentence asserting an
    // account EXISTS, about a seat that was never created.
    expect(seatCredentialState(seatResult({ status: 'failed', temporary_password: null }))).toBeNull();
    expect(seatTokensMessage(seatResult({ status: 'failed', tokens: {} }))).toBeNull();
  });
});

describe('seatTokensMessage', () => {
  it('is null while there ARE tokens to render', () => {
    expect(seatTokensMessage(seatResult())).toBeNull();
  });

  it('explains a replayed seat’s unreadable token via the shared rule', () => {
    const msg = seatTokensMessage(
      seatResult({ status: 'replayed', tokens: {}, license_ids: { 'fr-frontend': 'lic-1' } }),
    );
    expect(msg).toMatch(/cannot be re-read/i);
    // Same sentence the primary panel produces — one rule, two call sites.
    expect(msg).toBe(
      noTokensMessage({
        temporary_password: null,
        already_existed: true,
        replayed: true,
        tokens: {},
        license_ids: { 'fr-frontend': 'lic-1' },
      }),
    );
  });
});

describe('tallySeats / describeSeatOutcome', () => {
  const mixed: SeatResultView[] = [
    seatResult({ email: 'a@x.com', status: 'provisioned' }),
    seatResult({ email: 'b@x.com', status: 'replayed' }),
    seatResult({ email: 'c@x.com', status: 'failed', error: 'boom' }),
  ];

  it('counts every status separately', () => {
    expect(tallySeats(mixed)).toEqual({ total: 3, provisioned: 1, replayed: 1, failed: 1 });
    expect(tallySeats([])).toEqual({ total: 0, provisioned: 0, replayed: 0, failed: 0 });
  });

  it('never reports the TOTAL as a success count', () => {
    // The exact lie a seat-count input would have encouraged: the number asked
    // for, presented as the number that exists.
    const msg = describeSeatOutcome(mixed);
    expect(msg).toMatch(/^1 of 3 seats FAILED/);
    expect(msg).not.toMatch(/3 provisioned/);
    expect(msg).toMatch(/1 provisioned/);
    expect(msg).toMatch(/replayed, nothing created/);
  });

  it('says the successful seats were NOT rolled back', () => {
    // Provisioning is not transactional, so a partial run leaves real accounts
    // behind. An operator who re-runs must know that.
    expect(describeSeatOutcome(mixed)).toMatch(/not transactional/i);
    expect(describeSeatOutcome(mixed)).toMatch(/NOT rolled back/);
  });

  it('reports a clean run without any failure language', () => {
    const msg = describeSeatOutcome([seatResult({ status: 'provisioned' })]);
    expect(msg).toBe('1 seat: 1 provisioned.');
    expect(msg).not.toMatch(/fail/i);
  });

  it('does not claim seats when none were requested', () => {
    expect(describeSeatOutcome([])).toMatch(/No additional seats were requested/);
  });
});


describe('existing-tenant picker', () => {
  const t = (id: string, extra: Partial<TenantRecord> = {}): TenantRecord => ({
    id,
    name: `t-${id.slice(0, 4)}`,
    keycloak_realm: null,
    byo_mode: 'byo_required',
    created_at: null,
    archived_at: null,
    ...extra,
  });
  const CONVEYOR = '5f868d42-03f8-51f0-a93c-3e83070dc196';
  const OWN = '11111111-2222-4333-8444-555555555555';

  it('isTenantId accepts a uuid and refuses a slug', () => {
    expect(isTenantId(` ${CONVEYOR} `)).toBe(true);
    expect(isTenantId('acme-co')).toBe(false);
  });

  it('mergeTenants dedupes by id (first wins) and drops archived tenants', () => {
    const merged = mergeTenants(
      [t(CONVEYOR, { name: 'resolved-by-id' })],
      [t(CONVEYOR, { name: 'listed' }), t(OWN), t('99999999-2222-4333-8444-555555555555', { archived_at: '2026-01-01' })],
    );
    expect(merged.map((x) => x.id)).toEqual([CONVEYOR, OWN]);
    expect(merged[0]!.name).toBe('resolved-by-id');
  });

  it('options carry kind, owner and id so a service tenant is recognisable', () => {
    const [opt] = existingTenantOptions([t(CONVEYOR, { name: 'svc-n8n-local-conveyor', kind: 'service', owner_key: 'platform' })]);
    expect(opt).toEqual({
      value: CONVEYOR,
      label: 'svc-n8n-local-conveyor',
      sublabel: `service · owner platform · ${CONVEYOR}`,
    });
  });

  it('a tenant with no kind reads as unclassified, never dropped', () => {
    const opts = existingTenantOptions([t(OWN)]);
    expect(opts).toHaveLength(1);
    expect(opts[0]!.sublabel).toBe(`unclassified · ${OWN}`);
  });
});

describe("fr's per-person apps (the fr bundle)", () => {
  it('is exactly fr + fr-frontend, and the default selects both', () => {
    expect([...FR_PERSON_APPS]).toEqual(['fr', 'fr-frontend']);
    expect(defaultPersonApps()).toEqual(['fr', 'fr-frontend']);
    // A fresh copy each call, so a form reset never shares state with the constant.
    expect(defaultPersonApps()).not.toBe(defaultPersonApps());
  });

  it("narrows the catalogue to fr + fr-frontend: other platforms' apps and unknown keys are never offered", () => {
    const keys = [
      'fr', 'fr-frontend', 'kanban', 'n8n', 'coding', 'agent', 'care-bus', 'strata-configurator',
      'commonpractice', 'w2v', 'some-future-app',
    ];
    expect(frPersonApps(keys.map((key) => ({ key }))).map((a) => a.key)).toEqual(['fr', 'fr-frontend']);
  });

  it('the gate key fr cannot be unticked; fr-frontend can', () => {
    expect(canUntickApp('fr')).toBe(false);
    expect(canUntickApp('fr-frontend')).toBe(true);
  });
});
