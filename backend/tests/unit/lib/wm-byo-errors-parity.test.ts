// The BYO error table exists twice: `backend/src/lib/wm-byo-errors.ts`
// (agent loop, the worker routes) and `frontend/src/lib/workers/wm-errors.ts`
// (/chat, the Workers test console). A code mapped on one side only renders as
// a sentence in one surface and as raw JSON in the other (fr BYO validator D3:
// `byo_llm_not_configured` was in neither). This pins the two tables EQUAL —
// the same codes, and the same sentence for the same wire body.
//
// The frontend module is pure TS with no `$lib` imports, so Bun loads it
// directly. Imported by computed URL so the backend `tsc` program does not pull
// a frontend file into its compilation.
import { describe, expect, test } from 'bun:test';
import * as be from '../../../src/lib/wm-byo-errors';

const FRONTEND = new URL('../../../../frontend/src/lib/workers/wm-errors.ts', import.meta.url).href;
const fe = (await import(FRONTEND)) as {
  WM_BYO_ERROR_CODES: readonly string[];
  wmByoUserMessage: (code: string, details?: Record<string, unknown>) => string;
  wmByoErrorMessage: (body: unknown) => string | null;
};

const TENANT = '0195f48b-d000-7000-8000-0000000003a1';

const DETAIL_VARIANTS: Array<Record<string, unknown>> = [
  {},
  { provider: 'openai' },
  { provider: 'anthropic', tier: 'high' },
  { provider: 'groq', tier: 'default' },
  { model: 'gpt-x' },
];

/** Every wire shape either side is expected to read, plus non-BYO controls. */
const BODIES: unknown[] = [
  ...be.WM_BYO_ERROR_CODES.flatMap((code) => [
    { error: { code, status: 403, details: { tenant_id: TENANT, provider: 'mistral', tier: 'low' } } },
    { error: 'raw', error_code: code, status: 502, provider: 'groq' },
    { error: { code: 'ERROR', message: { code, message: 'x' }, status: 402 } },
    { detail: { code, message: 'x' } },
  ]),
  { error: { code: 'FORBIDDEN', message: 'nope' } },
  { error: 'boom' },
  { detail: 'Not Found' },
  null,
  'text',
];

describe('backend and frontend BYO error tables are identical', () => {
  test('same codes, same order', () => {
    expect([...fe.WM_BYO_ERROR_CODES]).toEqual([...be.WM_BYO_ERROR_CODES]);
  });

  test('byo_llm_not_configured (WM 402) is in the table', () => {
    expect(be.WM_BYO_ERROR_CODES).toContain('byo_llm_not_configured');
  });

  test('same sentence for every code × detail variant', () => {
    for (const code of be.WM_BYO_ERROR_CODES) {
      for (const d of DETAIL_VARIANTS) {
        expect(fe.wmByoUserMessage(code, d)).toBe(be.wmByoUserMessage(code, d));
      }
    }
  });

  test('same reading of every wire body', () => {
    for (const body of BODIES) {
      expect(fe.wmByoErrorMessage(body)).toBe(be.wmByoErrorFromBody(body)?.message ?? null);
    }
  });

  test("the frontend reads the backend's /message envelope to the backend's sentence", () => {
    // What `routes/assets/workers.ts::handleWm` sends the browser.
    for (const code of be.WM_BYO_ERROR_CODES) {
      const wm = be.wmByoErrorFromBody({
        error: { code, status: 409, details: { tenant_id: TENANT, provider: 'openai', tier: 'high', model: 'm' } },
      });
      expect(wm).not.toBeNull();
      const relayed = { error: { code: wm!.code, message: wm!.message, details: wm!.details } };
      expect(fe.wmByoErrorMessage(relayed)).toBe(wm!.message);
    }
  });
});
