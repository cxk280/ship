/**
 * Pluggable token storage. The SDK reads the access token from here on each
 * request and writes rotated tokens back. Ships with in-memory and file stores;
 * a browser localStorage store is a few lines for SPA consumers.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms when the access token expires (best-effort). */
  expires_at?: number;
  scope?: string;
}

export interface ITokenStore {
  get(): Promise<StoredTokens | null> | StoredTokens | null;
  set(tokens: StoredTokens): Promise<void> | void;
  clear(): Promise<void> | void;
}

export class InMemoryTokenStore implements ITokenStore {
  private tokens: StoredTokens | null = null;
  constructor(initial?: StoredTokens) {
    this.tokens = initial ?? null;
  }
  get(): StoredTokens | null {
    return this.tokens;
  }
  set(tokens: StoredTokens): void {
    this.tokens = tokens;
  }
  clear(): void {
    this.tokens = null;
  }
}

/** Persists tokens to a JSON file (the CLI uses this — e.g. ~/.ship/credentials.json). */
export class FileTokenStore implements ITokenStore {
  constructor(private readonly path: string) {}
  get(): StoredTokens | null {
    try {
      if (!existsSync(this.path)) return null;
      return JSON.parse(readFileSync(this.path, 'utf8')) as StoredTokens;
    } catch {
      return null;
    }
  }
  set(tokens: StoredTokens): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }
  clear(): void {
    try {
      writeFileSync(this.path, JSON.stringify(null), { mode: 0o600 });
    } catch {
      /* ignore */
    }
  }
}
