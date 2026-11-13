/**
 * AG-UI agent-callable read action for the `secrets` upstream — **metadata only**.
 *
 * Scope decision (see MEMORY `feedback-never-echo-plaintext-secrets-2026-05-11`):
 * the only registered action is `secrets.list`, which returns
 * `SecretListResponse` — id + identifier + timestamps + metadata, NO plaintext.
 *
 * We deliberately do NOT register `secrets.get` because `SecretRetrieveResponse`
 * exposes `secrets: {[key: string]: string}` plaintext at
 * `packages/service-clients/secrets/src/generated/models/secretRetrieveResponse.ts`,
 * and no plaintext may exit this surface.
 *
 * RBAC: `tenant-role: 'admin'` — only admins of the calling tenant see the
 * list of secret identifiers. Public/project-member would over-share even
 * metadata that names what secrets exist.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { AgentCallableAction } from '../types';
import { listSecrets } from '../../integrations/secrets';

const listInputSchema = z.object({}).strict();
type ListInput = z.infer<typeof listInputSchema>;
const listOutputSchema = z.object({
  secrets: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
});

const listAction: AgentCallableAction<ListInput, z.infer<typeof listOutputSchema>> = {
  name: 'secrets.list',
  kind: 'read',
  description:
    "List the calling tenant's stored secrets — METADATA ONLY (id, identifier, timestamps). Never returns plaintext values. Requires tenant admin role.",
  input: listInputSchema,
  output: listOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'tenant-role', role: 'admin' },
  idempotencyKey: () => 'secrets.list',
  handler: async () => {
    const out = await listSecrets();
    return { secrets: out.secrets, total: out.total };
  },
};

function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') {
      return;
    }
    throw err;
  }
}

export function registerSecretsActions(): void {
  safeRegister(listAction);
}
