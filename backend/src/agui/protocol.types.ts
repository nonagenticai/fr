// E-9 — AG-UI wire protocol: zod schemas + AguiEvent discriminated union.
//
// Frozen interface from
// docs/superpowers/plans/completed/2026-04-25-architecture-enablers-execution.md (Task 2,
// lines 144-203). This is the canonical encoder/decoder used by any wire path
// between agent core and FR backend; keep it in sync if the spec evolves.

import { z } from 'zod';

export const ToolCallSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

export const ToolResultSchema = z.object({
  type: z.literal('tool_result'),
  id: z.string().min(1),
  output: z.unknown(),
});

export const ToolErrorSchema = z.object({
  type: z.literal('tool_error'),
  id: z.string().min(1),
  error: z.object({ code: z.string(), message: z.string() }),
});

export const ApprovalPendingSchema = z.object({
  type: z.literal('approval_pending'),
  actionId: z.string().uuid(),
  approvalId: z.string().uuid(),
  summary: z.string(),
});

export const ApprovalResolvedSchema = z.object({
  type: z.literal('approval_resolved'),
  actionId: z.string().uuid(),
  status: z.enum(['approved', 'rejected']),
});

export const StreamDeltaSchema = z.object({
  type: z.literal('stream_delta'),
  id: z.string().min(1),
  delta: z.string(),
});

export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

export const DoneSchema = z.object({
  type: z.literal('done'),
  reason: z.enum(['complete', 'interrupted', 'error']),
});

export const AguiEventSchema = z.discriminatedUnion('type', [
  ToolCallSchema,
  ToolResultSchema,
  ToolErrorSchema,
  ApprovalPendingSchema,
  ApprovalResolvedSchema,
  StreamDeltaSchema,
  ErrorEventSchema,
  DoneSchema,
]);

export type AguiEvent = z.infer<typeof AguiEventSchema>;
