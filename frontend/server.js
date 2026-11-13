// Custom Node server: wraps SvelteKit's adapter-node handler and proxies /api/*
// HTTP + WebSocket upgrade traffic to fr-backend via cluster DNS. The browser
// only ever talks to fr-frontend; fr-backend has no public hostname.
import http from "node:http";
import httpProxy from "http-proxy-3";
import { handler } from "./build/handler.js";

const PORT = Number(process.env.PORT || 3000);
const BACKEND = process.env.FR_BACKEND_URL || "http://localhost:8888";

const proxy = httpProxy.createProxyServer({
	target: BACKEND,
	changeOrigin: true,
	ws: true,
	xfwd: true,
});

proxy.on("error", (err, req, res) => {
	console.error(`[proxy] ${req?.url}: ${err.message}`);
	if (res && "writeHead" in res && !res.headersSent) {
		res.writeHead(502, { "content-type": "text/plain" });
		res.end("Bad Gateway");
	} else if (res && "destroy" in res) {
		res.destroy();
	}
});

const server = http.createServer((req, res) => {
	if (req.url && req.url.startsWith("/api/")) {
		proxy.web(req, res);
		return;
	}
	handler(req, res);
});

server.on("upgrade", (req, socket, head) => {
	if (req.url && req.url.startsWith("/api/")) {
		proxy.ws(req, socket, head);
	} else {
		socket.destroy();
	}
});

server.listen(PORT, () => {
	console.log(
		`fr-frontend on :${PORT} — proxying /api/* (HTTP+WS) to ${BACKEND}`,
	);
});
