// src/capabilities/admin/provisioning-recovery.ts
//
// The super_admin recovery action for a set-password email that may never have arrived
// (routes/admin/super-admin-resend.ts). Its own declaration file, outside the P4c part 3 set
// (capabilities/admin/provisioning.ts), which is pinned as the formerly-legacy routes.

import { z } from 'zod';

import { ResendSetPasswordEmailBody } from '../../routes/admin/super-admin-schemas';
import type { Capability } from '../define';
import { isAuthenticatedSuperAdmin } from '../rbac-rules';
import { caughtAuthResponses, routeRule, settingsCapabilities } from '../observe/_shared';

const GATE = "403: `error` 'super-admin only' (not a super_admin). ";
const BODY = "422: `error` 'invalid request body' (`details`: the zod issues; an unknown key is refused). 400: `error` 'invalid JSON body'. ";

export const PROVISIONING_RECOVERY_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'provisioning', tag: 'User Provisioning', tenancy: 'platform',
    module: 'src/routes/admin/super-admin.ts', load: () => import('../../routes/admin/super-admin'),
    rule: routeRule(isAuthenticatedSuperAdmin),
  },
  [
    {
      id: 'provisioning.resend_set_password_email', method: 'POST', path: '/api/admin/super-admin/resend-set-password-email', handler: 'handleResendSetPasswordEmail', effect: 'write',
      summary: 'Resend the set-password email to ONE fr account whose original email may never have arrived',
      description:
        'Explicit recovery only — nothing resends automatically. Allowed when the account is enabled, the person never set a ' +
        'password (no credential, or only the temporary one with UPDATE_PASSWORD pending), fr created it (this console, or an ' +
        'approved early-access signup), and no other resend attempt for it happened in the last 5 minutes. Sends the same ' +
        'email as the original flow. Every attempt is audited.',
      input: ResendSetPasswordEmailBody,
      output: z.object({
        user_id: z.string(),
        origin: z.enum(['console', 'signup']).describe('Which flow created the account (and so which email is sent).'),
        sent: z.literal(true),
      }),
      responses: caughtAuthResponses(
        { status: 'own', write: true },
        GATE + BODY +
          "429: `error` 'resend_rate_limited'. 403: `error` 'not_created_by_fr'. 409: `error` 'account_disabled' or " +
          "'already_activated'. 503: `error` 'public_url_unset'. Keycloak failures are relayed (`error.code` 'UPSTREAM_…'). " +
          "500: `error` 'resend failed' (`detail`). ",
      ),
    },
  ],
);
