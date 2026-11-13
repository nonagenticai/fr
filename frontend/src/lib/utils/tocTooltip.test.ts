import { describe, it, expect } from 'vitest';
import { buildTocTooltipHtml } from './tocTooltip';

describe('buildTocTooltipHtml', () => {
  it('escapes a stored-XSS payload in the node title', () => {
    const html = buildTocTooltipHtml({
      title: '<img src=x onerror="alert(document.cookie)">',
      node_kind: 'requirement',
      statement: 'benign',
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror="');
    expect(html).toContain('&lt;img');
  });

  it('escapes a script payload in the statement (free-text LTP content)', () => {
    const html = buildTocTooltipHtml({
      title: 'Reduce cycle time',
      node_kind: 'undesirable_effect',
      statement: '</div><script>fetch("//evil")</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders benign content as readable markup', () => {
    const html = buildTocTooltipHtml({
      title: 'Throughput',
      node_kind: 'goal',
      statement: 'Maximize flow',
    });
    expect(html).toContain('Throughput');
    expect(html).toContain('Maximize flow');
  });

  it('tolerates missing statement', () => {
    const html = buildTocTooltipHtml({ title: 'X', node_kind: 'goal' });
    expect(html).toContain('X');
  });
});
