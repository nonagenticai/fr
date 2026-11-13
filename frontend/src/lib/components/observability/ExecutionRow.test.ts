// @vitest-environment jsdom
//
// ExecutionRow.test.ts
//
// Smoke tests for the Tempo / Grafana deep-link rendering on ExecutionRow.
// Verifies:
//   - link rendered (with target=_blank, rel=noopener noreferrer) when
//     either `traceUrl` or `traceId` is provided
//   - link hidden when neither is provided
//   - precomputed `traceUrl` wins over a `traceId` build (single source of
//     truth: the backend's `trace_url`)
//   - the slot still renders alongside the Tempo link
//
// Plan ref:
//   docs/superpowers/plans/completed/2026-04-25-n8n-observability-implementation.md
//   §"Open follow-ups" — Tempo deep-link.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import ExecutionRow from './ExecutionRow.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
}

const BASE_PROPS = {
  status: 'success',
  name: 'wf-a · #1001',
  durationMs: 5000,
  startedAt: '2026-04-24T12:00:00Z',
};

describe('ExecutionRow Tempo deep-link', () => {
  it('renders the Tempo link when `traceUrl` is provided', async () => {
    app = mount(ExecutionRow, {
      target: host,
      props: {
        ...BASE_PROPS,
        traceUrl: 'https://grafana.nonagentic.ai/explore?left=abc',
      },
    });
    await settle();

    const link = host.querySelector<HTMLAnchorElement>(
      '[data-testid="execution-row-tempo-link"]',
    );
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(
      'https://grafana.nonagentic.ai/explore?left=abc',
    );
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link!.textContent).toContain('Tempo');
  });

  it('builds a Grafana URL from `traceId` when `traceUrl` is absent', async () => {
    app = mount(ExecutionRow, {
      target: host,
      props: {
        ...BASE_PROPS,
        traceId: 'exec-123',
        workflowId: 'wf-z',
      },
    });
    await settle();

    const link = host.querySelector<HTMLAnchorElement>(
      '[data-testid="execution-row-tempo-link"]',
    );
    expect(link).not.toBeNull();
    const href = link!.getAttribute('href') ?? '';
    expect(href).toMatch(/^https:\/\/grafana\.nonagentic\.ai\/explore\?left=/);
    expect(href).toContain('execution_id%3D');
    expect(href).toContain('workflow_id%3D');
  });

  it('prefers `traceUrl` over `traceId` when both are provided', async () => {
    app = mount(ExecutionRow, {
      target: host,
      props: {
        ...BASE_PROPS,
        traceUrl: 'https://override.example/trace',
        traceId: 'exec-123',
        workflowId: 'wf-z',
      },
    });
    await settle();

    const link = host.querySelector<HTMLAnchorElement>(
      '[data-testid="execution-row-tempo-link"]',
    );
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://override.example/trace');
    // No double-render: exactly one link.
    expect(host.querySelectorAll('[data-testid="execution-row-tempo-link"]')).toHaveLength(1);
  });

  it('omits the link when neither `traceUrl` nor `traceId` is provided', async () => {
    app = mount(ExecutionRow, {
      target: host,
      props: { ...BASE_PROPS },
    });
    await settle();

    const link = host.querySelector('[data-testid="execution-row-tempo-link"]');
    expect(link).toBeNull();
    // The row itself is still rendered.
    expect(host.querySelector('[data-testid="execution-row"]')).not.toBeNull();
  });

  it('omits the link when `traceUrl` is empty and `traceId` is empty', async () => {
    app = mount(ExecutionRow, {
      target: host,
      props: { ...BASE_PROPS, traceUrl: '', traceId: '' },
    });
    await settle();

    expect(host.querySelector('[data-testid="execution-row-tempo-link"]')).toBeNull();
  });
});
