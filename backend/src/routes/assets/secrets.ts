import { validateAuth } from '../../middleware/auth';
import { IntegrationError } from '../../integrations/_lib/errors';
import {
  createSecret,
  getSecret,
  listSecrets,
} from '../../integrations/secrets';
import { jsonResponse } from '../../utils/response';
import { handle } from './_lib/handler';

export async function handleListSecretAssets(req: Request): Promise<Response> {
  await validateAuth(req);
  return handle(
    () => listSecrets(),
    (data) => jsonResponse({ data }),
  );
}

export async function handleGetSecretAsset(
  req: Request,
  secretId: string,
): Promise<Response> {
  await validateAuth(req);
  return handle(
    () => getSecret(secretId),
    (data) => jsonResponse({ data }),
  );
}

export async function handleCreateSecretAsset(req: Request): Promise<Response> {
  await validateAuth(req);
  const body = (await req.json().catch(() => {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Invalid JSON request body',
    });
  })) as Parameters<typeof createSecret>[0];
  return handle(
    () => createSecret(body),
    (data) => jsonResponse({ data }, 201),
  );
}
