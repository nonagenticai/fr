// fr-agui P4d-1 — which KAG routes read a JSON body (and so can answer the declared 400).
//
// ⛔ Side-effect free (define.ts): zod only.
import { z } from 'zod';

import type { HttpMethod } from '../define';

/** `readJsonBody`'s refusal (routes/_lib/request.ts): an IntegrationError BAD_REQUEST, `{ error: { code, message } }`. */
export const KAG_INVALID_JSON_400 = {
  status: 400,
  description:
    "The body is not JSON: `error.code` 'BAD_REQUEST', `error.message` 'Invalid JSON request body' (nothing is sent to KAG).",
  schema: z.object({ error: z.object({ code: z.literal('BAD_REQUEST'), message: z.string() }) }),
};

/**
 * Does the route read a JSON body? A body method whose input lists a key that is not a
 * path parameter, or admits any key (`.passthrough()`, forwarded verbatim). The rest
 * (cancel / resume / pause / retry / clear) never read theirs.
 */
export function kagReadsJsonBody(method: HttpMethod, path: string, input: z.ZodTypeAny): boolean {
  if (method === 'GET' || method === 'DELETE') return false;
  const params = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
  let s: z.ZodTypeAny = input;
  for (let i = 0; i < 8; i += 1) {
    const def = (s as unknown as { _def: { typeName?: string; schema?: z.ZodTypeAny; innerType?: z.ZodTypeAny; unknownKeys?: string } })._def;
    if (def.typeName === 'ZodObject') {
      const keys = Object.keys((s as z.AnyZodObject).shape).filter((k) => !params.includes(k));
      return keys.length > 0 || def.unknownKeys === 'passthrough';
    }
    const inner = def.schema ?? def.innerType;
    if (inner === undefined) return false;
    s = inner;
  }
  return false;
}
