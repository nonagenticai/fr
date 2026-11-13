import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';

// vite.config.ts runs under Node; svelte-check doesn't include @types/node.
declare const process: { env: Record<string, string | undefined> };

// Dev-only backend proxy. Production uses frontend/server.js which owns the
// same forwarding rule. Without this, `npm run dev` has no way to reach the
// Bun backend running on PORT=8888.
//
// `FR_BACKEND_URL=none` means "there is NO backend": no proxy is installed and
// every /api/* request is answered right here with an empty 502 — the exact
// response the proxy gives when nothing listens on the target (ECONNREFUSED),
// which is what a CI runner sees. The mocked Playwright lane sets it
// (playwright.config.ts). Without it the lane proxied every UNSTUBBED call to
// localhost:8888, and on a dev box another worktree's backend often holds that
// port. A backend that accepts and never answers leaves those requests pending;
// Chrome allows 6 sockets per host, so the NEXT page.goto's document request
// queues behind them and never loads (measured 2026-10-17:
// research-screening.spec.ts:4141, "page.goto: net::ERR_ABORTED" after the
// test timeout, green in CI, red on devbox).
const backend = process.env.FR_BACKEND_URL || 'http://localhost:8888';
const NO_BACKEND = backend === 'none';

/** Header the no-backend responder stamps, so a spec can prove the lane is hermetic. */
const NO_BACKEND_HEADER = 'x-fr-no-backend';

function noBackend(): Plugin {
	return {
		name: 'fr-no-backend',
		configureServer(server) {
			// Registered before vite's own middlewares, so no proxy or app route sees /api/*.
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith('/api/')) return next();
				res.writeHead(502, { 'Content-Type': 'text/plain', [NO_BACKEND_HEADER]: '1' }).end();
			});
			// WebSocket upgrades to /api/* would otherwise get no handler and hang.
			server.httpServer?.on('upgrade', (req, socket) => {
				if (req.url?.startsWith('/api/')) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
			});
		}
	};
}

const proxy: Record<string, ProxyOptions> | undefined = NO_BACKEND
	? undefined
	: {
			// Forward all backend API traffic, including WebSocket upgrades, to
			// the Bun backend. The frontend no longer owns any service-specific
			// /api proxies.
			'^/api/': {
				target: backend,
				changeOrigin: true,
				ws: true
			}
		};

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), ...(NO_BACKEND ? [noBackend()] : [])],
	server: { proxy }
});
