// src/utils/router.ts
export interface Route {
  method: string;
  /** The pattern string as registered (e.g. "/api/projects/:id") — what route allowlists key on. */
  path: string;
  pattern: RegExp;
  handler: (req: Request, ...params: string[]) => Promise<Response>;
}

/**
 * Compile a route pattern like "/api/projects/:id" to its anchored regex. The ONE
 * compiler: `Router.add` and `lib/licence-route-allowlist.ts` both use it, so an
 * allowlist entry matches exactly the paths the registered route would.
 */
export function compileRoutePattern(pattern: string): RegExp {
  const regexPattern = pattern
    .replace(/\//g, '\\/')
    .replace(/:(\w+)/g, '([^/]+)');
  return new RegExp(`^${regexPattern}$`);
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: (req: Request, ...params: string[]) => Promise<Response>): void {
    this.routes.push({
      method,
      path: pattern,
      pattern: compileRoutePattern(pattern),
      handler,
    });
  }

  /** The registered rows in match order (read-only view; capabilities/derive-router.ts). */
  list(): ReadonlyArray<Pick<Route, 'method' | 'path'>> {
    return this.routes.map((r) => ({ method: r.method, path: r.path }));
  }

  /**
   * Register a row at `index` in match order. Only `deriveRouter` uses it: a
   * capability row is placed by the pinned overlap pairs (fr-agui SPEC §3.6),
   * not appended.
   */
  insertAt(
    index: number,
    method: string,
    pattern: string,
    handler: (req: Request, ...params: string[]) => Promise<Response>,
  ): void {
    if (!Number.isInteger(index) || index < 0 || index > this.routes.length) {
      throw new RangeError(`Router.insertAt: index ${index} outside 0..${this.routes.length}`);
    }
    this.routes.splice(index, 0, { method, path: pattern, pattern: compileRoutePattern(pattern), handler });
  }

  match(
    method: string,
    pathname: string,
  ): { handler: Route['handler']; params: string[]; path: string } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;

      const match = pathname.match(route.pattern);
      if (match) {
        return {
          handler: route.handler,
          path: route.path,
          params: match.slice(1), // Extract captured groups
        };
      }
    }

    return null;
  }
}
