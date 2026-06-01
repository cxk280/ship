/**
 * Public route metadata registry.
 *
 * Each v1 route self-registers its contract here at module load: the required
 * scope (or null for identity/meta routes that opt out explicitly), whether it
 * is a paginated list, and a summary. The OpenAPI generator and the route
 * fitness test (Slice 4) read this registry — it is the single source the
 * "spec ↔ route" and "scope declared" assertions check against, so a route can't
 * silently ship without declaring its contract.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface PublicRouteMeta {
  method: HttpMethod;
  /** Path relative to /api/v1, OpenAPI-style, e.g. '/documents/{id}'. */
  path: string;
  /** Required scope, or null to OPT OUT explicitly (identity/meta routes). */
  scope: string | null;
  /** True for cursor-paginated list endpoints. */
  paginated: boolean;
  summary: string;
}

class RouteMetaRegistry {
  private readonly routes: PublicRouteMeta[] = [];

  register(meta: PublicRouteMeta): PublicRouteMeta {
    this.routes.push(meta);
    return meta;
  }

  list(): readonly PublicRouteMeta[] {
    return this.routes;
  }

  find(method: HttpMethod, path: string): PublicRouteMeta | undefined {
    return this.routes.find((r) => r.method === method && r.path === path);
  }
}

export const publicRoutes = new RouteMetaRegistry();
