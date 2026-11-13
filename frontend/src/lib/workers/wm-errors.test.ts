// worker_management BYO error codes → user sentences (owner ruling 2026-10-01).
import { describe, expect, it } from 'vitest';
import {
  chatHttpErrorText,
  wmByoErrorMessage,
  wmHttpErrorText,
  WM_BYO_ERROR_CODES,
  wmByoUserMessage,
  neutralHttpErrorText,
  SEND_ERROR_TEXT,
} from './wm-errors';

const TENANT = '0195f48b-d000-7000-8000-0000000003a1';

describe('wmByoErrorMessage', () => {
  it('maps the JSON envelope', () => {
    const msg = wmByoErrorMessage({
      error: {
        code: 'BYO_KEY_WITHHELD',
        message: `Tenant ${TENANT} … X-End-User-Token`,
        status: 403,
        details: { tenant_id: TENANT, provider: 'openai', tier: 'medium' },
      },
    });
    expect(msg).toContain('openai');
    expect(msg).toContain('sign in again');
    expect(msg).not.toContain(TENANT);
  });

  it('maps the SSE frame (error string + error_code beside it)', () => {
    expect(
      wmByoErrorMessage({ error: 'raw', error_code: 'BYO_PROVIDER_CALL_FAILED', status: 502, provider: 'groq' }),
    ).toContain('groq rejected the request');
  });

  it('returns null for non-BYO bodies', () => {
    expect(wmByoErrorMessage({ error: { code: 'FORBIDDEN', message: 'x' } })).toBeNull();
    expect(wmByoErrorMessage({ error: 'x' })).toBeNull();
    expect(wmByoErrorMessage(undefined)).toBeNull();
  });

  it('has a sentence for every code', () => {
    for (const c of WM_BYO_ERROR_CODES) expect(wmByoUserMessage(c).length).toBeGreaterThan(20);
  });
});

describe('chatHttpErrorText', () => {
  it('uses the BYO sentence for a WM envelope', () => {
    const raw = JSON.stringify({
      error: { code: 'MODEL_NOT_AVAILABLE_TO_TENANT', status: 403, details: { model: 'gpt-x' } },
    });
    expect(chatHttpErrorText(403, raw)).toBe(
      "Model 'gpt-x' is not available to this workspace. Pick another model.",
    );
  });
  // fr#1409: anything that is not a BYO sentence is neutral copy — never the
  // status, the envelope's operator message or the raw body.
  it('is neutral for a non-BYO envelope (no status, no upstream message)', () => {
    const text = chatHttpErrorText(403, JSON.stringify({ error: { code: 'FORBIDDEN', message: 'workspace-admin role required' } }));
    expect(text).toBe(SEND_ERROR_TEXT);
    expect(text).not.toContain('403');
    expect(text).not.toContain('workspace-admin role required');
  });
  it('is neutral for a raw non-JSON body', () => {
    const text = chatHttpErrorText(502, 'no healthy upstream');
    expect(text).toBe(SEND_ERROR_TEXT);
    expect(text).not.toContain('502');
    expect(text).not.toContain('upstream');
  });
});

// fr BYO validator D3: WM's 402 `byo_llm_not_configured`. Three wire shapes:
// fr's relayed envelope (code at error.code), WM's own envelope (code nested in
// error.message, because WM raises it with a dict `detail`), and FastAPI's bare
// `detail` rendering.
describe('402 byo_llm_not_configured', () => {
  const SENTENCE = wmByoUserMessage('byo_llm_not_configured');

  it('is in the table', () => {
    expect(WM_BYO_ERROR_CODES).toContain('byo_llm_not_configured');
    expect(SENTENCE).toContain('Settings → LLM provider');
  });

  it("maps fr's relayed envelope", () => {
    expect(
      wmByoErrorMessage({ error: { code: 'byo_llm_not_configured', message: 'Configure your LLM provider…' } }),
    ).toBe(SENTENCE);
  });

  it("maps WM's envelope with the code nested in message", () => {
    expect(
      wmByoErrorMessage({
        error: { code: 'ERROR', message: { code: 'byo_llm_not_configured', message: 'x' }, status: 402 },
      }),
    ).toBe(SENTENCE);
  });

  it("maps FastAPI's bare detail", () => {
    expect(wmByoErrorMessage({ detail: { code: 'byo_llm_not_configured', message: 'x' } })).toBe(SENTENCE);
  });
});

describe('wmHttpErrorText (Workers test console)', () => {
  it('renders a relayed BYO refusal as the sentence, with its details', () => {
    const raw = JSON.stringify({
      error: {
        code: 'BYO_KEY_UNUSABLE',
        message: 'x',
        details: { provider: 'anthropic', tier: 'high' },
      },
    });
    expect(wmHttpErrorText(409, raw)).toBe(wmByoUserMessage('BYO_KEY_UNUSABLE', { provider: 'anthropic', tier: 'high' }));
  });
  it('renders a 402 as the sentence, not the raw JSON', () => {
    const raw = JSON.stringify({ error: { code: 'byo_llm_not_configured', message: 'Configure…' } });
    expect(wmHttpErrorText(402, raw)).toBe(wmByoUserMessage('byo_llm_not_configured'));
  });
  it('renders the backend 424 relay of a BYO 5xx (BYO_PROVIDER_CALL_FAILED) as the sentence', () => {
    // fr maps WM's 502 to 424 so Cloudflare keeps the body (validator round 2, R2).
    const raw = JSON.stringify({
      error: {
        code: 'BYO_PROVIDER_CALL_FAILED',
        message: wmByoUserMessage('BYO_PROVIDER_CALL_FAILED', { provider: 'openai' }),
        details: { provider: 'openai' },
      },
    });
    expect(wmHttpErrorText(424, raw)).toBe(wmByoUserMessage('BYO_PROVIDER_CALL_FAILED', { provider: 'openai' }));
  });
  it('is neutral for a non-BYO envelope (fr#1409)', () => {
    expect(wmHttpErrorText(403, JSON.stringify({ error: { code: 'UPSTREAM_FORBIDDEN', message: 'You do not have access to this' } }))).toBe(
      SEND_ERROR_TEXT,
    );
  });
});

describe('neutralHttpErrorText (fr#1409)', () => {
  it('returns the BYO sentence when WM sent one', () => {
    const raw = JSON.stringify({ error: { code: 'byo_llm_not_configured', message: 'x' } });
    expect(neutralHttpErrorText('fallback', raw)).toBe(wmByoUserMessage('byo_llm_not_configured'));
  });
  it('returns the caller fallback for anything else', () => {
    expect(neutralHttpErrorText('fallback', '<html>502 Bad Gateway</html>')).toBe('fallback');
    expect(neutralHttpErrorText('fallback', '')).toBe('fallback');
  });
});
