/**
 * fr-agui SPEC §10.1 / §13 P1c-b — the browser-side redaction for what the AGENT
 * surfaces RENDER (tool inputs, tool results, confirm-card summaries).
 *
 * The backend already redacts the stream, the stored thread and the LLM view
 * (backend/src/capabilities/redact.ts). This is the frontend half of the SAME
 * rules, so a value that slips past one seam (an older stored thread, a card that
 * echoes a route response) is still never painted on screen:
 *   1. PII by key — `maskAddress` / `maskRecipient`, the frontend ORIGINALS
 *      (channel-prefs.ts, deliveries.ts) the backend port was copied from;
 *   2. secret-NAMED keys (`*_token`, `password`, `api_key`, …) → «redacted»;
 *   3. secret-SHAPED values in every string (token prefixes, JWTs, webhook
 *      URLs, credentials in URLs and query strings, the 43-char licence token).
 *
 * ⭐ ONE vector file pins both sides: backend/tests/fixtures/redact/mask-vectors.json
 * (`scrub`, `scrubUnchanged`, `piiByKey`), asserted here by mask-vectors.test.ts and
 * on the backend by tests/unit/capabilities/redact.test.ts. A drift reds that side.
 *
 * Pure, env-free, never throws (a cycle or an over-deep value becomes «redacted»).
 * ⚠️ Patterns are assembled from fragments so this file is not itself a secret-scan hit.
 */
import { maskAddress, type ChannelKind } from './channel-prefs';
import { maskRecipient } from './deliveries';

export const REDACTED = '«redacted»';

const BEGIN = '-----' + 'BEGIN';
const END = '-----' + 'END';

interface SecretPattern {
	re: RegExp;
	keep?: (match: string, ...groups: string[]) => string;
}

