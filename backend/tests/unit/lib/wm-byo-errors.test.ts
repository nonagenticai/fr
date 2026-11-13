// worker_management BYO error contract → user sentences (owner ruling
// 2026-10-01). Both wire shapes: the JSON envelope and the SSE error frame.
import { describe, expect, test } from 'bun:test';
import {
  WM_BYO_ERROR_CODES,
  wmByoErrorFromBody,
  wmByoErrorFromIntegrationError,
  wmByoUserMessage,
} from '../../../src/lib/wm-byo-errors';
import { IntegrationError } from '../../../src/integrations/_lib/errors';

const TENANT = '0195f48b-d000-7000-8000-0000000003a1';

describe('wmByoErrorFromBody', () => {
  test('reads the JSON envelope', () => {
    const e = wmByoErrorFromBody({
      error: {
        code: 'BYO_KEY_UNUSABLE',
        message: `Tenant ${TENANT} ...`,
        status: 409,
        details: { tenant_id: TENANT, provider: 'anthropic', tier: 'high' },
      },
    });
    expect(e?.code).toBe('BYO_KEY_UNUSABLE');
    expect(e?.status).toBe(409);
    expect(e?.message).toContain('anthropic');
    expect(e?.message).toContain('high tier');
    expect(e?.message).toContain('Settings → LLM provider');
    expect(e?.message).not.toContain(TENANT);
  });

  test('reads the SSE error frame (error is a string, code beside it)', () => {
    const e = wmByoErrorFromBody({
      error: 'openai rejected …',
      error_code: 'BYO_PROVIDER_CALL_FAILED',
      status: 502,
      provider: 'openai',
    });
    expect(e?.code).toBe('BYO_PROVIDER_CALL_FAILED');
    expect(e?.status).toBe(502);
    expect(e?.message).toContain('openai rejected the request');
  });

  test('MODEL_NOT_AVAILABLE_TO_TENANT names the model', () => {
    const e = wmByoErrorFromBody({
      error: { code: 'MODEL_NOT_AVAILABLE_TO_TENANT', status: 403, details: { model: 'gpt-x' } },
    });
    expect(e?.message).toContain("'gpt-x'");
  });

  test('anything else is not a BYO error', () => {
    expect(wmByoErrorFromBody({ error: { code: 'VALIDATION_ERROR' } })).toBeNull();
    expect(wmByoErrorFromBody({ error: 'boom' })).toBeNull();
    expect(wmByoErrorFromBody('nope')).toBeNull();
    expect(wmByoErrorFromBody(null)).toBeNull();
  });

  test('every code has a non-empty sentence', () => {
    for (const code of WM_BYO_ERROR_CODES) expect(wmByoUserMessage(code).length).toBeGreaterThan(20);
  });
});

test('wmByoErrorFromIntegrationError reads the upstream body and status', () => {
  const err = new IntegrationError({
    code: 'UPSTREAM_FORBIDDEN',
    message: 'worker_management POST /workers/x/message returned 403',
    service: 'worker_management',
    upstreamStatus: 403,
    upstreamBody: { error: { code: 'BYO_PROVIDER_NOT_CONFIGURED', details: { provider: 'mistral' } } },
  });
  const e = wmByoErrorFromIntegrationError(err);
  expect(e?.code).toBe('BYO_PROVIDER_NOT_CONFIGURED');
  expect(e?.status).toBe(403);
  expect(e?.message).toContain('mistral');
  expect(wmByoErrorFromIntegrationError(new Error('x'))).toBeNull();
});

// fr BYO validator D3: WM's 402 for a commercial tenant with no provider row.
// WM raises `HTTPException(402, detail={code:"byo_llm_not_configured", message})`
// and its handler renders 402 (absent from its status→code map) as code
// "ERROR" with the dict as `message` — the code is NESTED. Both that live wire
// shape and FastAPI's bare `detail` rendering must map.
describe('402 byo_llm_not_configured', () => {
  const WIRE_402 = {
    error: {
      code: 'ERROR',
      message: {
        code: 'byo_llm_not_configured',
        message: 'Configure your LLM provider in Settings before running agents.',
      },
      status: 402,
    },
  };

  test('the live WM envelope (code nested in message) maps', () => {
    const e = wmByoErrorFromBody(WIRE_402);
    expect(e?.code).toBe('byo_llm_not_configured');
    expect(e?.status).toBe(402);
    expect(e?.message).toContain('Settings → LLM provider');
  });

  test("FastAPI's bare detail rendering maps", () => {
    const e = wmByoErrorFromBody({
      detail: { code: 'byo_llm_not_configured', message: 'Configure your LLM provider…' },
    });
    expect(e?.code).toBe('byo_llm_not_configured');
  });

  test('an IntegrationError carrying the 402 maps, with the upstream status', () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_BYO_NOT_CONFIGURED',
      message: 'worker_management POST /workers/x/message returned 402',
      service: 'worker_management',
      upstreamStatus: 402,
      upstreamBody: { error: { ...WIRE_402.error, status: undefined } },
    });
    const e = wmByoErrorFromIntegrationError(err);
    expect(e?.code).toBe('byo_llm_not_configured');
    expect(e?.status).toBe(402);
  });

  test('details carry only provider/tier/model, never the tenant id', () => {
    const e = wmByoErrorFromBody({
      error: {
        code: 'BYO_KEY_UNUSABLE',
        status: 409,
        details: { tenant_id: TENANT, provider: 'anthropic', tier: 'high', reason: 'decrypt_failed' },
      },
    });
    expect(e?.details).toEqual({ provider: 'anthropic', tier: 'high' });
  });
});
