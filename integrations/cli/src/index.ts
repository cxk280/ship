#!/usr/bin/env node
/**
 * Ship CLI — the must-ship reference integration. Imports only @ship/sdk.
 *
 *   ship login                          # OAuth Device Authorization Grant
 *   ship docs ls                        # list documents
 *   ship docs get <id>                  # fetch a document
 *   ship docs create --title "hello"    # create a document (via the SDK)
 *   ship webhooks tail                  # stream signed deliveries to stdout
 */
import { ShipClient, verifyWebhook } from '@ship/sdk';
import { BASE_URL, CLIENT_ID, SCOPES, tokenStore, client, credentialsPath } from './config.js';
import { startListener } from './webhook-listener.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function login(): Promise<void> {
  await ShipClient.deviceLogin({
    origin: BASE_URL,
    clientId: CLIENT_ID,
    scope: SCOPES,
    tokenStore,
    onUserCode: (code, verifyUrl) => {
      console.log(`\n  To sign in, open:  ${verifyUrl}`);
      console.log(`  and enter the code:  ${code}\n  Waiting for approval…`);
    },
  });
  console.log(`✓ Logged in. Token saved to ${credentialsPath}`);
}

async function docs(sub: string | undefined, args: string[]): Promise<void> {
  const c = client();
  if (sub === 'ls') {
    const page = await c.documents.list({ limit: 25 });
    for (const d of page.data) console.log(`${d.id}  ${d.document_type.padEnd(8)}  ${d.title}`);
  } else if (sub === 'get') {
    const doc = await c.documents.get(args[0]!);
    console.log(JSON.stringify(doc, null, 2));
  } else if (sub === 'create') {
    const title = flag(args, 'title') ?? 'Untitled';
    const doc = await c.documents.create({ title });
    console.log(`✓ Created ${doc.id}  "${doc.title}"`);
  } else {
    console.error('usage: ship docs <ls|get <id>|create --title "..."> ');
    process.exitCode = 1;
  }
}

async function webhooksTail(): Promise<void> {
  const c = client();
  const listener = await startListener();
  const sub = await c.webhooks.create({ event: 'document.created', target_url: listener.url });
  console.log(`✓ Subscribed to document.created → ${listener.url}`);
  console.log('  Streaming signed deliveries (Ctrl+C to stop)…\n');

  listener.onDelivery((d) => {
    const ok = verifyWebhook(d.headers, d.rawBody, sub.signing_secret);
    let label = '';
    try {
      label = (JSON.parse(d.rawBody) as { type?: string }).type ?? '';
    } catch {
      /* ignore */
    }
    console.log(`→ ${label}  ${ok ? 'signature verified ✓' : 'INVALID SIGNATURE ✗'}`);
  });

  const cleanup = async () => {
    try {
      await c.webhooks.delete(sub.id);
    } catch {
      /* ignore */
    }
    await listener.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  await new Promise(() => {}); // run until interrupted
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'login':
      return login();
    case 'docs':
      return docs(sub, rest);
    case 'webhooks':
      if (sub === 'tail') return webhooksTail();
      console.error('usage: ship webhooks tail');
      process.exitCode = 1;
      return;
    default:
      console.log('Ship CLI — usage:\n  ship login\n  ship docs ls|get <id>|create --title "..."\n  ship webhooks tail');
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
