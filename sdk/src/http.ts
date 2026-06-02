/**
 * The SDK's HTTP layer: attaches the bearer token from the token store, maps
 * non-2xx ApiError bodies to typed ShipErrors, and (optionally) refreshes a
 * rotated token once on a 401 when a refresh token + client_id are configured.
 *
 * DX additions (B7 polish):
 * - Auto-retry with exponential back-off + jitter on 429 / 5xx / network errors.
 *   Respects `Retry-After` on 429. Cap is configurable via `maxRetries` (default 3).
 * - AbortSignal threading: pass `signal` in request options; checked between retries.
 * - `X-Request-Id` response header is surfaced on every thrown ShipError.
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
  /**
   * Maximum number of retry attempts on transient errors (429, 5xx, network).
   * Default: 3. Set to 0 to disable retries entirely.
   */
  maxRetries?: number;
}

/** Request-level options accepted by `Http.request`. */
export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Extra headers to merge into this request (e.g. Idempotency-Key). */
  headers?: Record<string, string>;
  /**
   * An AbortSignal that cancels the request (and any pending retry delay).
   * Rejection is a `network`-kind ShipError wrapping the abort reason.
   */
  signal?: AbortSignal;
  /** Internal: prevent re-entry into refresh-on-401 after a token refresh. */
  _retried?: boolean;
  /** Internal: current retry attempt count (not part of public surface). */
  _attempt?: number;
}

/** Statuses we retry. 4xx other than 429 are not retried. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Exponential back-off with full jitter: base * 2^attempt with 50–100 % of that range.
 * Capped at 30 s.
 */
function backoffMs(attempt: number, baseMs = 250): number {
  const exp = Math.min(baseMs * 2 ** attempt, 30_000);
  return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

/** A tiny sleep that resolves early if `signal` fires. Returns true if aborted. */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(true);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Http {
  private refreshPromise: Promise<boolean> | undefined;
  readonly maxRetries: number;

  constructor(private readonly cfg: HttpConfig) {
    this.maxRetries = cfg.maxRetries ?? 3;
  }

  get apiBase(): string {
    return `${this.cfg.origin}/api/v1`;
  }
  get oauthBase(): string {
    return `${this.cfg.origin}/oauth`;
  }

  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const { signal, _attempt = 0, _retried = false } = opts;

    // Check for an already-aborted signal before even attempting the fetch.
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason.message : 'Request aborted';
      throw ShipError.network(reason);
    }

    const url = new URL(`${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const stored = await this.cfg.tokenStore.get();
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (stored?.access_token) headers.Authorization = `Bearer ${stored.access_token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal,
      });
    } catch (e) {
      // AbortError from fetch itself.
      if (e instanceof Error && e.name === 'AbortError') {
        throw ShipError.network(e.message || 'Request aborted');
      }

      // Transient network error — retry if we have budget.
      if (_attempt < this.maxRetries) {
        const aborted = await sleepOrAbort(backoffMs(_attempt), signal);
        if (aborted) throw ShipError.network('Request aborted');
        return this.request<T>(method, path, { ...opts, _attempt: _attempt + 1, _retried });
      }
      throw ShipError.network(e instanceof Error ? e.message : 'network error');
    }

    // --- Refresh-on-401 (one-shot, not counted as a retry attempt) ------------
    if (res.status === 401 && !_retried && (await this.tryRefresh(stored?.access_token))) {
      return this.request<T>(method, path, { ...opts, _retried: true, _attempt });
    }

    // --- Retryable status codes -----------------------------------------------
    if (isRetryable(res.status) && _attempt < this.maxRetries) {
      let delayMs: number;
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        delayMs = retryAfter ? parseFloat(retryAfter) * 1000 : backoffMs(_attempt);
      } else {
        delayMs = backoffMs(_attempt);
      }
      const aborted = await sleepOrAbort(delayMs, signal);
      if (aborted) throw ShipError.network('Request aborted');
      return this.request<T>(method, path, { ...opts, _attempt: _attempt + 1, _retried });
    }

    // --- Error mapping --------------------------------------------------------
    if (!res.ok) {
      let body: ApiErrorBody = { code: 'server_error', message: `HTTP ${res.status}` };
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        /* non-JSON error body */
      }
      // Surface request_id from body or from response header (whichever is present).
      const requestId =
        body.request_id ??
        res.headers.get('X-Request-Id') ??
        res.headers.get('request_id') ??
        undefined;
      throw ShipError.fromResponse(res.status, { ...body, request_id: requestId });
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
