/**
 * RFC 8628 Device Authorization Grant client — the flow behind `ship login`.
 *
 * Requests a device+user code, hands the user code to the caller (to display),
 * then polls /oauth/token honoring authorization_pending and slow_down until the
 * user approves. Returns the stored tokens.
 */
import { ShipError } from '../errors.js';
import { InMemoryTokenStore, type ITokenStore, type StoredTokens } from '../token-store.js';

export interface DeviceLoginOptions {
  /** Server origin, default http://localhost:3000. */
  origin?: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  /** Called with the user_code + the URL where the user enters it. */
  onUserCode: (userCode: string, verificationUri: string) => void;
  tokenStore?: ITokenStore;
  /** Override the server-advertised poll interval (ms). */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(ShipError.network('device login aborted'));
    });
  });
}

export interface DeviceLoginResult {
  origin: string;
  tokenStore: ITokenStore;
  tokens: StoredTokens;
}

export async function runDeviceLogin(opts: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const origin = (opts.origin ?? 'http://localhost:3000').replace(/\/$/, '');
  const tokenStore = opts.tokenStore ?? new InMemoryTokenStore();

  const startForm = new URLSearchParams({ client_id: opts.clientId });
  if (opts.scope) startForm.set('scope', opts.scope);
  const startRes = await fetch(`${origin}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: startForm.toString(),
  });
  if (!startRes.ok) {
    throw ShipError.network(`device authorization request failed (HTTP ${startRes.status})`);
  }
  const start = (await startRes.json()) as DeviceCodeResponse;
  opts.onUserCode(start.user_code, start.verification_uri_complete ?? start.verification_uri);

  let interval = opts.pollIntervalMs ?? Math.max(1, start.interval) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(interval, opts.signal);
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: start.device_code,
      client_id: opts.clientId,
    });
    if (opts.clientSecret) form.set('client_secret', opts.clientSecret);

    const res = await fetch(`${origin}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, string> & { expires_in?: number };

    if (res.ok) {
      const tokens: StoredTokens = {
        access_token: data.access_token!,
        refresh_token: data.refresh_token,
        expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined,
        scope: data.scope,
      };
      await tokenStore.set(tokens);
      return { origin, tokenStore, tokens };
    }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      interval += 5000; // RFC 8628 §3.5: back off by 5s
      continue;
    }
    if (data.error === 'access_denied') {
      throw new ShipError({ kind: 'auth', status: 403, code: 'access_denied', message: 'User denied the device login' });
    }
    throw new ShipError({
      kind: 'auth', status: 400, code: data.error ?? 'invalid_grant',
      message: data.error_description ?? 'Device login failed',
    });
  }
  throw new ShipError({ kind: 'auth', status: 408, code: 'expired_token', message: 'Device login timed out' });
}
