// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import TrustBreakdown from './TrustBreakdown.svelte';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLElement;

function render(props: Record<string, unknown>): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(TrustBreakdown, { target: host, props });
  flushSync();
}
afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host?.remove();
});
const q = (t: string) => host.querySelector(`[data-testid="${t}"]`);

describe('TrustBreakdown', () => {
  it('renders the integrity score and its components', () => {
    render({
      integrity: {
        integrity_score: 0.82,
        components: [
          { name: 'citation', score: 0.9 },
          { name: 'consensus', score: 0.7 },
        ],
      },
    });
    expect(q('trust-integrity')?.textContent).toContain('integrity 0.82');
    expect(host.textContent).toContain('citation');
    expect(host.textContent).toContain('consensus');
  });

  it('renders the 7-signal trust score when provided', () => {
    render({ trustScore: 0.65, trustTitle: 'citations 0.9' });
    expect(q('trust-score')?.textContent).toContain('trust 0.65');
  });

  // Removed 2026-10-31: `it('renders nothing fatal with no data')` mounted with
  // `{}` and asserted only that the container element exists — "it rendered
  // something" is not a test. The mount itself throwing would fail the test; the
  // existence check on top of it proves nothing about what the user sees.
});
