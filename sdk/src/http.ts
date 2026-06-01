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
  private refreshPromise: Promise<boolean> | undefined;

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

    if (res.status === 401 && !opts._retried && (await this.tryRefresh(stored?.access_token))) {
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

  /**
   * Attempt a one-time refresh-token rotation. Concurrent 401s share the same
   * refresh so rotated refresh tokens are never submitted more than once.
   */
  private async tryRefresh(failedAccessToken?: string): Promise<boolean> {
    const stored = await this.cfg.tokenStore.get();
    if (stored?.access_token && failedAccessToken && stored.access_token !== failedAccessToken) {
      return true;
    }
    const clientId = this.cfg.clientId;
    const refreshToken = stored?.refresh_token;
    if (!refreshToken || !clientId) return false;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh(refreshToken, clientId).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async performRefresh(refreshToken: string, clientId: string): Promise<boolean> {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
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
        refresh_token: t.refresh_token ?? refreshToken,
        expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
        scope: t.scope,
      });
      return true;
    } catch {
      return false;
    }
  }
}
