// src/types/urlCredentials.ts
import { z } from 'zod';

/**
 * Credential types for different authentication methods
 */
export const CredentialTypeEnum = z.enum(['basic', 'bearer', 'api_key', 'cookie', 'custom', 'form']);
export type CredentialType = z.infer<typeof CredentialTypeEnum>;

/**
 * Basic Authentication credentials
 */
export const BasicAuthCredentialsSchema = z.object({
  auth_type: z.literal('basic'),
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Bearer Token credentials
 */
export const BearerTokenCredentialsSchema = z.object({
  auth_type: z.literal('bearer'),
  auth_token: z.string().min(1),
});

/**
 * API Key credentials
 */
export const ApiKeyCredentialsSchema = z.object({
  auth_type: z.literal('api_key'),
  api_key: z.string().min(1),
  api_key_header: z.string().optional(),
});

/**
 * Cookie-based credentials
 */
export const CookieCredentialsSchema = z.object({
  auth_type: z.literal('cookie'),
  cookies: z.record(z.string()),
});

/**
 * Custom headers credentials
 */
export const CustomHeadersCredentialsSchema = z.object({
  auth_type: z.literal('custom'),
  custom_headers: z.record(z.string()),
});

/**
 * Form-based authentication credentials (e.g. login forms posted by the
 * scraper before crawling). Mirrors the `'form'` variant of the scrape
 * `auth_config` (POST /api/tools/kag/scrape/url).
 */
export const FormAuthCredentialsSchema = z.object({
  auth_type: z.literal('form'),
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Union of all credential types
 */
export const CredentialsSchema = z.discriminatedUnion('auth_type', [
  BasicAuthCredentialsSchema,
  BearerTokenCredentialsSchema,
  ApiKeyCredentialsSchema,
  CookieCredentialsSchema,
  CustomHeadersCredentialsSchema,
  FormAuthCredentialsSchema,
]);

export type Credentials = z.infer<typeof CredentialsSchema>;

/**
 * URL Credential Create/Update Schema
 */
export const URLCredentialCreateSchema = z.object({
  identifier: z.string().min(1).max(255),
  url: z.string().url(),
  credentials: CredentialsSchema,
  metadata: z.record(z.any()).optional(),
  ttl: z.number().positive().optional(),
});

export type URLCredentialCreate = z.infer<typeof URLCredentialCreateSchema>;

/**
 * URL Credential Response Schema
 */
export const URLCredentialResponseSchema = z.object({
  credential_id: z.string().uuid(),
  user_id: z.string(),
  identifier: z.string(),
  url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().nullable(),
  metadata: z.record(z.any()).nullable(),
});

export type URLCredentialResponse = z.infer<typeof URLCredentialResponseSchema>;
