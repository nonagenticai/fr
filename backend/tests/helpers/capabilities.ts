// tests/helpers/capabilities.ts
//
// Test-side introspection of the capability registry. Neither function is on a
// production path; both read only public state (the CAPABILITIES list, and the
// global-registry symbol src/capabilities/lazy.ts tags every lazy handler with).
import type { Capability } from '../../src/capabilities/define';
import type { HandlerRef } from '../../src/capabilities/lazy';
import { CAPABILITIES, type RegisteredCapability } from '../../src/capabilities/registry';

/** Same key as lazy.ts's HANDLER_REF (`Symbol.for` is the process-global registry). */
const HANDLER_REF = Symbol.for('fr.capability.handlerRef');

/** The `{ module, exportName }` a lazy handler wrapper was bound to, or undefined. */
export function handlerRefOf(fn: unknown): HandlerRef | undefined {
  return typeof fn === 'function' ? (fn as unknown as Record<symbol, HandlerRef>)[HANDLER_REF] : undefined;
}

export function getCapability(
  id: string,
  entries: ReadonlyArray<RegisteredCapability> = CAPABILITIES,
): Capability<any, any> | undefined {
  return entries.find((e) => e.cap.id === id)?.cap;
}
