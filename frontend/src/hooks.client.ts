import type { HandleClientError } from '@sveltejs/kit/hooks';
import { version } from '$app/env';
import { installGlobalErrorReporting, reportError } from '$lib/telemetry/client-errors';

// Attach window.onerror + unhandledrejection once, at client boot. Module scope
// (not onMount) so an error thrown before any component mounts is still caught.
// No-ops off-browser, so importing this during SSR is safe.
installGlobalErrorReporting();

// Deploy-resilience (D5 bundle). fr ships retire-first (a single-replica pod on a
// CPU-saturated node), so during a roll an open tab's lazily-loaded route chunks
// 404/503 on the now-gone immutable hashes → "Failed to fetch dynamically
// imported module". +layout.svelte's beforeNavigate handles the case where a NEW
// build is detected before navigation; this hook covers the in-place failure
// (the poller hasn't ticked yet): reload ONCE to fetch the fresh index+chunks.
//
// "Once" is per BUILD VERSION per session (sessionStorage keyed on the running
// bundle's `$app/environment` version). It used to be a 10 s time cooldown,
// which is a loop with a period: a chunk that is genuinely missing from the
// build reloaded the tab every ~10 s forever. Now a version that has already
// reloaded never reloads again; a NEW build (a later deploy) gets its own one.

const RELOADED_VERSION_KEY = 'fr:chunk-reload-version';

/** A lazy route/module chunk failing to load (the post-deploy stale-hash symptom). */
export function isDynamicImportError(err: unknown): boolean {
	const msg =
		err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '');
	return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
		msg
	);
}

/**
 * Claim this version's one reload. Returns false when storage is unavailable
 * (private mode, blocked site data): without a durable marker a reload could
 * loop, so the error is surfaced instead.
 */
function claimReload(buildVersion: string): boolean {
	try {
		const store = window.sessionStorage;
		if (store.getItem(RELOADED_VERSION_KEY) === buildVersion) return false;
		store.setItem(RELOADED_VERSION_KEY, buildVersion);
		// Read back: a storage that silently drops writes would otherwise reload
		// on every error, i.e. loop.
		return store.getItem(RELOADED_VERSION_KEY) === buildVersion;
	} catch {
		return false;
	}
}

export const handleError: HandleClientError = ({ kind, error, event }) => {
	try {
		if (typeof window !== 'undefined' && isDynamicImportError(error) && claimReload(version)) {
			window.location.reload();
			// Deliberately NOT reported: this is the expected post-deploy stale-chunk
			// symptom and we are already fixing it by reloading. Reporting it would
			// put one event per open tab per deploy into the sink and drown the real
			// bugs. A chunk error on a version that ALREADY reloaded is genuinely
			// broken and does fall through to the report below.
			return { message: 'Updating…' };
		}
	} catch {
		// location unavailable (SSR) — fall through.
	}

	// SvelteKit's seam for every uncaught load + render error. Prefer the route
	// ID (`/projects/[id]`) over the concrete pathname: it is already free of
	// the ids and slugs a real URL carries.
	reportError('svelte', error, event?.route?.id ?? event?.url?.pathname ?? null);

	// Kit 3 dropped the merged `message` field: the caught error carries its own
	// safe message only for framework errors (404s etc.); app/unknown errors keep
	// SvelteKit's default by returning nothing.
	return kind === 'framework' ? { message: error.message } : undefined;
};
