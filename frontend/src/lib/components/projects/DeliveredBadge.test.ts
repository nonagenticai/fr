// @vitest-environment jsdom
//
// DeliveredBadge — migration 173 `status = 'delivered'`: badge + "PR #n" link +
// delivered date. Renders nothing for any other status.

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import DeliveredBadge from './DeliveredBadge.svelte';
import type { ProjectDeliveryEvidence } from '$lib/types/api';

const EVIDENCE: ProjectDeliveryEvidence = {
  computed_check_id: 'cc-1',
  evidence_sha: 'a'.repeat(40),
  outcome: 'pr_opened',
  hunt_card_id: 'card-1',
  pr: { number: 1234, head_sha: 'b'.repeat(40), url: 'https://github.com/nonagenticai/fr/pull/1234' },
};

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(props: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(DeliveredBadge, { target: host, props: props as never });
  flushSync();
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  host?.remove();
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('DeliveredBadge', () => {
  it('delivered: badge, PR link (new tab, noopener) and the delivered date', () => {
    render({ status: 'delivered', deliveredAt: '2026-10-09T19:04:40Z', evidence: EVIDENCE });
    expect(q('project-delivered-badge')?.textContent?.trim()).toBe('Delivered');
    const a = q('project-delivered-pr') as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.textContent?.trim()).toBe('PR #1234');
    expect(a!.getAttribute('href')).toBe(EVIDENCE.pr.url);
    expect(a!.getAttribute('target')).toBe('_blank');
    expect(a!.getAttribute('rel')).toContain('noopener');
    expect(q('project-delivered-at')?.textContent?.trim()).toBe('2026-10-09');
  });

  it('active: renders nothing at all, even with evidence present', () => {
    render({ status: 'active', deliveredAt: '2026-10-09T19:04:40Z', evidence: EVIDENCE });
    expect(q('project-delivered')).toBeNull();
    expect(q('project-delivered-badge')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
  });

  it('archived: renders nothing', () => {
    render({ status: 'archived' });
    expect(q('project-delivered')).toBeNull();
  });

  it('linkPr=false (list row inside an <a>): PR number as text, no anchor', () => {
    render({ status: 'delivered', evidence: EVIDENCE, linkPr: false });
    expect(q('project-delivered-badge')).not.toBeNull();
    expect(host.querySelector('a')).toBeNull();
    expect(q('project-delivered-pr-text')?.textContent?.trim()).toBe('PR #1234');
  });

  it('a non-http PR url is never an href', () => {
    render({
      status: 'delivered',
      evidence: { ...EVIDENCE, pr: { ...EVIDENCE.pr, url: 'javascript:alert(1)' } },
    });
    expect(host.querySelector('a')).toBeNull();
    expect(q('project-delivered-pr-text')?.textContent?.trim()).toBe('PR #1234');
  });
  it('RM-closed evidence: badge and date, no PR', () => {
    render({
      status: 'delivered',
      deliveredAt: '2026-10-30T12:00:00Z',
      evidence: { source: 'rm_project_closed', rm_pm_project_id: 'rm-1', phase: 'execution' },
    });
    expect(q('project-delivered-badge')?.textContent?.trim()).toBe('Delivered');
    expect(host.querySelector('a')).toBeNull();
  });
});
