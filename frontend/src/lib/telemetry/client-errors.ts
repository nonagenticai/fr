/**
 * Client-side error sink.
 *
 * Why this exists: the fr frontend container logged ONE line in 30 hours (a
 * startup banner). Every bug a user actually hits — a render crash, a rejected
 * promise, a 500 from an API call — died in that user's browser console and was
 * invisible to every measurement anyone has made. This module is the capture
 * side; `POST /api/client-errors` on the backend is the sink.
 *
 * Three hard constraints shape the design:
 *
 *  1. It must never become a self-DoS. A render loop can throw thousands of
 *     times a second, and each report is an HTTP request. So: a hard cap of
 *     MAX_EVENTS_PER_WINDOW per rolling window, and over-cap events are DROPPED
 *     with a counter (never queued). The counter rides along on the next batch
 *     that does go out, so the drop itself is observable rather than silent.
 *  2. It must never leak credentials. We send message/stack/route/status/ids —
 *     never cookies, never an Authorization header, never a request or response
 *     body. `redact()` is a second belt on top of that: a token that leaked into
 *     an *error message* (a thrown URL with `?access_token=…`, a stringified
 *     fetch init) is scrubbed before it ever reaches the queue.
 *  3. It must work with no browser. The vitest project runs `environment:
 *     'node'`, and this code also gets imported during SSR. The transport
 *     no-ops without `fetch`, and the pure helpers (redaction, attribution)
 *     need no platform at all.
 *  4. It must only spend fr's budget on fr. `window.onerror` fires for EVERY
 *     script in the page, and a browser extension's content script runs in the
 *     page's own realm — so an extension's TypeError arrives here looking
 *     exactly like ours. Combined with constraint 1 that is not merely untidy:
 *     noise fr cannot fix was able to exhaust a deliberately small cap and the
 *     NEXT event, a real fr crash, was refused. Every report is therefore
 *     classified (`attributeError`) and each class has its OWN window budget,
 *     so no class can starve another. Nothing is dropped for being foreign —
 *     the label goes on the wire, because a blanket "unattributable ⇒ discard"
 *     would throw away the cross-origin reports the browser deliberately
 *     blinds us to, and losing a real fr error is strictly worse than logging
 *     a piece of noise.
 */

export type ClientErrorKind = 'uncaught' | 'unhandledrejection' | 'svelte' | 'api';

/**
 * Whose code failed.
 *
 * `window.onerror` fires for EVERY script in the page, including ones fr did not
 * ship: a browser extension's content script runs in the page's own realm, so
 * its TypeError reaches this module indistinguishably from ours unless we look.
 *
 *  - `own` — fr's code, as far as can be established. The DEFAULT, deliberately:
 *    anything not POSITIVELY attributable elsewhere is treated as ours, because
 *    a missed fr bug is strictly worse than a logged piece of noise.
 *  - `third_party` — provably not ours (see `attributeError` for what counts as
 *    proof): an extension URL scheme, or a stack made only of injected/eval'd
 *    frames with not one frame served over http(s).
 *  - `opaque` — the browser deliberately withheld everything. A cross-origin
 *    script error arrives as the bare message "Script error." with no filename
 *    and no stack, so it may well be ours. Labelled, NEVER dropped.
 */
export type ErrorAttribution = 'own' | 'third_party' | 'opaque';

/** One captured error, exactly as it goes over the wire. Nothing else is sent. */
export interface ClientErrorEvent {
	kind: ClientErrorKind;
	message: string;
	stack: string | null;
	route: string | null;
	/** HTTP status for `kind: 'api'`; null otherwise. */
	status: number | null;
	/** Whose code failed. See `ErrorAttribution`. */
	attribution: ErrorAttribution;
	correlation_id: string;
	ts: string;
}

export interface ClientErrorBatch {
	session_id: string;
	events: ClientErrorEvent[];
	/**
	 * `own` + `opaque` events refused by the rate cap since the last delivered
	 * batch — i.e. fr signal we could not afford to send. DISJOINT from
	 * `dropped_third_party`: conflating the two would make "fr is in a render
	 * loop" and "an extension is noisy" the same number.
	 */
	dropped: number;
	/** `third_party` events refused by the third-party cap. Noise, not signal. */
	dropped_third_party: number;
}

