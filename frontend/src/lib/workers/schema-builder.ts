export type PrimitiveType = 'string' | 'number' | 'integer' | 'boolean';
export type FieldType = PrimitiveType;

export type ObjectField = {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
};

export type SchemaState =
  | { kind: 'none' }
  | { kind: 'boolean' }
  | { kind: 'list'; itemType: FieldType }
  | { kind: 'object'; fields: ObjectField[] };

export function emptyState(): SchemaState {
  return { kind: 'none' };
}

export function toJsonSchema(state: SchemaState): Record<string, unknown> | null {
  switch (state.kind) {
    case 'none':
      return null;
    case 'boolean':
      return { type: 'boolean' };
    case 'list':
      return { type: 'array', items: { type: state.itemType } };
    case 'object': {
      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];
      for (const f of state.fields) {
        const entry: Record<string, unknown> = { type: f.type };
        if (f.description) entry.description = f.description;
        properties[f.name] = entry;
        if (f.required) required.push(f.name);
      }
      const out: Record<string, unknown> = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      return out;
    }
  }
}

export function fromJsonSchema(schema: unknown): SchemaState {
  if (!schema || typeof schema !== 'object') return emptyState();
  const s = schema as Record<string, unknown>;
  if (s.type === 'boolean') return { kind: 'boolean' };
  if (s.type === 'array' && s.items && typeof s.items === 'object') {
    const itemType = (s.items as { type?: string }).type;
    if (itemType === 'string' || itemType === 'number' || itemType === 'integer' || itemType === 'boolean') {
      return { kind: 'list', itemType };
    }
  }
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') {
    const required = new Set((s.required as string[] | undefined) ?? []);
    const fields: ObjectField[] = Object.entries(s.properties as Record<string, Record<string, unknown>>).map(
      ([name, def]) => ({
        name,
        type: (def.type as FieldType | undefined) ?? 'string',
        required: required.has(name),
        description: (def.description as string | undefined) ?? ''
      })
    );
    return { kind: 'object', fields };
  }
  return emptyState();
}
