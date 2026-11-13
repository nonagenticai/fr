/**
 * fr-agui SPEC §3.4 (d) — MCP tool descriptors, derived from the declaration.
 *
 * DESCRIPTORS ONLY: unit-tested, NOT served. Serving them is OQ-13. The input
 * schema is the same JSON Schema the agent tool carries (json-schema.ts).
 */
import type { Capability } from './define';
import { extractJsonSchema } from './json-schema';
import { CAPABILITIES, type RegisteredCapability } from './registry';

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
}

export function deriveMcpTool(cap: Capability<any, any>): McpToolDescriptor {
  return {
    name: cap.id,
    description: cap.description ? `${cap.summary}\n\n${cap.description}` : cap.summary,
    inputSchema: extractJsonSchema(cap.input) ?? { type: 'object' },
    annotations: {
      readOnlyHint: cap.effect === 'read',
      destructiveHint: cap.effect === 'destructive',
      idempotentHint: cap.http.idempotencyHeader !== undefined,
    },
  };
}

/** Every agent-exposed capability as an MCP descriptor (the agent's scope is the MCP scope). */
export function deriveMcp(entries: ReadonlyArray<RegisteredCapability> = CAPABILITIES): McpToolDescriptor[] {
  return entries.filter((e) => e.cap.agent.expose).map((e) => deriveMcpTool(e.cap));
}