// --- Caps. Deliberately small: this is a smoke alarm, not an analytics pipe. --
/** Rolling window over which the event cap applies. */
export const WINDOW_MS = 60_000;
/**
 * Hard ceiling on `own` events ACCEPTED per window. Everything beyond is dropped.
 *
 * ⚠️ This budget is PER ATTRIBUTION, not shared, and that is the whole point of
 * the split. It used to be one counter for everything, which meant a browser
 * extension throwing 20 times a minute — noise fr cannot even fix — exhausted
 * the budget and the NEXT event, a real fr crash, was refused. A deliberately
 * small cap ("a smoke alarm, not an analytics pipe") is exactly the design in
 * which foreign noise is most expensive, so each class now gets its own counter
 * and no class can starve another.
 */
export const MAX_EVENTS_PER_WINDOW = 20;
/**
 * Ceiling on `opaque` (cross-origin, "Script error.") events per window.
 *
 * Smaller than `own` because an opaque event carries almost no information — no
 * message, no stack, no filename — but NOT zero, because it may be fr's and the
 * presence of a burst of them is itself the finding.
 */
export const MAX_OPAQUE_EVENTS_PER_WINDOW = 5;
/**
 * Ceiling on `third_party` events per window.
 *
 * Deliberately tiny but non-zero. Zero would be cheaper, and wrong: the case
 * that produced this code was a user pasting an extension's TypeError and asking
 * for fr to be fixed. A handful of labelled samples per minute answers that in
 * one log query; a silent drop leaves the next reader to repeat the whole
 * investigation. Over-cap third-party events are counted, not sent.
 */
export const MAX_THIRD_PARTY_EVENTS_PER_WINDOW = 3;
/** Flush as soon as the queue reaches this, so a burst doesn't wait out the debounce. */
export const MAX_QUEUE = 10;
/** Coalesce window — a single click that fails 4 calls should be one request. */
export const FLUSH_DEBOUNCE_MS = 2_000;
export const MAX_MESSAGE_CHARS = 512;
export const MAX_STACK_CHARS = 4_096;
export const MAX_ROUTE_CHARS = 256;

/**
 * The per-window ceiling for each attribution class.
 *
 * Independent buckets, not a shared pool with reservations: independence is what
 * makes "third-party noise cannot refuse an fr error" a structural property of
 * the data rather than a property of the arrival order. The worst-case total
 * (28/window) is larger than the old single 20, but the REQUEST count is
 * governed by `MAX_QUEUE` and `FLUSH_DEBOUNCE_MS`, not by the event count, so
 * the self-DoS guard the caps exist for is unaffected — and the backend's own
 * limits are 30 requests/window and 25 events/batch.
 */
export const WINDOW_CAPS: Readonly<Record<ErrorAttribution, number>> = {
	own: MAX_EVENTS_PER_WINDOW,
	opaque: MAX_OPAQUE_EVENTS_PER_WINDOW,
	third_party: MAX_THIRD_PARTY_EVENTS_PER_WINDOW
};

/** The sink's own path. Reporting a failure of the sink would loop forever. */
export const INGEST_PATH = '/api/client-errors';

// -----------------------------------------------------------------------------
// Redaction
// -----------------------------------------------------------------------------

/**
 * Patterns for credentials that can end up inside an error MESSAGE or STACK
 * even though we never deliberately send one. The commonest real case is a
 * thrown/logged URL that still carries its OAuth query parameters, and a
 * stringified fetch init that still carries its `Authorization` header.
 *
 * Ordering matters: the JWT shape is matched first so a `Bearer eyJ…` collapses
 * to one marker rather than nesting two.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
	// A JWT anywhere at all — this is what Keycloak hands us.
	[/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
	// `Authorization: Bearer <opaque>` in a stringified header bag.
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
	// key=value / key: value for anything credential-shaped, in a URL or in prose.
	[
		/\b(access_token|refresh_token|id_token|token|password|passwd|pwd|secret|client_secret|api[_-]?key|apikey|authorization|cookie|set-cookie)\b(\s*[=:]\s*)(["']?)([^\s"'&,;}]{3,})\3/gi,
		'$1$2$3[redacted]$3'
	]
];

/**
 * Scrub credential-shaped substrings. Returns '' for nullish input so a caller
 * never has to branch. This is a best-effort second line of defence — the first
 * is simply not collecting bodies, headers or cookies at all.
 */
