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
  url: string;
  port: number;
  /** Resolves on the next delivery (within timeoutMs, else rejects). */
  waitFor(timeoutMs: number): Promise<ReceivedDelivery>;
  onDelivery(cb: (d: ReceivedDelivery) => void): void;
  close(): Promise<void>;
}

export async function startListener(): Promise<Listener> {
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

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/`,
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
