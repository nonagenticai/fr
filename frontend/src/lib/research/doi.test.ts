import { describe, it, expect } from 'vitest';
import { normalizeDoi, doiHref } from './doi';

describe('normalizeDoi', () => {
  it('passes a bare DOI through unchanged', () => {
    expect(normalizeDoi('10.1038/s41586-021-03819-2')).toBe('10.1038/s41586-021-03819-2');
  });

  it.each([
    'https://doi.org/10.1000/xyz',
    'http://dx.doi.org/10.1000/xyz',
    'https://www.doi.org/10.1000/xyz',
    'doi:10.1000/xyz',
    'DOI: 10.1000/xyz',
    'info:doi/10.1000/xyz',
    '  10.1000/xyz  ',
  ])('strips the resolver from %s', (raw) => {
    expect(normalizeDoi(raw)).toBe('10.1000/xyz');
  });

  it('strips sentence punctuation a copy-paste carried in', () => {
    expect(normalizeDoi('10.1000/xyz.')).toBe('10.1000/xyz');
    expect(normalizeDoi('10.1000/xyz,')).toBe('10.1000/xyz');
    expect(normalizeDoi('10.1000/xyz)')).toBe('10.1000/xyz');
  });

  it('keeps a parenthesis that belongs to the suffix', () => {
    expect(normalizeDoi('10.1002/(SICI)1097-0258')).toBe('10.1002/(SICI)1097-0258');
  });

  it.each([null, undefined, '', '   ', 'PMC123456', '12345678', 'not a doi', '10.1000'])(
    'refuses %p',
    (raw) => {
      expect(normalizeDoi(raw)).toBeNull();
    },
  );
});

describe('doiHref', () => {
  it('builds a resolver URL', () => {
    expect(doiHref('10.1000/xyz')).toBe('https://doi.org/10.1000/xyz');
  });

  it('does not double the resolver on an already-prefixed value', () => {
    expect(doiHref('https://doi.org/10.1000/xyz')).toBe('https://doi.org/10.1000/xyz');
  });

  it('percent-encodes characters that would break the path', () => {
    // `#` would truncate at the fragment and lose the rest of the suffix.
    expect(doiHref('10.1000/a#b')).toBe('https://doi.org/10.1000/a%23b');
  });

  it('leaves the unreserved characters a suffix is full of alone', () => {
    expect(doiHref('10.1002/(SICI)1097-0258(19980815)17:15<1623::AID>3.0.CO;2-S')).toBe(
      'https://doi.org/10.1002/(SICI)1097-0258(19980815)17%3A15%3C1623%3A%3AAID%3E3.0.CO%3B2-S',
    );
  });

  it('returns null rather than a link that resolves to nothing', () => {
    expect(doiHref('PMC123456')).toBeNull();
    expect(doiHref(null)).toBeNull();
  });
});
