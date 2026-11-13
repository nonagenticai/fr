// Coverage for the shared fr-backend error formatter.
//
// This exists because /admin/pricing showed an operator a raw
// JSON.stringify of the whole error envelope when billing rejected a markup
// rule — the one sentence explaining what to fix was in there, unreadable, and
// the toast auto-dismissed after 5s.
//
// Two upstream services, two DIFFERENT bodies, both must render:
//   - billing_service replaces FastAPI's validation body in its own handler
//     (src/main.py:481-495) → { error: { code, message, details? } }, NO
//     `detail` key. BILLING_422_LIVE below is the envelope captured verbatim
//     off the deployed pod on 2026-08-11.
//   - stock FastAPI (worker_management) → { detail: string | [{loc,msg,type}] }.
//     The string path is llm-provider.ts's pre-existing behaviour and must not
//     change; the array path used to be JSON.stringify'd.

import { describe, expect, it } from 'vitest';
import { apiErrorMessage, formatApiError } from './api-error';

/** Wrap an upstream body the way backend/integrations/_lib/errors.ts does. */
function envelope(upstreamBody: unknown, status = 422): unknown {
  return {
    error: {
      code: 'UPSTREAM_BAD_STATUS',
      message: `pricing-admin POST /api/config/markup-rules returned ${status}`,
      service: 'pricing-admin',
      upstream: { status, body: upstreamBody },
    },
  };
}

// Captured live from deployed billing, 2026-08-11 — note there is no `detail`
// key and no `details` key: LEAK_EXCEPTION_DETAILS is false in production, so
// the field-level errors are computed and dropped.
const BILLING_422_LIVE = {
  error: {
    code: 'UPSTREAM_BAD_STATUS',
    message: 'pricing-admin POST /api/config/markup-rules returned 422',
    service: 'pricing-admin',
    upstream: {
      status: 422,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          status: 422,
          request_id: '019ff099-b8c8-770f-a84c-94019154d872',
          timestamp: '2026-08-11T11:33:53.994175Z',
        },
      },
    },
  },
};

// VERBATIM from a real request through billing after its validation-handler fix
// (billing commit aa97f3e): `details` is always an array whose every element has
// exactly {field, message, type}, all strings, always present. `field === ''` is
// the CONTRACT for a model-level error — never an absent key — so the renderer
// must branch on emptiness, not on `'field' in x`.
const BILLING_MODEL_LEVEL = {
  error: {
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    status: 422,
    request_id: '019ff0a6-0bc0-7535-a46f-b7393ea92dbf',
    timestamp: '2026-08-11T11:47:21.670234Z',
    details: [
      {
        field: '',
        message:
          "Value error, a markup rule must set at least one economic field: 'markup_pct' or one of 'surcharge_input_per_1m_usd', 'surcharge_output_per_1m_usd', 'surcharge_cache_creation_per_1m_usd', 'surcharge_cache_read_per_1m_usd', 'surcharge_per_request_usd'; all are null, so this rule would price nothing while closing the currently-open rule for the same match tuple",
        type: 'value_error',
      },
    ],
  },
};

const BILLING_FIELD_LEVEL = {
  error: {
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    status: 422,
    request_id: '019ff0a6-0bc0-7535-a46f-b7393ea92dbe',
    timestamp: '2026-08-11T11:47:21.670234Z',
    details: [
      {
        field: 'surcharge_input_per_1m_usd',
        message: 'Input should be greater than or equal to 0',
        type: 'greater_than_equal',
      },
    ],
  },
};

const BODY_LEVEL_MSG =
  "Value error, a markup rule must set at least one economic field: 'markup_pct' or one of " +
  "'surcharge_input_per_1m_usd', 'surcharge_output_per_1m_usd'; all are null, so this rule " +
  'would price nothing while closing the currently-open rule for the same match tuple';

