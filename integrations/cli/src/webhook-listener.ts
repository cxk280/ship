/**
 * A tiny local HTTP listener that captures the RAW request body (needed to verify
 * the HMAC signature). Used by `ship webhooks tail` and the TTFE drill.
 */
import http from 'node:http';

export interface ReceivedDelivery {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export interface Listener {
  /** The URL to subscribe with — the public tunnel URL when one is given, else the local one. */
  url: string;
  /** Always the local URL the HTTP server is bound to (for logging/diagnostics). */
  localUrl: string;
  port: number;
  /** Resolves on the next delivery (within timeoutMs, else rejects). */
  waitFor(timeoutMs: number): Promise<ReceivedDelivery>;
  onDelivery(cb: (d: ReceivedDelivery) => void): void;
  close(): Promise<void>;
}

export interface ListenerOptions {
  /**
   * Bind the local server to a FIXED port instead of an ephemeral one. Required when
   * a tunnel (e.g. `ngrok http <port>`) forwards to it — the tunnel target must be stable.
   * Defaults to an OS-assigned port (0), preserving the original behavior (and the drill's).
   */
  port?: number;
  /**
   * A public URL that reaches this listener through a tunnel. When set, subscriptions are
   * created with THIS url (so a remote/deployed Ship can deliver), while the server still
   * binds locally. Without it, the local `http://127.0.0.1:<port>/` url is used.
   */
  publicUrl?: string;
}

export async function startListener(opts: ListenerOptions = {}): Promise<Listener> {
  const callbacks: ((d: ReceivedDelivery) => void)[] = [];
  const waiters: { resolve: (d: ReceivedDelivery) => void }[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const delivery: ReceivedDelivery = {
        headers: req.headers,
        rawBody: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(200).end('ok');
      for (const cb of callbacks) cb(delivery);
      while (waiters.length) waiters.shift()!.resolve(delivery);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const localUrl = `http://127.0.0.1:${port}/`;
  // Normalize the public url to a single trailing slash so it matches the local url shape.
  const url = opts.publicUrl ? `${opts.publicUrl.replace(/\/+$/, '')}/` : localUrl;

  return {
    url,
    localUrl,
    port,
    onDelivery: (cb) => callbacks.push(cb),
    waitFor: (timeoutMs) =>
      new Promise<ReceivedDelivery>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a webhook delivery')), timeoutMs);
        waiters.push({ resolve: (d) => { clearTimeout(timer); resolve(d); } });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
