// src/services/planka/with-auth.ts
import { plankaClient } from './index';
import type { PlankaClient } from './index';

/**
 * The PlankaClient fr uses for everything. Planka use is per tenant, not per
 * user (George, 2026-10-10): one fr deployment acts in its (bring-your-own)
 * Planka as ONE configured account — PLANKA_BASE_URL + PLANKA_AGENT_EMAIL /
 * PLANKA_AGENT_PASSWORD (`config.services.planka`). fr users are not Planka
 * users. WHO may act is decided by fr's own access checks (tenant gates,
 * `assertBoardTenantWritable`, …) before a route reaches this client; Planka's
 * permissions only bound what that one account can do.
 *
 * The account needs a Planka role that can create projects (admin or
 * projectOwner): project/board create and adding board members run through it.
 */
export function plankaAsAgent(): PlankaClient {
  return plankaClient.asAgent();
}
