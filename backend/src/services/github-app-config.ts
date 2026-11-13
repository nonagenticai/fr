// services/github-app-config.ts
//
// One reader for the public GitHub App env (`nonagenticai`, app id 5029921).
// Every value is OPTIONAL at boot — the feature is inert until configured (see
// the `githubApp` block in config.ts). Each getter prefers the config snapshot
// and falls back to process.env LIVE, the same shape as
// download-tokens.ts `signingKey()`, so a test preload that sets env after
// config.ts was evaluated is still seen.

import { config } from '../config';

export const GITHUB_APP_ENV = {
  slug: 'GITHUB_PUBLIC_APP_SLUG',
  clientId: 'GITHUB_PUBLIC_APP_CLIENT_ID',
  clientSecret: 'GITHUB_PUBLIC_APP_CLIENT_SECRET',
  stateSigningKey: 'GITHUB_APP_STATE_SIGNING_KEY',
  bindingToken: 'FR_GITHUB_BINDING_TOKEN',
} as const;

type Key = keyof typeof GITHUB_APP_ENV;

function read(key: Key): string {
  const snap = (config.services as { githubApp?: Record<Key, string> }).githubApp?.[key] ?? '';
  return (snap || process.env[GITHUB_APP_ENV[key]] || '').trim();
}

export const DEFAULT_GITHUB_APP_SLUG = 'nonagenticai';
export const DEFAULT_FR_PUBLIC_URL = 'https://fr.nonagentic.ai';

export function githubAppSlug(): string {
  return read('slug') || DEFAULT_GITHUB_APP_SLUG;
}
export function githubAppClientId(): string {
  return read('clientId');
}
export function githubAppClientSecret(): string {
  return read('clientSecret');
}
export function githubAppStateSigningKey(): string {
  return read('stateSigningKey');
}
export function githubBindingToken(): string {
  return read('bindingToken');
}

/**
 * Env names the install flow needs and does not have. Empty = configured.
 * The slug has a default, so it is never missing. Names only — never values.
 */
export function missingInstallFlowEnv(): string[] {
  const missing: string[] = [];
  if (!githubAppClientId()) missing.push(GITHUB_APP_ENV.clientId);
  if (!githubAppClientSecret()) missing.push(GITHUB_APP_ENV.clientSecret);
  if (!githubAppStateSigningKey()) missing.push(GITHUB_APP_ENV.stateSigningKey);
  return missing;
}

/** Where the browser lands after the callback. FR_PUBLIC_URL, trailing slashes stripped. */
export function frPublicUrl(): string {
  const raw = (config.publicBaseUrl || process.env.FR_PUBLIC_URL || '').trim();
  return (raw || DEFAULT_FR_PUBLIC_URL).replace(/\/+$/, '');
}
