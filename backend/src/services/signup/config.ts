// src/services/signup/config.ts — early-access signup v2 settings (read at CALL time).
//
// Early-access v2 (CommonPractice is the reference; ~/.claude/plans/early-access-v2.md): a visitor
// asks for access on nonagentic.ai/early-access/fr, the shared early-access-intake handler relays
// it here with a Keycloak service-account token, George approves with one tap in Telegram
// (chat-bridge relays the tap to POST /api/signup-approvals/:id/telegram-decision), and the person
// gets ONE email: set a password, land in fr signed in.
//
// ⛔ OFF BY DEFAULT. Every signup route answers 503 `signup_not_configured` until
// FR_SIGNUP_ENABLED=true. The fr image can run in more than one Deployment (the kag instance runs
// fr-derived code with the conveyor disabled); only the main fr.nonagentic.ai Deployment may take
// signups, and it must say so explicitly.
//
// Every value is read from `process.env` per call, never frozen at import, so tests can drive it
// and an operator can change it with a rollout of env only.

import { FR_APP_KEY } from '../../lib/fr-app-key';
import { isFrBundle, isFrPersonApp } from '../../lib/fr-issuable-apps';

/** The eight languages the website, the Keycloak email theme and the CHECK on the column share. */
export const SIGNUP_LOCALES = ['ar', 'de', 'en', 'es', 'fr', 'he', 'nl', 'pl'] as const;
export type SignupLocale = (typeof SIGNUP_LOCALES)[number];
export const DEFAULT_SIGNUP_LOCALE: SignupLocale = 'en';

/**
 * A caller-supplied language tag → one of SIGNUP_LOCALES, or null. Lenient on purpose: the intake
 * relays a browser's `<html lang>` / cookie, so `de-DE`, `DE` and `de_AT` mean German, and an
 * unknown language is "not told" (→ English), never a refused signup.
 */
export function normaliseSignupLocale(value: unknown): SignupLocale | null {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return (SIGNUP_LOCALES as readonly string[]).includes(primary) ? (primary as SignupLocale) : null;
}

/** The product key of contract C1 (`ea1:fr:a|r:<id>`) and the `signup_app` Keycloak attribute. */
export const SIGNUP_APP_KEY = 'fr';

function csv(raw: string | undefined, fallback: string[]): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

/** FR_SIGNUP_ENABLED=true — the only switch that opens the signup routes. */
export function signupEnabled(): boolean {
  return process.env.FR_SIGNUP_ENABLED === 'true';
}

/** The intake door (POST /api/signup-approvals/intake): the website handler's service account. */
export function signupIntakeConfig(): { allowedAzp: string[]; role: string } {
  return {
    allowedAzp: csv(process.env.FR_SIGNUP_INTAKE_AZP, ['fr-signup-intake']),
    role: (process.env.FR_SIGNUP_INTAKE_ROLE ?? '').trim() || 'fr-signup-intake',
  };
}

/** The Telegram decision door (POST /api/signup-approvals/:id/telegram-decision): chat-bridge's SA. */
export function signupDeciderConfig(): { allowedAzp: string[]; role: string } {
  return {
    allowedAzp: csv(process.env.FR_SIGNUP_DECIDER_AZP, ['chat-bridge-signup-decider']),
    role: (process.env.FR_SIGNUP_DECIDER_ROLE ?? '').trim() || 'fr-signup-decide',
  };
}

/**
 * The issuer every signup service token must carry. Defaults to the backend's own issuer
 * (`KEYCLOAK_ISSUER`, else `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`) — the portal realm in
 * production.
 */
