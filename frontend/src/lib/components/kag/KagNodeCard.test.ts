// @vitest-environment jsdom
//
// KagNodeCard replaces the Search tab's per-node `JSON.stringify` dump. It must
// render a graph node as structured chrome — label, type pill, the raw retrieval
// score labeled with the field it came from, domain properties as labeled rows
// (NOT one JSON blob), and a doc link when document-scoped — while keeping the raw
// JSON behind an opt-in disclosure. Mirrors the KagChunkCard mount/flushSync test
// pattern.
//
// The score assertions are the point of the scale group below: `nodeScoreOf` probes
// four differently-scaled field names, and the producer documents `score` as
// `1 - cosine_distance` in [0, 2] (chunks_repo.py:561) or unbounded `ts_rank_cd`
// (:627). So the card must never print a percentage, and must only draw a meter for
// a field name whose unit it can vouch for AND a value that is really in [0, 1].

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

import KagNodeCard from './KagNodeCard.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(node: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(KagNodeCard, { target: host, props: { node } });
  flushSync();
  return host;
}

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host?.remove();
});

describe('KagNodeCard', () => {
  it('renders label, a type pill, and the raw score labeled with its field — never a %', () => {
    const el = render({
      id: 'x',
      label: 'ORGANIZATION',
      properties: { text: 'Stanford University' },
      score: 0.82,
    });
    expect(el.querySelector('[data-testid="kag-node-card"]')).toBeTruthy();
    expect(el.textContent).toContain('Stanford University'); // human label
    expect(el.querySelector('[data-testid="kag-node-card-type"]')?.textContent).toContain(
      'ORGANIZATION',
    );
    expect(
      el.querySelector('[data-testid="kag-node-card-score-field"]')?.textContent,
    ).toContain('score');
    expect(
      el.querySelector('[data-testid="kag-node-card-score-value"]')?.textContent,
    ).toContain('0.82');
    // `score` is the ambiguous key ([0,2] cosine OR unbounded ts_rank_cd), so no
    // percentage and no meter even though this particular value sits in [0, 1].
    expect(el.textContent).not.toContain('%');
    expect(el.textContent).not.toContain('82%');
    expect(el.querySelector('[role="meter"]')).toBeNull();
  });

  it('renders domain properties as labeled rows, not a stringified blob', () => {
    const el = render({
      name: 'Acme',
      entity_type: 'Company',
      founded: 1999,
      sector: 'AI',
    });
    const dl = el.querySelector('dl');
    expect(dl).toBeTruthy();
    // The key and its value both appear as discrete text nodes…
    expect(dl?.textContent).toContain('founded');
    expect(dl?.textContent).toContain('1999');
    expect(dl?.textContent).toContain('sector');
    expect(dl?.textContent).toContain('AI');
    // …and NOT as a single JSON object literal.
    expect(dl?.textContent).not.toContain('{"founded"');
  });

  it('renders an object-valued property behind an opt-in disclosure, not inline JSON', () => {
    const el = render({ name: 'Acme', meta: { region: 'eu' } });
    const dl = el.querySelector('dl')!;
    expect(dl.textContent).toContain('meta'); // key still labels the row
    const det = Array.from(dl.querySelectorAll('details')).find((d) =>
      d.textContent?.includes('region'),
    ) as HTMLDetailsElement | undefined;
    expect(det).toBeTruthy();
    expect(det!.open).toBe(false); // collapsed by default — not a naked dump
    expect(det!.querySelector('pre')?.textContent).toContain('region');
  });

  it('shows "No additional properties." when the node carries only identity', () => {
    const el = render({ id: 'x', name: 'Bare', type: 'Entity' });
    expect(el.textContent).toContain('No additional properties.');
    expect(el.querySelector('dl')).toBeNull();
  });

  it('never renders a score badge or meter when the node is unscored', () => {
    const el = render({ name: 'a', sector: 'AI' });
    expect(el.querySelector('[role="meter"]')).toBeNull();
    expect(el.querySelector('[data-testid="kag-node-card-score"]')).toBeNull();
    expect(el.textContent).not.toContain('%');
  });

  it('links to the documents tab only when the node is document-scoped', () => {
    expect(
      render({ name: 'a', doc_id: 'd-1' }).querySelector('[data-testid="kag-node-card-doc-link"]'),
    ).toBeTruthy();
    // doc id nested under properties still resolves.
    expect(
      render({ name: 'a', properties: { document_id: 'd-2' } }).querySelector(
        '[data-testid="kag-node-card-doc-link"]',
      ),
    ).toBeTruthy();
    expect(
      render({ name: 'a' }).querySelector('[data-testid="kag-node-card-doc-link"]'),
    ).toBeNull();
  });

  describe('score scale', () => {
    it('renders a documented [0,2] cosine `score` of 1.42 raw, with no % and no meter', () => {
      const el = render({ name: 'a', score: 1.42 });
      expect(
        el.querySelector('[data-testid="kag-node-card-score-value"]')?.textContent,
      ).toContain('1.42');
      expect(
        el.querySelector('[data-testid="kag-node-card-score-field"]')?.textContent,
      ).toContain('score');
      expect(el.textContent).not.toContain('%');
      expect(el.textContent).not.toContain('142');
      expect(el.querySelector('[role="meter"]')).toBeNull();
    });

    it('renders an unbounded ts_rank_cd `score` of 7.3 raw, with no % and no meter', () => {
      const el = render({ name: 'a', score: 7.3 });
      expect(
        el.querySelector('[data-testid="kag-node-card-score-value"]')?.textContent,
      ).toContain('7.3');
      expect(el.textContent).not.toContain('%');
      expect(el.textContent).not.toContain('730');
      expect(el.querySelector('[role="meter"]')).toBeNull();
    });

    it('draws a 0–1 meter for `similarity` in range, still labeled and never a %', () => {
      const el = render({ name: 'a', similarity: 0.87 });
      expect(
        el.querySelector('[data-testid="kag-node-card-score-field"]')?.textContent,
      ).toContain('similarity');
      expect(
        el.querySelector('[data-testid="kag-node-card-score-value"]')?.textContent,
      ).toContain('0.87');
      const meter = el.querySelector('[role="meter"]');
      expect(meter).toBeTruthy();
      expect(meter?.getAttribute('aria-valuenow')).toBe('0.87');
      expect(meter?.getAttribute('aria-valuemax')).toBe('1');
      expect(el.textContent).not.toContain('%'); // the % only ever lives in a CSS width
    });

    it('withholds the meter for an out-of-range `similarity`', () => {
      const el = render({ name: 'a', similarity: 1.4 });
      expect(
        el.querySelector('[data-testid="kag-node-card-score-value"]')?.textContent,
      ).toContain('1.4');
      expect(el.querySelector('[role="meter"]')).toBeNull();
    });

    it('withholds the meter for the undocumented `relevance`/`_score` keys', () => {
      for (const node of [
        { name: 'a', relevance: 0.31 },
        { name: 'a', _score: 0.31 },
      ]) {
        const el = render(node);
        expect(el.querySelector('[data-testid="kag-node-card-score-value"]')).toBeTruthy();
        expect(el.querySelector('[role="meter"]')).toBeNull();
        expect(el.textContent).not.toContain('%');
      }
    });

    it('finds a score nested in the properties bag, with its field name', () => {
      const el = render({ name: 'a', properties: { similarity: 0.5 } });
      expect(
        el.querySelector('[data-testid="kag-node-card-score-field"]')?.textContent,
      ).toContain('similarity');
      expect(
        el.querySelector('[data-testid="kag-node-card-score-value"]')?.textContent,
      ).toContain('0.5');
      expect(el.querySelector('[role="meter"]')).toBeTruthy();
    });
  });

  it('keeps raw JSON behind a closed, opt-in disclosure — no <pre> in the default view', () => {
    const el = render({ id: 'x', name: 'Acme', sector: 'AI' });
    const raw = el.querySelector('[data-testid="kag-node-card-raw"]') as HTMLDetailsElement;
    expect(raw).toBeTruthy();
    expect(raw.open).toBe(false); // collapsed by default
    // The only <pre> lives INSIDE the raw disclosure, never in the card body.
    const pres = Array.from(el.querySelectorAll('pre'));
    expect(pres.length).toBe(1);
    expect(raw.contains(pres[0])).toBe(true);
  });
});
