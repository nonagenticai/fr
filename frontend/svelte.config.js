import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		// RM's generated client (backend + frontend share it). The frontend imports
		// TYPES ONLY from it (`import type`): the Docker build context is frontend/,
		// so a value import would not resolve there.
		alias: {
			'@fr/service-client-requirements': '../packages/service-clients/requirements/src/index.ts'
		},
		adapter: adapter({
			out: 'build'
		}),
		// Poll for a new deployment so the client's `updated` store flips when the
		// server ships a new build. fr rolls retire-first (a single-replica pod on a
		// CPU-saturated node → a brief 503 window per deploy, by design), so an open
		// tab holds stale immutable chunk hashes; detecting the new version lets us
		// force a full reload on next navigation instead of "failed to fetch
		// dynamically imported module". See +layout.svelte (beforeNavigate) and
		// hooks.client.ts (handleError).
		version: {
			pollInterval: 60_000
		}
	}
};

export default config;
