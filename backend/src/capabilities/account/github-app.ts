// fr-agui SPEC §13 P4b (part 3) — spec drain: `GET /api/github-app/callback`
// (routes/github-app.ts handleGithubAppCallback), GitHub's post-install browser
// redirect, re-expressed with NO behaviour change (`legacyHandler`). Its siblings
// (install-url, claim confirm, installations) are literal spec operations; the
// internal binding lookup is a P1b service route.
//
// UNAUTHENTICATED BY DESIGN: GitHub's redirect carries no bearer. The signed,
// single-use `state` minted by install-url is the identity; it is verified and
// consumed before anything else. Nothing is bound here: a verified claim is parked
// and the browser is redirected to /settings/github, where the authenticated
// confirm binds it. Every outcome is a 302 to that page (`claim`, `pending` or
// `github_error`), except 503 when the install flow is not configured.
//
// The one principal gate is the SERVER's licence route door (routed-dispatch.ts):
// a licence-shaped bearer on this route (not allowlisted) is refused 403 before the
// handler runs. The declared rule is exactly that door (`principalDoorAdmits`), for
// any caller, authenticated or not. (The conveyor door is validateAuth's, which
// this handler never calls; it admits a GET anyway.)
//
// 🔐 `code` is GitHub's OAuth authorization code (exchanged for the installer's user
// token) and `state` the flow's single-use bearer identity: both are secret INPUTS.
import { z } from 'zod';

import { defineCapability } from '../define';
import { lazyHandler } from '../lazy';
import { principalDoorAdmits, type CapabilityRoute } from '../rbac-rules';
import { LICENCE_ROUTE_DOOR_403, frErrorBody, preHandlerRefusalBody } from '../settings/_shared';

const ROUTE: CapabilityRoute = { method: 'GET', path: '/api/github-app/callback' };

export const GITHUB_APP_CALLBACK_CAPABILITIES = [
  defineCapability({
    id: 'github_app.install_callback',
    area: 'github_app',
    summary: "GitHub's post-install redirect: verify the install and park a claim (a browser redirect, no bearer)",
    description:
      'Always a 302 to <fr>/settings/github: `?claim=<handle>` (verified; confirm it with POST /api/github-app/claims/{handle}/confirm), ' +
      '`?pending=1` (an org owner must still approve the request), or `?github_error=<code>` — invalid_state, invalid_installation, ' +
      'missing_code, oauth_failed, github_unavailable, not_your_installation, not_org_admin, not_account_owner, internal_error. ' +
      'Cache-Control: no-store; Referrer-Policy: no-referrer.',
    http: { method: ROUTE.method, path: ROUTE.path, operationId: 'githubAppInstallCallback', successStatus: 302 },
    input: z.object({
      state: z.string().optional().describe('🔐 SECRET: the signed single-use install state minted by install-url (verified and consumed first).'),
      setup_action: z.string().optional().describe("GitHub's: install | update | request ('request': nothing is installed yet)."),
      installation_id: z.string().optional().describe('The GitHub installation id (a positive integer).'),
      code: z.string().optional().describe('🔐 SECRET: the OAuth authorization code (exchanged for the installer\'s user token, which is revoked after use).'),
    }),
    output: z.null(),
    errors: [],
    auth: {
      principal: 'public',
      rbac: { type: 'custom', check: async () => principalDoorAdmits(ROUTE) },
    },
    tenancy: 'tenant',
    effect: 'write',
    // A write with no agent exposure: `card` only satisfies defineCapability (it never runs through the registry).
    confirm: 'card',
    secrets: { input: ['/state', '/code'] },
    agent: { expose: false, reason: 'browser-redirect' },
    openapi: {
      tags: ['GitHub App'],
      security: [],
      internal: true,
      responses: [
        {
          status: 503,
          description: "`error` 'GitHub App install flow is not configured', `code` 'github_app_not_configured' (its env is unset).",
          schema: z.object({ error: z.string(), code: z.literal('github_app_not_configured') }),
        },
        { status: 403, description: LICENCE_ROUTE_DOOR_403, schema: preHandlerRefusalBody },
        {
          status: 'default',
          description: "500: fr's own (`error`), e.g. the install-state store is unreachable (any failure that is not a state error).",
          schema: frErrorBody,
        },
      ],
    },
    legacyHandler: lazyHandler(() => import('../../routes/github-app'), { module: 'src/routes/github-app.ts', exportName: 'handleGithubAppCallback' }),
  }),
] as const;
