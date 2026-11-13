/**
 * Unit tests for the schema-aware parameter rendering helpers. The
 * non-trivial piece is `isVisible` (n8n's displayOptions semantics);
 * everything else is mostly mechanical.
 */
import { describe, it, expect } from 'vitest';
import {
  isVisible,
  visibleProperties,
  optionLabel,
  multiOptionLabels,
  formatScalar,
  isLongString,
  valueOnlyRows,
  defaultsFor,
  type ParamProperty,
} from './parameterRender';

const resourceProp: ParamProperty = {
  name: 'resource',
  displayName: 'Resource',
  type: 'options',
  default: 'project',
  options: [
    { name: 'Project', value: 'project' },
    { name: 'Card', value: 'card' },
  ],
};

const opProp: ParamProperty = {
  name: 'operation',
  displayName: 'Operation',
  type: 'options',
  default: 'get',
  options: [
    { name: 'Get', value: 'get' },
    { name: 'Create', value: 'create' },
  ],
  displayOptions: { show: { resource: ['project'] } },
};

const cardOnlyProp: ParamProperty = {
  name: 'cardId',
  displayName: 'Card Id',
  type: 'string',
  default: '',
  displayOptions: { show: { resource: ['card'] } },
};

const allProps = [resourceProp, opProp, cardOnlyProp];

describe('isVisible / visibleProperties', () => {
  it('keeps a prop with no displayOptions', () => {
    expect(isVisible(resourceProp, {}, {})).toBe(true);
  });

  it('hides a prop whose show clause does not match', () => {
    expect(isVisible(opProp, { resource: 'card' }, defaultsFor(allProps))).toBe(false);
  });

  it('shows a prop whose show clause matches', () => {
    expect(isVisible(opProp, { resource: 'project' }, defaultsFor(allProps))).toBe(true);
  });

  it('falls back to the referenced prop default when value missing', () => {
    // resourceProp.default = 'project', so opProp (show: resource=[project]) should show
    expect(isVisible(opProp, {}, defaultsFor(allProps))).toBe(true);
  });

  it('honours hide clauses', () => {
    const hideProp: ParamProperty = {
      name: 'x',
      displayName: 'X',
      type: 'string',
      displayOptions: { hide: { resource: ['card'] } },
    };
    expect(isVisible(hideProp, { resource: 'card' }, {})).toBe(false);
    expect(isVisible(hideProp, { resource: 'project' }, {})).toBe(true);
  });

  it('filters a list down with visibleProperties', () => {
    const visible = visibleProperties(allProps, { resource: 'card', cardId: 'abc' });
    expect(visible.map((p) => p.name)).toEqual(['resource', 'cardId']);
  });
});

describe('optionLabel / multiOptionLabels', () => {
  it('renders an option name in place of its raw value', () => {
    expect(optionLabel(resourceProp, 'card')).toBe('Card');
  });

  it('falls through to the raw value when not in options', () => {
    expect(optionLabel(resourceProp, 'unknown')).toBe('unknown');
  });

  it('renders a multiOptions array as names', () => {
    expect(multiOptionLabels(resourceProp, ['project', 'card'])).toEqual(['Project', 'Card']);
  });

  it('returns [] for non-array multiOption value', () => {
    expect(multiOptionLabels(resourceProp, null)).toEqual([]);
  });
});

describe('formatScalar', () => {
  it('renders boolean as Yes/No', () => {
    expect(formatScalar(true)).toBe('Yes');
    expect(formatScalar(false)).toBe('No');
  });

  it('renders empty/null/undefined as em-dash', () => {
    expect(formatScalar('')).toBe('—');
    expect(formatScalar(null)).toBe('—');
    expect(formatScalar(undefined)).toBe('—');
  });

  it('returns string for primitives', () => {
    expect(formatScalar('hi')).toBe('hi');
    expect(formatScalar(42)).toBe('42');
  });

  it('JSON-encodes objects', () => {
    expect(formatScalar({ a: 1 })).toBe('{"a":1}');
  });
});

describe('valueOnlyRows', () => {
  it('returns sorted key/value pairs', () => {
    expect(valueOnlyRows({ b: 'second', a: 'first' })).toEqual([
      ['a', 'first'],
      ['b', 'second'],
    ]);
  });
});

describe('isLongString', () => {
  it('flags strings containing a newline', () => {
    expect(isLongString('a\nb')).toBe(true);
  });
  it('flags strings longer than the default threshold', () => {
    expect(isLongString('x'.repeat(81))).toBe(true);
    expect(isLongString('x'.repeat(80))).toBe(false);
  });
  it('does not flag short single-line strings', () => {
    expect(isLongString('hello world')).toBe(false);
    expect(isLongString('')).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(isLongString(42)).toBe(false);
    expect(isLongString(null)).toBe(false);
    expect(isLongString(undefined)).toBe(false);
    expect(isLongString({ a: 1 })).toBe(false);
  });
});