describe('formatApiError — the LIVE billing 422 contract (verbatim fixtures)', () => {
  it('renders the model-level rule as JUST the message, prefix stripped, no stray colon', () => {
    const msg = formatApiError(envelope(BILLING_MODEL_LEVEL), 'fallback');
    // `field: ''` with a naive `${field}: ${message}` template would emit a
    // leading ": " — that is the case that actually fires on this page.
    expect(msg.startsWith(':')).toBe(false);
    expect(msg).not.toContain(': Value error');
    expect(msg).toBe(
      "a markup rule must set at least one economic field: 'markup_pct' or one of 'surcharge_input_per_1m_usd', 'surcharge_output_per_1m_usd', 'surcharge_cache_creation_per_1m_usd', 'surcharge_cache_read_per_1m_usd', 'surcharge_per_request_usd'; all are null, so this rule would price nothing while closing the currently-open rule for the same match tuple",
    );
  });

  it('renders the field-level rule as "field: message" (verbatim fixture)', () => {
    expect(formatApiError(envelope(BILLING_FIELD_LEVEL), 'fallback')).toBe(
      'surcharge_input_per_1m_usd: Input should be greater than or equal to 0',
    );
  });

  it('shows the truncation sentinel rather than swallowing it', () => {
    const msg = formatApiError(
      envelope({
        error: {
          message: 'Request validation failed',
          details: [
            { field: 'markup_pct', message: 'Input should be a valid decimal', type: 'decimal' },
            {
              field: '',
              type: 'too_many_errors',
              message: '4 further validation error(s) were suppressed; showing the first 20.',
            },
          ],
        },
      }),
      'fallback',
    );
    expect(msg).toBe(
      'markup_pct: Input should be a valid decimal; ' +
        '4 further validation error(s) were suppressed; showing the first 20.',
    );
  });

  it('keeps a non-body loc prefix intact (billing strips only a leading "body")', () => {
    expect(
      formatApiError(
        envelope({ error: { details: [{ field: 'query.n', message: 'bad', type: 'int_parsing' }] } }),
        'fb',
      ),
    ).toBe('query.n: bad');
    expect(
      formatApiError(
        envelope({ error: { details: [{ field: 'ids.3.name', message: 'bad', type: 'x' }] } }),
        'fb',
      ),
    ).toBe('ids.3.name: bad');
  });
});

describe('formatApiError — billing envelope (error.details / error.message)', () => {
  it('renders billing sanitised details as "field: message"', () => {
    const msg = formatApiError(
      envelope({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: [
            {
              field: 'surcharge_input_per_1m_usd',
              message: 'Input should be greater than or equal to 0',
              type: 'greater_than_equal',
            },
          ],
        },
      }),
      'fallback',
    );
    expect(msg).toBe('surcharge_input_per_1m_usd: Input should be greater than or equal to 0');
  });

  it('renders a body-level detail (no field) as the bare message, Pydantic prefix stripped', () => {
    const msg = formatApiError(
      envelope({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: [{ field: '', message: BODY_LEVEL_MSG, type: 'value_error' }],
        },
      }),
      'fallback',
    );
    expect(msg.startsWith('a markup rule must set at least one economic field')).toBe(true);
    expect(msg).not.toContain('Value error,');
  });

  it('joins several detail entries with "; "', () => {
    const msg = formatApiError(
      envelope({
        error: {
          details: [
            { field: 'markup_pct', message: 'Input should be less than or equal to 1000' },
            { field: 'surcharge_output_per_1m_usd', message: 'Input should be a valid decimal' },
          ],
        },
      }),
      'fallback',
    );
    expect(msg).toBe(
      'markup_pct: Input should be less than or equal to 1000; ' +
        'surcharge_output_per_1m_usd: Input should be a valid decimal',
    );
  });

  it('falls back to billing error.message when details are withheld (the LIVE body)', () => {
    expect(formatApiError(BILLING_422_LIVE, 'fallback')).toBe('Request validation failed');
    // and never leaks the envelope itself
    expect(formatApiError(BILLING_422_LIVE, 'fallback')).not.toContain('{');
  });
});

