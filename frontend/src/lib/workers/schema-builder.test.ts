import { describe, it, expect } from 'vitest';
import { toJsonSchema, fromJsonSchema, emptyState, type SchemaState } from './schema-builder';

describe('SchemaBuilder state', () => {
  it('none → null', () => {
    expect(toJsonSchema({ kind: 'none' })).toBeNull();
  });

  it('boolean → {type: "boolean"}', () => {
    expect(toJsonSchema({ kind: 'boolean' })).toEqual({ type: 'boolean' });
  });

  it('list of string → {type: "array", items: {type: "string"}}', () => {
    expect(toJsonSchema({ kind: 'list', itemType: 'string' })).toEqual({
      type: 'array',
      items: { type: 'string' }
    });
  });

  it('object with 2 required string fields', () => {
    const state: SchemaState = {
      kind: 'object',
      fields: [
        { name: 'name', type: 'string', required: true, description: '' },
        { name: 'age', type: 'integer', required: true, description: 'years' }
      ]
    };
    expect(toJsonSchema(state)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer', description: 'years' }
      },
      required: ['name', 'age']
    });
  });

  it('object with optional field is not required', () => {
    const state: SchemaState = {
      kind: 'object',
      fields: [{ name: 'note', type: 'string', required: false, description: '' }]
    };
    const json = toJsonSchema(state);
    expect(json).toEqual({
      type: 'object',
      properties: { note: { type: 'string' } }
    });
  });
});

describe('SchemaBuilder round-trip', () => {
  it('round-trips an object schema', () => {
    const input = {
      type: 'object',
      properties: { name: { type: 'string' }, ok: { type: 'boolean' } },
      required: ['name']
    };
    const state = fromJsonSchema(input);
    expect(state.kind).toBe('object');
    if (state.kind !== 'object') throw new Error();
    expect(state.fields).toEqual([
      { name: 'name', type: 'string', required: true, description: '' },
      { name: 'ok', type: 'boolean', required: false, description: '' }
    ]);
    expect(toJsonSchema(state)).toEqual(input);
  });

  it('round-trips a list', () => {
    const input = { type: 'array', items: { type: 'number' } };
    const state = fromJsonSchema(input);
    expect(state).toEqual({ kind: 'list', itemType: 'number' });
    expect(toJsonSchema(state)).toEqual(input);
  });

  it('unknown shape falls back to emptyState (none)', () => {
    expect(fromJsonSchema(null)).toEqual(emptyState());
    expect(fromJsonSchema(undefined as unknown as null)).toEqual(emptyState());
  });
});
