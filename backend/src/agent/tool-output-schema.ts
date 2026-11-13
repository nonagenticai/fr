/**
 * Plan 3 — JSON Schema enforced by worker_management's `output_schema` on
 * every fr-agent call. The LLM MUST return a value matching this shape;
 * the agent loop's stop condition reads it.
 *
 * The schema is a discriminated union on `kind`:
 *   - `final_answer` → terminate the loop, deliver `text` to the user.
 *   - `tool_calls`   → execute each call in the registry, append results,
 *                       call WM again with the updated context.
 */

export const FR_AGENT_TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { const: 'final_answer' },
        text: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'tool_calls' },
        calls: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                pattern: '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$',
              },
              input: {},
            },
            required: ['action', 'input'],
            additionalProperties: false,
          },
        },
      },
      required: ['kind', 'calls'],
      additionalProperties: false,
    },
  ],
} as const;

export type FrAgentOutput =
  | { kind: 'final_answer'; text: string }
  | {
      kind: 'tool_calls';
      calls: Array<{ action: string; input: unknown }>;
    };