export function signupTokenIssuer(): string {
  const explicit = (process.env.KEYCLOAK_ISSUER ?? '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const url = (process.env.KEYCLOAK_URL ?? '').replace(/\/+$/, '');
  return url ? `${url}/realms/${process.env.KEYCLOAK_REALM || 'portal'}` : '';
}

/**
 * Realm-per-app F1 (mirrors commonpractice #480): the issuer(s) each signup door accepts its client
 * from. FR_SIGNUP_INTAKE_ISSUER / FR_SIGNUP_DECIDER_ISSUER, a CSV of full issuer URLs, default
 * `[signupTokenIssuer()]` (today). A LIST so a door's client moves realm (portal → secure-apps,
 * realm-per-app P7) with no outage: both accepted while the caller flips, then the old one dropped.
 * Production boot refuses any entry that is not in KEYCLOAK_TRUSTED_ISSUERS
 * (config.ts keycloakRealmConfigProblems).
 */
function issuerPins(raw: string | undefined): string[] {
  const list = csv(raw, []).map((s) => s.replace(/\/+$/, '')).filter(Boolean);
  if (list.length > 0) return list;
  const fallback = signupTokenIssuer();
  return fallback ? [fallback] : [];
}

export function signupIntakeIssuers(): string[] {
  return issuerPins(process.env.FR_SIGNUP_INTAKE_ISSUER);
}

export function signupDeciderIssuers(): string[] {
  return issuerPins(process.env.FR_SIGNUP_DECIDER_ISSUER);
}

/** fr's public origin (FR_PUBLIC_URL), no trailing slash: the email's landing page + deep links. */
export function signupPublicUrl(): string {
  return (process.env.FR_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
}

/**
 * The licence app keys an approve mints when FR_SIGNUP_APPS is unset. `fr` is the key fr's own
 * gate requires (`require-fr-license.ts`); `fr-frontend` is the frontend client's licence.
 */
export const DEFAULT_SIGNUP_APPS: readonly string[] = [FR_APP_KEY, 'fr-frontend'];

/**
 * FR_SIGNUP_APPS (csv) or the default, narrowed to fr's per-person licences (FR_PERSON_APPS:
 * `fr` + `fr-frontend`) — and ALWAYS the gate's key. fr provisions only its own platform context
 * (lib/fr-issuable-apps.ts), so a key from another platform in the env is dropped rather than
 * minted (and logged by `logSignupAppsStatus`). Without an active `fr` licence the workspace a
 * signup founds is refused by fr's own gate ("No active license for this workspace",
 * 2026-10-20), so an operator list that omits it gets it appended rather than producing a signup
 * that completes, emails the person, and locks them out.
 */
export function signupApps(): string[] {
  const apps = csv(process.env.FR_SIGNUP_APPS, [...DEFAULT_SIGNUP_APPS]).filter(isFrPersonApp);
  return apps.includes(FR_APP_KEY) ? apps : [...apps, FR_APP_KEY];
}

/** FR_SIGNUP_APPS keys dropped because they are not fr per-person licences. */
export function droppedSignupApps(): string[] {
  return csv(process.env.FR_SIGNUP_APPS, []).filter((k) => !isFrPersonApp(k));
}

/**
 * The bundle a signup ensures on its new tenant: FR_SIGNUP_BUNDLE (default `conveyor`), only if it
 * is one of fr's own bundles (FR_BUNDLES); anything else is '' (no bundle) and named at boot.
 */
export function signupBundle(): string {
  const raw = process.env.FR_SIGNUP_BUNDLE === undefined ? 'conveyor' : process.env.FR_SIGNUP_BUNDLE.trim();
  return raw === '' || isFrBundle(raw) ? raw : '';
}

/** Boot lines: which keys an approve will license, what was dropped or appended, and the bundle. */
export function logSignupAppsStatus(): void {
  const raw = csv(process.env.FR_SIGNUP_APPS, []);
  const dropped = droppedSignupApps();
  const kept = raw.filter(isFrPersonApp);
  const appended = raw.length > 0 && !kept.includes(FR_APP_KEY);
  console.log(
    `[signup] licence apps=${signupApps().join(',')}` +
      (dropped.length > 0
        ? ` (FR_SIGNUP_APPS dropped ${dropped.join(',')}: outside fr's platform context, fr provisions only fr + fr-frontend per person)`
        : '') +
      (appended ? ` (FR_SIGNUP_APPS omitted the gate key '${FR_APP_KEY}': appended)` : ''),
  );
  const rawBundle = (process.env.FR_SIGNUP_BUNDLE ?? '').trim();
  if (rawBundle && !isFrBundle(rawBundle)) {
    console.log(`[signup] FR_SIGNUP_BUNDLE=${rawBundle} is not an fr bundle: no bundle will be ensured`);
  }
}

export interface SignupProvisioningConfig {
  /** Licence app keys minted for the requester: `signupApps()` — always includes the gate's `fr`. */
  apps: string[];
  /** The bundle ensured on the new tenant ('' = none, or not an fr bundle). licenses migration 059: `conveyor`. */
  bundle: string;
  /** Ordered plan-code preference for the bundle's INSERTED licences. */
  bundlePlans: string[];
  /** The manual monthly token budget (provision-user's default). */
  monthlyBudgetTokens: number;
  /** Keycloak client the set-password link belongs to (C5: the app's frontend client). */
  frontendClientId: string;
  /** Link lifetime in seconds (14 days, as CommonPractice). */
  emailLifespanSeconds: number;
}

export function signupProvisioningConfig(): SignupProvisioningConfig {
  const budget = Number.parseInt((process.env.FR_SIGNUP_MONTHLY_BUDGET_TOKENS ?? '').trim(), 10);
  return {
    apps: signupApps(),
    bundle: signupBundle(),
    bundlePlans: csv(process.env.FR_SIGNUP_BUNDLE_PLANS, ['standard']),
    monthlyBudgetTokens: Number.isInteger(budget) && budget > 0 ? budget : 1_000_000,
    frontendClientId: (process.env.FR_SIGNUP_FRONTEND_CLIENT_ID ?? '').trim() || 'fr-frontend',
    emailLifespanSeconds: 14 * 24 * 60 * 60,
  };
}

export interface SignupTelegramConfig {
  enabled: boolean;
  /** @nonagenticaibot's token — NOT fr's own TELEGRAM_BOT_TOKEN (a different bot, fr's channel). */
  botToken: string;
  chatId: string;
  threadId: string;
  apiBase: string;
}

/**
 * The fr signups forum topic in George's chat (-1003934173351; never topic 167). Sent with
 * @nonagenticaibot, whose webhook chat-bridge owns — fr only ever calls sendMessage.
 */
export function signupTelegramConfig(): SignupTelegramConfig {
  const botToken = (process.env.FR_SIGNUP_TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = (process.env.FR_SIGNUP_TELEGRAM_CHAT_ID ?? '').trim();
  const threadId = (process.env.FR_SIGNUP_TELEGRAM_THREAD_ID ?? '').trim();
  return {
    enabled: Boolean(botToken && chatId && threadId && /^\d+$/.test(threadId)),
    botToken,
    chatId,
    threadId,
    apiBase: ((process.env.FR_SIGNUP_TELEGRAM_API_URL ?? '').trim() || 'https://api.telegram.org').replace(/\/+$/, ''),
  };
}

/** Pending rows past which the intake refuses with 503 `signup_queue_full`. */
export function signupQueueMax(): number {
  const raw = (process.env.FR_SIGNUP_QUEUE_MAX_PENDING ?? '').trim();
  if (!/^\d+$/.test(raw)) return 500;
  return Math.max(1, Number.parseInt(raw, 10));
}