/** Same list, same order, as backend `SECRET_VALUE_PATTERNS` (capabilities/redact.ts). */
const SECRET_VALUE_PATTERNS: ReadonlyArray<SecretPattern> = [
	{ re: new RegExp(`${BEGIN}[A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?(?:${END}[A-Z0-9 ]*PRIVATE KEY-----|$)`, 'g') },
	{ re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
	{ re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
	{ re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g },
	{ re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
	{ re: /\bAIza[0-9A-Za-z_-]{35}/g },
	{ re: /\b(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
	{ re: /\bnpm_[A-Za-z0-9]{36}/g },
	{ re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
	{ re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, keep: (_m, scheme) => `${scheme} ${REDACTED}` },
	{ re: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, keep: (_m, head) => `${head}${REDACTED}@` },
	{
		re: /\b((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[=:]\s*)("[^"]+"|'[^']+'|(?=[^\s,;&"']*[0-9_!@#$%^*+/-])[^\s,;&"']{6,})/gi,
		keep: (_m, head) => `${head}${REDACTED}`
	},
	{ re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
	{ re: /\bhf_[A-Za-z0-9]{30,}/g },
	{ re: /(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"'<>]+/gi, keep: (_m, head) => `${head}${REDACTED}` },
	{ re: /(?<![a-z0-9-])([a-z0-9-]+\.webhook\.office\.com\/webhookb2\/)[^\s"'<>]+/gi, keep: (_m, head) => `${head}${REDACTED}` },
	{ re: /(outlook\.office(?:365)?\.com\/webhook\/)[^\s"'<>]+/gi, keep: (_m, head) => `${head}${REDACTED}` },
	{ re: /((?:discord|discordapp)\.com\/api\/webhooks\/)[^\s"'<>]+/gi, keep: (_m, head) => `${head}${REDACTED}` },
	{ re: /(?<![0-9])[0-9]{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
	{
		re: /([?&](?:token|sig|signature|key|api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password)=)[^&\s#"'<>]+/gi,
		keep: (_m, head) => `${head}${REDACTED}`
	},
	{ re: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[0-9a-f]{40}@/gi, keep: (_m, head) => `${head}${REDACTED}@` },
	{
		re: /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{0,42}[A-Z])(?=[A-Za-z0-9_-]{0,42}[a-z])(?=[A-Za-z0-9_-]{0,42}[0-9])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g
	}
];

/** Replace every secret-shaped substring of `s`. */
export function scrubString(s: string): string {
	let out = s;
	for (const { re, keep } of SECRET_VALUE_PATTERNS) {
		re.lastIndex = 0;
		out = out.replace(re, (m: string, ...rest: unknown[]) =>
			keep ? keep(m, ...(rest.filter((x) => typeof x === 'string') as string[])) : REDACTED
		);
	}
	return out;
}

const SECRET_KEY_RE =
	/^(?:.*[_-])?(?:token|secret|password|passwd|api_?key|apikey|credentials?|cookie|private_?key|client_?secret|refresh_?token|access_?token|session_?token|licen[cs]e_?token|bearer)$/i;
const NOT_SECRET_KEYS: ReadonlySet<string> = new Set(['secretfields', 'secret_fields', 'token_count', 'tokens', 'max_tokens']);

/** A KEY whose string value is a secret, whatever it looks like. */
export function isSecretKey(key: string): boolean {
	if (NOT_SECRET_KEYS.has(key.toLowerCase())) return false;
	return SECRET_KEY_RE.test(key);
}

type PiiMask = 'email' | 'address' | 'recipient';

/** Same keys as backend `AGENT_PII_MASKS`. */
const PII_MASKS: Readonly<Record<string, PiiMask>> = {
	email: 'email',
	approver_email: 'email',
	requester_email: 'email',
	decided_by_email: 'email',
	actor_email: 'email',
	owner_email: 'email',
	user_email: 'email',
	recipient_email: 'email',
	recipient_address: 'recipient',
	address: 'address'
};

/** One PII value masked exactly as the frontend cards mask that field. */
export function maskPii(mask: PiiMask, value: string, channel: string | null | undefined): string {
	if (mask === 'email') return maskAddress('email', value);
	if (mask === 'recipient') return maskRecipient(channel ?? '', value);
	return maskAddress((channel ?? '') as ChannelKind, value);
}

const MAX_DEPTH = 40;

/**
 * The redacted view of `value` for RENDERING. Never mutates the input.
 * `secretFields` adds the declared secret keys of a confirm card (`proposal.secretFields`).
 */
export function redactForDisplay<T>(value: T, secretFields: readonly string[] = []): T {
	const declared = new Set(secretFields);
	const seen = new WeakSet<object>();
	const walk = (v: unknown, depth: number): unknown => {
		if (typeof v === 'string') return scrubString(v);
		if (v === null || typeof v !== 'object') return v;
		if (depth > MAX_DEPTH || seen.has(v as object)) return REDACTED;
		seen.add(v as object);
		if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
		const obj = v as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(obj)) {
			if (declared.has(k) || (typeof x === 'string' && isSecretKey(k))) {
				out[k] = x === undefined || x === null || x === '' ? x : REDACTED;
				continue;
			}
			const pii = PII_MASKS[k];
			if (pii && typeof x === 'string' && (pii !== 'address' || typeof obj.channel === 'string')) {
				out[k] = maskPii(pii, x, typeof obj.channel === 'string' ? obj.channel : null);
				continue;
			}
			out[k] = walk(x, depth + 1);
		}
		return out;
	};
	try {
		return walk(value, 0) as T;
	} catch {
		return REDACTED as unknown as T;
	}
}

/** A short, REDACTED one-line text of any tool output (the ToolCallCard summary). */
export function redactedSummary(output: unknown, max = 200): string {
	if (output === undefined || output === null) return '';
	if (typeof output === 'string') return scrubString(output).slice(0, max);
	try {
		return JSON.stringify(redactForDisplay(output)).slice(0, max);
	} catch {
		return '(complex output)';
	}
}

/**
 * P1c-b — the REDACTED text of a thread's `lastMessagePreview` (the first 120 chars
 * of the last user/assistant message — agent text) for every surface that paints it
 * as a title, list label or document title. `fallback` when there is no preview.
 */
export function threadPreviewText(preview: string | null | undefined, fallback: string): string {
	if (typeof preview !== 'string' || preview === '') return fallback;
	return redactForDisplay(preview);
}
