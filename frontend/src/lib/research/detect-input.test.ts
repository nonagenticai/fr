import { describe, it, expect } from 'vitest';
import { detectInput, INPUT_TYPE_LABELS } from './detect-input';

describe('detectInput', () => {
  it('empty / whitespace → topic with empty normalized', () => {
    expect(detectInput('')).toEqual({ type: 'topic', normalized: '' });
    expect(detectInput('   ')).toEqual({ type: 'topic', normalized: '' });
  });

  it('bare DOI → doi, normalized to the bare id', () => {
    expect(detectInput('10.1001/jama.2020.1585')).toEqual({
      type: 'doi',
      normalized: '10.1001/jama.2020.1585',
    });
  });

  it('doi.org URL → doi, prefix stripped', () => {
    expect(detectInput('https://doi.org/10.1038/s41586-021-03819-2')).toEqual({
      type: 'doi',
      normalized: '10.1038/s41586-021-03819-2',
    });
  });

  it('trailing punctuation is trimmed off a DOI', () => {
    expect(detectInput('10.1001/jama.2020.1585.').normalized).toBe(
      '10.1001/jama.2020.1585',
    );
  });

  it('arXiv abs URL → arxiv, bare id', () => {
    expect(detectInput('https://arxiv.org/abs/2305.12345')).toEqual({
      type: 'arxiv',
      normalized: '2305.12345',
    });
  });

  it('arXiv pdf URL → arxiv, .pdf suffix removed', () => {
    expect(detectInput('https://arxiv.org/pdf/2305.12345v2.pdf').normalized).toBe(
      '2305.12345v2',
    );
  });

  it('bare arXiv id (the disambiguation case) → arxiv, NOT doi', () => {
    expect(detectInput('2305.12345')).toEqual({
      type: 'arxiv',
      normalized: '2305.12345',
    });
    expect(detectInput('2305.12345v3').type).toBe('arxiv');
  });

  it('a plain http URL → url', () => {
    expect(detectInput('https://example.com/paper.html')).toEqual({
      type: 'url',
      normalized: 'https://example.com/paper.html',
    });
  });

  it('a question (trailing ?) → question', () => {
    expect(detectInput('does stress echo predict mortality?').type).toBe(
      'question',
    );
  });

  it('a wh-word opener → question', () => {
    expect(detectInput('how does dobutamine stress echo work').type).toBe(
      'question',
    );
  });

  it('title + authors with et al. → title', () => {
    expect(
      detectInput('Attention Is All You Need, Vaswani et al. 2017').type,
    ).toBe('title');
  });

  it('semicolon author list with a year → title', () => {
    expect(
      detectInput('Deep learning; LeCun, Y.; Bengio, Y.; Hinton, G. 2015').type,
    ).toBe('title');
  });

  it('a plain topic phrase → topic', () => {
    expect(detectInput('stress echocardiography')).toEqual({
      type: 'topic',
      normalized: 'stress echocardiography',
    });
  });

  it('a stray arXiv-looking number inside prose stays a topic', () => {
    expect(detectInput('see results around 2305.12345 for context').type).toBe(
      'topic',
    );
  });

  it('every type has a human label', () => {
    for (const t of ['doi', 'arxiv', 'url', 'title', 'question', 'topic'] as const) {
      expect(INPUT_TYPE_LABELS[t]).toBeTruthy();
    }
  });
});
