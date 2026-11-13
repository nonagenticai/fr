import { describe, expect, test } from 'bun:test';
import {
  IntegrationError,
  integrationErrorResponse,
} from '../../../src/integrations/_lib/errors';

describe('integrationErrorResponse — BYO LLM hard-fail', () => {
  test('surfaces byo_llm_not_configured code + upstream message at 402', async () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_BYO_NOT_CONFIGURED',
      message: 'worker_management POST /workers/x/message returned 402',
      service: 'worker_management',
      upstreamStatus: 402,
      upstreamBody: {
        code: 'byo_llm_not_configured',
        message: 'Configure your LLM provider in Settings before running agents.',
      },
    });

    const res = integrationErrorResponse(err);
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      error: { code: string; message: string; upstream?: { status: number } };
    };
    expect(body.error.code).toBe('byo_llm_not_configured');
    expect(body.error.message).toContain('Configure your LLM provider');
    expect(body.error.upstream?.status).toBe(402);
  });

  test('falls back to a default actionable message when the body lacks one', async () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_BYO_NOT_CONFIGURED',
      message: 'returned 402',
      service: 'worker_management',
      upstreamStatus: 402,
      upstreamBody: undefined,
    });

    const res = integrationErrorResponse(err);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('byo_llm_not_configured');
    expect(body.error.message.toLowerCase()).toContain('provider');
  });

  test('accepts a nested { error: { message } } envelope shape', async () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_BYO_NOT_CONFIGURED',
      message: 'returned 402',
      service: 'coding-ai',
      upstreamStatus: 402,
      upstreamBody: { error: { code: 'byo_llm_not_configured', message: 'Set up your provider.' } },
    });

    const res = integrationErrorResponse(err);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Set up your provider.');
  });
});
