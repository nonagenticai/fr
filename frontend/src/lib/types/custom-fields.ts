// frontend/src/lib/types/custom-fields.ts
//
// Custom-field-schema vocabulary used by SchemaForm.svelte. Each schema
// describes the structured shape that replaces the free-form
// JsonObjectInput in card_template editors. Today only `work_intake_record`
// has a schema; new card_types register here and SchemaForm renders the
// fields automatically.

export type CustomFieldSpec =
  | {
      name: string;
      label?: string;
      type: 'string';
      required?: boolean;
      placeholder?: string;
      hint?: string;
    }
  | {
      name: string;
      label?: string;
      type: 'number';
      required?: boolean;
      hint?: string;
    }
  | {
      name: string;
      label?: string;
      type: 'boolean';
      required?: boolean;
      hint?: string;
    }
  | {
      name: string;
      label?: string;
      type: 'enum';
      options: readonly string[];
      required?: boolean;
      placeholder?: string;
      hint?: string;
    };

export interface CustomFieldSchema {
  fields: readonly CustomFieldSpec[];
}

/**
 * Card-type → schema map. Lookup returns `undefined` for card_types that
 * don't have a structured schema yet (caller falls back to the free-form
 * JsonObjectInput).
 */
const SCHEMAS: Readonly<Record<string, CustomFieldSchema>> = {
  work_intake_record: {
    fields: [
      {
        name: 'priority',
        label: 'Priority',
        type: 'enum',
        options: ['low', 'medium', 'high', 'urgent'],
        placeholder: '— select —',
        hint: 'Routing hint for downstream triage.',
      },
      {
        name: 'due_at',
        label: 'Due (ISO-8601)',
        type: 'string',
        placeholder: '2026-05-10T00:00:00Z',
        hint: 'Optional. Leave blank for no SLA.',
      },
      {
        name: 'source_url',
        label: 'Source URL',
        type: 'string',
        placeholder: 'https://…',
        hint: 'Origin link surfaced on the card detail page.',
      },
    ],
  },
};

export function getCustomFieldSchema(cardType: string | undefined): CustomFieldSchema | undefined {
  if (!cardType) return undefined;
  return SCHEMAS[cardType];
}
