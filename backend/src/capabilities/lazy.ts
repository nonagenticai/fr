/**
 * Late binding for capability handlers, so a declaration stays side-effect free
 * (see define.ts). The wrapper resolves the named export with a cached dynamic
 * import on the FIRST call and then calls it with the same arguments — the
 * route sees the exact function it saw before, one microtask later.
 *
 * Every wrapper carries a `HandlerRef` so static instruments can name the real
 * handler (the envelope-shape guard resolves its body; the route-order test
 * compares handlers by it) instead of seeing an anonymous arrow.
 */
import type { ActionContext } from '../agui/types';
import type { LegacyRouteHandler } from './define';

export interface HandlerRef {
  /** Backend-relative module path (`src/routes/projects.ts`). */
  module: string;
  /** The named export. */
  exportName: string;
}

const HANDLER_REF = Symbol.for('fr.capability.handlerRef');

function tag<F extends (...args: never[]) => unknown>(fn: F, ref: HandlerRef): F {
  Object.defineProperty(fn, HANDLER_REF, { value: ref, enumerable: false });
  Object.defineProperty(fn, 'name', { value: ref.exportName });
  return fn;
}

function resolver<T>(load: () => Promise<Record<string, unknown>>, ref: HandlerRef): () => Promise<T> {
  let cached: T | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    const mod = await load();
    const fn = mod[ref.exportName];
    if (typeof fn !== 'function') {
      throw new Error(`capability handler ${ref.module}#${ref.exportName} is not an exported function`);
    }
    cached = fn as T;
    return cached;
  };
}

/** A route handler `(req, ...params) => Response` bound late. */
export function lazyHandler(
  load: () => Promise<Record<string, unknown>>,
  ref: HandlerRef,
): LegacyRouteHandler {
  const get = resolver<LegacyRouteHandler>(load, ref);
  return tag(async (req: Request, ...params: string[]) => (await get())(req, ...params), ref);
}

/** A server-side capability handler `(input, ctx) => output` bound late. */
export function lazyActionHandler<I, O>(
  load: () => Promise<Record<string, unknown>>,
  ref: HandlerRef,
): (input: I, ctx: ActionContext) => Promise<O> {
  const get = resolver<(input: I, ctx: ActionContext) => Promise<O>>(load, ref);
  return tag(async (input: I, ctx: ActionContext) => (await get())(input, ctx), ref);
}