export function redact(input: unknown): string {
	if (input === null || input === undefined) return '';
	let s = typeof input === 'string' ? input : String(input);
	for (const [pattern, replacement] of REDACTIONS) {
		// Fresh lastIndex each call: these are module-level /g regexes.
		pattern.lastIndex = 0;
		s = s.replace(pattern, replacement);
	}
	return s;
}

/**
 * Reduce a URL, path or SvelteKit route id to a bare path.
 *
 * The query string is removed BEFORE anything else: `?code=…&state=…` on the
 * OAuth return leg is exactly the kind of thing that must never be shipped, and
 * it is also exactly the moment (login/boot) we most want reports from.
 */
export function sanitizeRoute(raw: unknown): string | null {
	if (raw === null || raw === undefined || raw === '') return null;
	let s = typeof raw === 'string' ? raw : String(raw);
	const cut = s.search(/[?#]/);
	if (cut !== -1) s = s.slice(0, cut);
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
		try {
			s = new URL(s).pathname;
		} catch {
			// Unparseable — fall through with the query already stripped.
		}
	}
	s = redact(s).slice(0, MAX_ROUTE_CHARS);
	return s === '' ? '/' : s;
}

function clamp(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Pull a message + stack out of whatever was thrown (which need not be an Error). */
export function describeThrown(err: unknown): { message: string; stack: string | null } {
	if (err instanceof Error) {
		return {
			message: clamp(redact(err.message) || err.name || 'Error', MAX_MESSAGE_CHARS),
			stack: err.stack ? clamp(redact(err.stack), MAX_STACK_CHARS) : null
		};
	}
	if (err && typeof err === 'object') {
		const m = (err as { message?: unknown }).message;
		if (typeof m === 'string' && m !== '') {
			return { message: clamp(redact(m), MAX_MESSAGE_CHARS), stack: null };
		}
		let serialized: string;
		try {
			serialized = JSON.stringify(err) ?? String(err);
		} catch {
			serialized = String(err);
		}
		return { message: clamp(redact(serialized), MAX_MESSAGE_CHARS), stack: null };
	}
	return { message: clamp(redact(err) || 'Unknown error', MAX_MESSAGE_CHARS), stack: null };
}

// -----------------------------------------------------------------------------
// Attribution
// -----------------------------------------------------------------------------

/**
 * URL schemes fr can never serve a script from.
 *
 * fr is a SvelteKit app: every module it executes is fetched over the page's own
 * http(s) origin (hashed `_app/immutable/**` chunks in production, `/src/**` in
 * dev). It ships no extension, registers no privileged page, and `app.html`
 * contains no `<script src>` at all — measured, not assumed. So a frame bearing
 * one of these schemes is POSITIVE PROOF the code is not ours; this is the only
 * rule here that rests on proof rather than inference.
 */
const FOREIGN_SCHEME =
	/(?:chrome|chromium|moz|safari-web|safari|ms-browser|opera|edge)-extension:\/\/|(?:chrome|resource|webkit-masked-url):\/\//i;

/**
 * A stack frame whose SOURCE LOCATION is an injected or eval'd script — the
 * shape a content script gets when it is evaluated rather than loaded.
 *
 * ⚠️ The `:\d+` is load-bearing and not cosmetic. `<anonymous>` also appears as
 * a FUNCTION name in ordinary Node stacks (`at Object.<anonymous> (/app/x.js)`),
 * and this module is imported by node-environment tests and during SSR. Matching
 * the bare word would classify perfectly ordinary server-side stacks as foreign.
 * Only `<anonymous>:2:19429` / `VM16075:2` — a location, not a name — counts.
 */
const INJECTED_FRAME =
	/<anonymous>:\d+|\bVM\d+:\d+|\beval at |\bdata:(?:text|application)\/javascript/i;

/**
 * A frame served over the page protocol, i.e. plausibly fr's own code. Its mere
 * PRESENCE vetoes the inference rule below — if anything in the call chain came
 * off our origin, we keep the report as ours.
 */
const HTTP_FRAME = /\bhttps?:\/\//i;

/**
 * The cross-origin sentinel. When a script from another origin throws and the
 * response carried no `Access-Control-Allow-Origin`, the browser deliberately
 * replaces everything with this exact message and empties filename/lineno/stack.
 */
const OPAQUE_MESSAGE = /^script error\.?$/i;

/**
 * Decide whose code failed, from the only three things a browser gives us.
 *
 * The ordering is the whole design, and it is ordered by STRENGTH OF EVIDENCE:
 *
 *  1. An extension/privileged scheme — proof. Nothing else can produce it.
 *  2. The opaque cross-origin sentinel — proof that we know NOTHING, which is a
 *     different verdict from "not ours". It gets its own label so it stays
 *     findable and its own budget so it is never silently discarded. A blanket
 *     "no filename ⇒ drop" would throw away exactly these, and a real fr error
 *     served through a CDN or reported by an older browser lands here.
 *  3. A stack with frames but NOT ONE http(s) frame, at least one of which is an
 *     injected location — inference, and deliberately conjunctive. fr's frames
 *     always carry a URL, so "zero of our URLs anywhere in the call chain" plus
 *     "an eval'd location" is as close to proof as inference gets. This is the
 *     rule that catches the real-world case: an extension callback invoked from
 *     `requestIdleCallback` has no fr frame on the stack at all.
 *  4. Everything else is OURS. No stack, an unparseable stack, a minified chunk
 *     with unhelpful names, a thrown string, a plain object — all `own`. This
 *     default is the safety property: the function can only ever fail toward
 *     keeping a report, never toward discarding one.
 */
export function attributeError(input: {
	filename?: unknown;
	message?: unknown;
	stack?: unknown;
}): ErrorAttribution {
	const filename = typeof input.filename === 'string' ? input.filename : '';
	const stack = typeof input.stack === 'string' ? input.stack : '';
	const message = typeof input.message === 'string' ? input.message.trim() : '';

	// 1. Proof.
	if (FOREIGN_SCHEME.test(filename) || FOREIGN_SCHEME.test(stack) || FOREIGN_SCHEME.test(message)) {
		return 'third_party';
	}

	// 2. Proof of ignorance.
	if (OPAQUE_MESSAGE.test(message) && filename === '' && stack === '') return 'opaque';

	// 3. Inference, conjunctive.
	if (stack !== '' && !HTTP_FRAME.test(stack) && INJECTED_FRAME.test(stack)) return 'third_party';

	// 4. Default: ours.
	return 'own';
}

/** The raw (un-clamped, un-redacted) stack an input carries, for attribution. */
function rawStackOf(input: ReportInput): string | null {
	if (typeof input.stack === 'string') return input.stack;
	const err = input.error;
	if (err instanceof Error && typeof err.stack === 'string') return err.stack;
	if (err && typeof err === 'object') {
		const s = (err as { stack?: unknown }).stack;
		if (typeof s === 'string') return s;
	}
	return null;
}

/** The raw message an input carries, for attribution. */
function rawMessageOf(input: ReportInput): string {
	if (typeof input.message === 'string') return input.message;
	const err = input.error;
	if (err instanceof Error) return err.message;
	if (typeof err === 'string') return err;
	if (err && typeof err === 'object') {
		const m = (err as { message?: unknown }).message;
		if (typeof m === 'string') return m;
	}
	return '';
}

// -----------------------------------------------------------------------------
// Reporter
// -----------------------------------------------------------------------------

export interface ReportInput {
	kind: ClientErrorKind;
	error?: unknown;
	message?: string;
	stack?: string | null;
	route?: unknown;
	status?: number | null;
	/**
	 * `ErrorEvent.filename` — the URL of the script that threw. The single
	 * strongest attribution signal available, and previously discarded by the
	 * global handler. Absent for a promise rejection (the event has no such
	 * field), which is why the stack is inspected too.
	 */
	filename?: unknown;
}

/**
 * Accepts errors, enforces the caps, and hands whole batches to a transport.
 */
export class ClientErrorReporter {
	private readonly sessionId: string;
	private queue: ClientErrorEvent[] = [];
	private windowStart = 0;
	/**
	 * Accepted-this-window, PER ATTRIBUTION. One shared counter is the defect
	 * this replaces: third-party noise could exhaust it and the cap would then
	 * refuse a genuine fr error.
	 */
	private acceptedInWindow: Record<ErrorAttribution, number> = {
		own: 0,
		third_party: 0,
		opaque: 0
	};
	/**
	 * `own`/`opaque` events dropped since the last DELIVERED batch, so the count
	 * survives to a reader. These are lost fr signal.
	 */
	private droppedSinceFlush = 0;
	/** `third_party` events dropped since the last delivered batch. Lost noise. */
	private droppedThirdPartySinceFlush = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		this.sessionId = randomId();
		this.windowStart = Date.now();
	}

	get session_id(): string {
		return this.sessionId;
	}

	/**
	 * Record one error. Returns true if it was accepted, false if the cap
	 * dropped it — a dropped event is counted, never queued, so a runaway loop
	 * costs O(1) memory and zero extra requests.
	 */
	report(input: ReportInput): boolean {
		const now = Date.now();
		if (now - this.windowStart >= WINDOW_MS) {
			this.windowStart = now;
			this.acceptedInWindow = { own: 0, third_party: 0, opaque: 0 };
		}

		// Attribute from the RAW message/stack, before `describeThrown` clamps the
		// stack to MAX_STACK_CHARS — truncation can remove the very frame that
		// carries the evidence.
		const attribution =
			attributeError({
				filename: input.filename,
				message: rawMessageOf(input),
				stack: rawStackOf(input)
			});

		if (this.acceptedInWindow[attribution] >= WINDOW_CAPS[attribution]) {
			if (attribution === 'third_party') {
				this.droppedThirdPartySinceFlush += 1;
			} else {
				this.droppedSinceFlush += 1;
			}
			// Make sure the counter actually gets OUT. Once the window is saturated
			// the queue is typically empty, so without this a runaway loop would
			// drop silently until the window reset — indistinguishable from no
			// errors at all, which is the exact failure this module exists to end.
			// One timer covers the whole burst, so this costs at most one request.
			if (this.timer === null) {
				this.timer = setTimeout(() => {
					this.timer = null;
					this.flush();
				}, FLUSH_DEBOUNCE_MS);
			}
			return false;
		}

		const described =
			input.message !== undefined
				? {
						message: clamp(redact(input.message), MAX_MESSAGE_CHARS),
						stack: input.stack ? clamp(redact(input.stack), MAX_STACK_CHARS) : null
					}
				: describeThrown(input.error);

		this.acceptedInWindow[attribution] += 1;
		this.queue.push({
			kind: input.kind,
			message: described.message || 'Unknown error',
			stack: described.stack,
			route: sanitizeRoute(input.route),
			status: typeof input.status === 'number' ? input.status : null,
			attribution,
			correlation_id: randomId(),
			ts: new Date(now).toISOString()
		});

		if (this.queue.length >= MAX_QUEUE) {
			this.flush();
		} else if (this.timer === null) {
			this.timer = setTimeout(() => {
				this.timer = null;
				this.flush();
			}, FLUSH_DEBOUNCE_MS);
		}
		return true;
	}

	/** Ship whatever is queued. A no-op when there is nothing to say. */
	flush(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (
			this.queue.length === 0 &&
			this.droppedSinceFlush === 0 &&
			this.droppedThirdPartySinceFlush === 0
		) {
			return;
		}
		const batch: ClientErrorBatch = {
			session_id: this.sessionId,
			events: this.queue,
			dropped: this.droppedSinceFlush,
			dropped_third_party: this.droppedThirdPartySinceFlush
		};
		this.queue = [];
		this.droppedSinceFlush = 0;
		this.droppedThirdPartySinceFlush = 0;
		try {
			browserTransport(batch);
		} catch {
			// The sink failing must never escalate into a second error. The batch
			// is intentionally not re-queued: retrying into a broken sink is the
			// self-DoS this whole module exists to avoid.
		}
	}
}

// -----------------------------------------------------------------------------
// Default (browser) wiring
// -----------------------------------------------------------------------------

function randomId(): string {
	try {
		const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
		if (c?.randomUUID) return c.randomUUID();
	} catch {
		// Fall through to the arithmetic id.
	}
	return `fe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The real transport.
 *
 * `credentials: 'omit'` is the load-bearing option: it guarantees no cookie ever
 * accompanies a report, whatever the browser's default would have been. No
 * Authorization header is attached either — the ingest route is deliberately
 * unauthenticated (see the backend route) because a crash during login is
 * precisely the crash we can least afford to lose.
 */
export function browserTransport(batch: ClientErrorBatch): void {
	try {
		if (typeof fetch !== 'function') return;
		void fetch(INGEST_PATH, {
			method: 'POST',
			credentials: 'omit',
			cache: 'no-store',
			keepalive: true,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(batch)
		}).catch(() => {
			// A failed report is not itself reportable.
		});
	} catch {
		// Never let telemetry throw into the caller's path.
	}
}

const reporter: ClientErrorReporter = new ClientErrorReporter();

export function getReporter(): ClientErrorReporter {
	return reporter;
}

/** Report a thrown value (uncaught exception, rejection, or a Svelte error). */
export function reportError(
	kind: Exclude<ClientErrorKind, 'api'>,
	error: unknown,
	route?: unknown
): boolean {
	return reporter.report({ kind, error, route });
}

/**
 * Report a non-2xx API response. Called from the two shared fetch wrappers, not
 * from call sites.
 *
 * Returns false without recording when the failure IS the sink — otherwise a
 * down ingest route would generate one report per report, forever.
 */
export function reportApiFailure(args: {
	path: unknown;
	status: number;
	method?: string;
	statusText?: string;
}): boolean {
	const route = sanitizeRoute(args.path);
	if (route !== null && route.endsWith(INGEST_PATH)) return false;
	const method = (args.method ?? 'GET').toUpperCase();
	const detail = args.statusText ? ` ${args.statusText}` : '';
	return reporter.report({
		kind: 'api',
		message: `HTTP ${args.status}${detail} on ${method} ${route ?? 'unknown'}`,
		stack: null,
		route,
		status: args.status
	});
}

/**
 * Attach the two global browser handlers. Idempotent, and a no-op off-browser so
 * importing this during SSR is safe.
 */
let installed = false;
export function installGlobalErrorReporting(target?: {
	addEventListener: (t: string, cb: (e: unknown) => void) => void;
	location?: { pathname?: string };
}): boolean {
	const w =
		target ??
		(typeof window !== 'undefined'
			? (window as unknown as {
					addEventListener: (t: string, cb: (e: unknown) => void) => void;
					location?: { pathname?: string };
				})
			: undefined);
	if (!w || typeof w.addEventListener !== 'function') return false;
	if (target === undefined && installed) return false;
	if (target === undefined) installed = true;

	const currentRoute = () => {
		try {
			return w.location?.pathname ?? null;
		} catch {
			return null;
		}
	};

	w.addEventListener('error', (e: unknown) => {
		const ev = e as { error?: unknown; message?: unknown; filename?: unknown };
		// `filename` is the URL of the script that threw and is the strongest
		// attribution signal the browser offers. It was previously read and
		// discarded here, which is why an extension's TypeError was reported as
		// fr's own.
		getReporter().report({
			kind: 'uncaught',
			error: ev?.error ?? ev?.message ?? 'Unknown error',
			route: currentRoute(),
			filename: ev?.filename
		});
	});
	w.addEventListener('unhandledrejection', (e: unknown) => {
		// A `PromiseRejectionEvent` has no `filename`; the reason's stack is the
		// only signal, and `attributeError` reads it.
		const ev = e as { reason?: unknown };
		reportError('unhandledrejection', ev?.reason ?? 'Unhandled rejection', currentRoute());
	});
	return true;
}
