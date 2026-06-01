/**
 * Domain ports for the public edge (DIP).
 *
 * The sealed v1 layer depends only on these INTERFACES. Concrete adapters (which
 * touch the database / internal services) live under platform/adapters and are
 * wired into the router by the composition root. This is what keeps
 * platform/api/v1/** free of any api/src import — and what the boundary lint
 * enforces.
 */

/** Minimal authenticated-user view returned by /api/v1/me. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
}

/** Identity lookups the public edge needs. */
export interface IdentityPort {
  getUser(userId: string): Promise<PublicUser | null>;
}
