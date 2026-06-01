/**
 * The SDK's HTTP layer: attaches the bearer token from the token store, maps
 * non-2xx ApiError bodies to typed ShipErrors, and (optionally) refreshes a
 * rotated token once on a 401 when a refresh token + client_id are configured.
 */
import { ShipError, type ApiErrorBody } from './errors.js';
import type { ITokenStore } from './token-store.js';

export interface HttpConfig {
  /** Server origin, e.g. https://ship.example.com (no trailing slash). */
  origin: string;
  tokenStore: ITokenStore;
  /** For refresh-on-401. */
  clientId?: string;
  clientSecret?: string;
}

export class Http {
  constructor(private readonly cfg: HttpConfig) {}

  get apiBase(): string {
    return `${this.cfg.origin}/api/v1`;
  }
  get oauthBase(): string {
    return `${this.cfg.origin}/oauth`;
  }

  async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; _retried?: boolean } = {},
  ): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const stored = await this.cfg.tokenStore.get();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (stored?.access_token) headers.Authorization = `Bearer ${stored.access_token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw ShipError.network(e instanceof Error ? e.message : 'network error');
    }

    if (res.status === 401 && !opts._retried && (await this.tryRefresh())) {
      return this.request<T>(method, path, { ...opts, _retried: true });
    }

    if (!res.ok) {
      let body: ApiErrorBody = { code: 'server_error', message: `HTTP ${res.status}` };
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        /* non-JSON error body */
      }
      throw ShipError.fromResponse(res.status, body);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Attempt a one-time refresh-token rotation. Returns true if a new token was stored. */
  private async tryRefresh(): Promise<boolean> {
    const stored = await this.cfg.tokenStore.get();
    if (!stored?.refresh_token || !this.cfg.clientId) return false;
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
      client_id: this.cfg.clientId,
    });
    if (this.cfg.clientSecret) form.set('client_secret', this.cfg.clientSecret);
    try {
      const res = await fetch(`${this.oauthBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (!res.ok) {
        await this.cfg.tokenStore.clear();
        return false;
      }
      const t = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      await this.cfg.tokenStore.set({
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? stored.refresh_token,
        expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
        scope: t.scope,
      });
      return true;
    } catch {
      return false;
    }
  }
}
