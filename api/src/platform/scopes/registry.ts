/**
 * ScopeRegistry — scopes are DATA, not code (Open/Closed Principle).
 *
 * A new scope is added by registering it here at module load. The authorization
 * middleware (`requireScope`) never changes to add one — it reads the registry.
 * This is the OCP example called out in docs/architecture.md.
 */

export interface ScopeDef {
  /** Canonical scope string, e.g. "documents:read". */
  name: string;
  /** Human description shown in consent UI and the dev portal. */
  description: string;
}

class ScopeRegistry {
  private readonly scopes = new Map<string, ScopeDef>();

  /** Register a scope at module load. Throws on duplicate (programmer error). */
  register(def: ScopeDef): string {
    if (this.scopes.has(def.name)) {
      throw new Error(`Scope already registered: ${def.name}`);
    }
    this.scopes.set(def.name, def);
    return def.name;
  }

  has(name: string): boolean {
    return this.scopes.has(name);
  }

  get(name: string): ScopeDef | undefined {
    return this.scopes.get(name);
  }

  /** All registered scopes, sorted by name (stable for the /scopes endpoint). */
  list(): ScopeDef[] {
    return [...this.scopes.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return this.list().map((s) => s.name);
  }
}

/** The process-wide scope registry. */
export const scopeRegistry = new ScopeRegistry();

/**
 * The canonical scope strings (PRD: Scope Registry). Registered as data below.
 * Reference these constants instead of string literals so a typo is a compile error.
 */
export const SCOPES = {
  DOCUMENTS_READ: 'documents:read',
  DOCUMENTS_WRITE: 'documents:write',
  ISSUES_READ: 'issues:read',
  ISSUES_WRITE: 'issues:write',
  SPRINTS_READ: 'sprints:read',
  SPRINTS_WRITE: 'sprints:write',
  WEBHOOKS_MANAGE: 'webhooks:manage',
} as const;

export type ScopeName = (typeof SCOPES)[keyof typeof SCOPES];

// Register the seven scopes as data. Adding a scope = adding a line here.
scopeRegistry.register({ name: SCOPES.DOCUMENTS_READ, description: 'Read documents (wikis, issues, projects, sprints).' });
scopeRegistry.register({ name: SCOPES.DOCUMENTS_WRITE, description: 'Create and update documents.' });
scopeRegistry.register({ name: SCOPES.ISSUES_READ, description: 'Read issues.' });
scopeRegistry.register({ name: SCOPES.ISSUES_WRITE, description: 'Create and update issues, change status and assignment.' });
scopeRegistry.register({ name: SCOPES.SPRINTS_READ, description: 'Read sprints (weeks) and their contents.' });
scopeRegistry.register({ name: SCOPES.SPRINTS_WRITE, description: 'Start and complete sprints, manage sprint membership.' });
scopeRegistry.register({ name: SCOPES.WEBHOOKS_MANAGE, description: 'Manage webhook subscriptions and replay deliveries.' });