describe('formatApiError — stock FastAPI detail', () => {
  it('renders an ARRAY detail field error as "field: msg"', () => {
    const msg = formatApiError(
      envelope({
        detail: [
          {
            type: 'greater_than_equal',
            loc: ['body', 'surcharge_input_per_1m_usd'],
            msg: 'Input should be greater than or equal to 0',
          },
        ],
      }),
      'fallback',
    );
    expect(msg).toBe('surcharge_input_per_1m_usd: Input should be greater than or equal to 0');
  });

  it('renders an ARRAY body-level detail (loc === ["body"]) as the bare message', () => {
    const msg = formatApiError(
      envelope({ detail: [{ type: 'value_error', loc: ['body'], msg: BODY_LEVEL_MSG }] }),
      'fallback',
    );
    expect(msg.startsWith('a markup rule must set at least one economic field')).toBe(true);
    expect(msg).not.toContain('Value error,');
    expect(msg).not.toContain('loc');
  });

  it('joins a nested loc path with dots', () => {
    const msg = formatApiError(
      envelope({ detail: [{ loc: ['body', 'rules', 0, 'markup_pct'], msg: 'bad' }] }),
      'fallback',
    );
    expect(msg).toBe('rules.0.markup_pct: bad');
  });

  it('keeps the STRING detail path byte-identical (llm-provider behaviour)', () => {
    expect(formatApiError(envelope({ detail: 'provider is not configured' }), 'fallback')).toBe(
      'provider is not configured',
    );
  });

  it('still stringifies an unreadable array rather than dropping it', () => {
    expect(formatApiError(envelope({ detail: [{ nonsense: 1 }] }), 'fallback')).toBe(
      '[{"nonsense":1}]',
    );
  });

  it('still stringifies a non-array object detail (pre-existing behaviour)', () => {
    expect(formatApiError(envelope({ detail: { a: 1 } }), 'fallback')).toBe('{"a":1}');
  });
});

describe('formatApiError — the rest of the resolution order', () => {
  it('returns a STRING error verbatim', () => {
    expect(formatApiError({ error: 'plain string error' }, 'fallback')).toBe('plain string error');
  });

  it('falls back to the fr-backend error.message when there is no upstream body', () => {
    expect(
      formatApiError({ error: { code: 'UPSTREAM_TIMEOUT', message: 'billing timed out' } }, 'fb'),
    ).toBe('billing timed out');
  });

  it('falls back to a top-level message when there is no error object', () => {
    expect(formatApiError({ message: 'top level' }, 'fb')).toBe('top level');
  });

  it('falls back to the caller fallback for an unrecognisable body', () => {
    expect(formatApiError({ nope: true }, 'fb')).toBe('fb');
    expect(formatApiError(null, 'fb')).toBe('fb');
    expect(formatApiError('a string body', 'fb')).toBe('fb');
  });

  it('prefers billing details over a sibling detail key', () => {
    const msg = formatApiError(
      envelope({
        error: { details: [{ field: 'markup_pct', message: 'from details' }] },
        detail: 'from detail',
      }),
      'fb',
    );
    expect(msg).toBe('markup_pct: from details');
  });
});

describe('apiErrorMessage — Response wrapper', () => {
  function json(body: unknown, status = 422): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('formats a JSON error body', async () => {
    await expect(apiErrorMessage(json(BILLING_422_LIVE), 'fb')).resolves.toBe(
      'Request validation failed',
    );
  });

  it('returns the fallback for a non-JSON body', async () => {
    const r = new Response('<html>502 Bad Gateway</html>', { status: 502 });
    await expect(apiErrorMessage(r, 'upsertMarkupRule: 502')).resolves.toBe(
      'upsertMarkupRule: 502',
    );
  });
});
