// src/types/secrets.ts
import { z } from 'zod';

export const SecretCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  secret_type: z.enum(['api_key', 'oauth', 'basic_auth', 'custom']),
  secret_value: z.string().min(1),
  metadata: z.record(z.any()).optional(),
});

export const SecretUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  secret_value: z.string().min(1).optional(),
});

export const SecretResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  secret_type: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
  last_used: z.date().optional(),
  is_valid: z.boolean(),
});

export type SecretCreate = z.infer<typeof SecretCreateSchema>;
export type SecretResponse = z.infer<typeof SecretResponseSchema>;
