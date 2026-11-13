// src/routes/secrets.ts
import { db, userSecrets } from '../db/client';
import { eq, and } from 'drizzle-orm';
import { SecretCreateSchema, SecretUpdateSchema } from '../types/secrets';
import { encryption } from '../services/encryption';
import { validateAuth } from '../middleware/auth';
import { NotFoundError } from '../utils/errors';
import { isUuidShape } from '../lib/uuid-shape';
import { jsonResponse, createdResponse, noContentResponse } from '../utils/response';

// GET /api/secrets - List user's secrets (metadata only)
export async function handleListSecrets(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  const secrets = await db.select({
    id: userSecrets.id,
    name: userSecrets.name,
    description: userSecrets.description,
    secret_type: userSecrets.secret_type,
    created_at: userSecrets.created_at,
    updated_at: userSecrets.updated_at,
    last_used: userSecrets.last_used,
    is_valid: userSecrets.is_valid,
  })
    .from(userSecrets)
    .where(eq(userSecrets.user_id, user.id));

  return jsonResponse({
    items: secrets,
    total: secrets.length,
  });
}

// POST /api/secrets - Create new secret
export async function handleCreateSecret(req: Request): Promise<Response> {
  const user = await validateAuth(req);

  const body = await req.json();
  const validated = SecretCreateSchema.parse(body);

  // Encrypt secret value
  const { encrypted, iv } = await encryption.encrypt(validated.secret_value);

  const [secret] = await db.insert(userSecrets).values({
    user_id: user.id,
    name: validated.name,
    description: validated.description,
    secret_type: validated.secret_type,
    encrypted_value: Buffer.from(encrypted),
    iv,
    metadata: validated.metadata,
  }).returning({
    id: userSecrets.id,
    name: userSecrets.name,
    description: userSecrets.description,
    secret_type: userSecrets.secret_type,
    created_at: userSecrets.created_at,
  });

  return createdResponse({
    ...secret,
    message: 'Secret created successfully',
  });
}

// PUT /api/secrets/:id - Update secret
export async function handleUpdateSecret(req: Request, secretId: string): Promise<Response> {
  const user = await validateAuth(req);

  // `user_secrets.id` is a `uuid` column (schema.ts:409): a `:id` segment that
  // is not UUID-shaped aborts the query with 22P02 `invalid input syntax for
  // type uuid` rather than matching nothing, surfacing as a bare 500. Same 404
  // as the owner-scoped miss below — a malformed id must not be distinguishable
  // from another user's secret. `isUuidShape`, not `isValidUuid` (utils/tenant),
  // which pins the version/variant nibbles and would 404 real rows.
  if (!isUuidShape(secretId)) {
    throw new NotFoundError('Secret not found');
  }

  const [secret] = await db.select()
    .from(userSecrets)
    .where(and(
      eq(userSecrets.id, secretId),
      eq(userSecrets.user_id, user.id)
    ));

  if (!secret) {
    throw new NotFoundError('Secret not found');
  }

  const validated = SecretUpdateSchema.parse(await req.json());
  const updates: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (validated.name) updates.name = validated.name;
  if (validated.description !== undefined) updates.description = validated.description;

  if (validated.secret_value) {
    const { encrypted, iv } = await encryption.encrypt(validated.secret_value);
    updates.encrypted_value = Buffer.from(encrypted);
    updates.iv = iv;
  }

  const [updated] = await db.update(userSecrets)
    .set(updates)
    // Scope the mutation by owner too (defense-in-depth): the SELECT above
    // already proved ownership, but a self-protecting WHERE survives any future
    // refactor that drops or reorders that gate.
    .where(and(eq(userSecrets.id, secretId), eq(userSecrets.user_id, user.id)))
    .returning({
      id: userSecrets.id,
      name: userSecrets.name,
      updated_at: userSecrets.updated_at,
    });

  if (!updated) {
    throw new NotFoundError('Secret not found');
  }

  return jsonResponse({
    ...updated,
    message: 'Secret updated successfully',
  });
}

// DELETE /api/secrets/:id - Delete secret
export async function handleDeleteSecret(req: Request, secretId: string): Promise<Response> {
  const user = await validateAuth(req);

  // Same `uuid`-shape guard as handleUpdateSecret (schema.ts:409) — same 404, so
  // malformed and not-yours remain indistinguishable on the delete path too.
  if (!isUuidShape(secretId)) {
    throw new NotFoundError('Secret not found');
  }

  const [secret] = await db.select()
    .from(userSecrets)
    .where(and(
      eq(userSecrets.id, secretId),
      eq(userSecrets.user_id, user.id)
    ));

  if (!secret) {
    throw new NotFoundError('Secret not found');
  }

  await db.delete(userSecrets)
    // Defense-in-depth: scope the delete by owner, not the gating SELECT alone.
    .where(and(eq(userSecrets.id, secretId), eq(userSecrets.user_id, user.id)));

  return noContentResponse();
}
