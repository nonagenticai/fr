// src/middleware/cors.ts
import { config } from '../config';

/**
 * CORS headers for `origin`. Only an origin on the allow-list is echoed back;
 * any other (or absent) Origin gets NO CORS headers. The old fallback to
 * `origins[0]` stamped `Access-Control-Allow-Origin: http://localhost:3000` on
 * every production response, whatever the caller's Origin.
 */
export function corsHeaders(origin?: string | null): Record<string, string> {
  if (!origin || !config.cors.origins.includes(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  };
}

export function handleCorsOptions(req: Request): Response {
  const origin = req.headers.get('Origin');
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}
