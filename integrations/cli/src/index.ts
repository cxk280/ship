#!/usr/bin/env node
/**
 * Ship CLI — the must-ship reference integration. Imports only @ship/sdk.
 *
 *   ship login                                    # OAuth Device Authorization Grant
 *   ship docs ls                                  # list documents
 *   ship docs get <id>                            # fetch a document
 *   ship docs create --title "hello"              # create a document (via the SDK)
 *   ship webhooks tail                            # stream signed deliveries to stdout
 *   ship listen --forward-to <url>               # local webhook tunnel (à la stripe listen)
 *     [--events <comma-list>]                     # default: document.created,document.updated,
 *                                                 #          issue.created,issue.assigned
 */
import { ShipClient, verifyWebhook, type CreatedSubscription } from '@ship/sdk';
import { BASE_URL, CLIENT_ID, SCOPES, tokenStore, client, credentialsPath } from './config.js';
import { startListener } from './webhook-listener.js';
import { verifyAndForward } from './forwarder.js';

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

const DEFAULT_LISTEN_EVENTS = [
  'document.created',
  'document.updated',
  'issue.created',
  'issue.assigned',
];

async function listen(args: string[]): Promise<void> {
  const forwardTo = flag(args, 'forward-to');
  if (!forwardTo) {
    console.error('usage: ship listen --forward-to <url> [--events <comma-list>]');
    console.error('\nForwards signed Ship webhook deliveries to a local URL.');
    console.error('\nOptions:');
    console.error('  --forward-to <url>    Target URL to forward deliveries to (required)');
    console.error('  --events <list>       Comma-separated event types to subscribe to');
    console.error(`                        Default: ${DEFAULT_LISTEN_EVENTS.join(',')}`);
    console.error('\nExample:');
    console.error('  ship listen --forward-to http://localhost:8080/webhooks');
    console.error('  ship listen --forward-to http://localhost:8080/webhooks --events document.created,issue.assigned');
    process.exitCode = 1;
    return;
  }

  const eventsArg = flag(args, 'events');
  const events = eventsArg
    ? eventsArg.split(',').map((e) => e.trim()).filter(Boolean)
    : DEFAULT_LISTEN_EVENTS;

  const c = client();
  const listener = await startListener();

  console.log(`\n  Ship webhook tunnel`);
  console.log(`  Local listener: ${listener.url}`);
  console.log(`  Forwarding to:  ${forwardTo}`);
  console.log(`  Events:         ${events.join(', ')}`);
  console.log(`\n  Ready! Waiting for webhook deliveries… (Ctrl+C to stop)\n`);

  // Create one subscription per event type
  const subscriptions: CreatedSubscription[] = [];
  for (const event of events) {
    const sub = await c.webhooks.create({ event, target_url: listener.url });
    subscriptions.push(sub);
    console.log(`  ✓ Subscribed to ${event}`);
  }
  console.log('');

  // Build a map from subscription id → signing secret for fast lookup
  const secretByEvent = new Map<string, string>();
  for (const sub of subscriptions) {
    secretByEvent.set(sub.event_type, sub.signing_secret);
  }

  listener.onDelivery(async (d) => {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 23);

    // Parse event type from payload
    let eventType = 'unknown';
    try {
      eventType = (JSON.parse(d.rawBody) as { type?: string }).type ?? 'unknown';
    } catch {
      /* ignore malformed body */
    }

    // Get the signing secret for this event type
    const secret = secretByEvent.get(eventType);
    if (!secret) {
      console.log(`${timestamp}  ${eventType.padEnd(24)}  sig ✗  [not forwarded — unknown event type]`);
      return;
    }

    const result = await verifyAndForward(d, secret, forwardTo, eventType);
    const sigMark = result.signatureOk ? '✓' : '✗';

    if (!result.signatureOk) {
      console.log(`${timestamp}  ${eventType.padEnd(24)}  sig ${sigMark}  [not forwarded — invalid signature]`);
      return;
    }

    if (result.forwardAttempted && result.forwardStatus !== null) {
      const statusMark = result.forwardStatus >= 200 && result.forwardStatus < 300 ? '✓' : '✗';
      console.log(`${timestamp}  ${eventType.padEnd(24)}  sig ${sigMark}  → ${result.forwardStatus} ${statusMark}  ${result.forwardLatencyMs}ms`);
    } else {
      console.log(`${timestamp}  ${eventType.padEnd(24)}  sig ${sigMark}  → [forward failed — could not reach ${forwardTo}]`);
    }
  });

  const cleanup = async () => {
    console.log('\n  Cleaning up subscriptions…');
    for (const sub of subscriptions) {
      try {
        await c.webhooks.delete(sub.id);
        console.log(`  ✓ Deleted subscription for ${sub.event_type}`);
      } catch {
        /* ignore cleanup errors */
      }
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
    case 'listen':
      // `ship listen --forward-to <url>` — all args after "listen" are flags
      return listen(sub ? [sub, ...rest] : rest);
    default:
      console.log(
        'Ship CLI — usage:\n' +
        '  ship login\n' +
        '  ship docs ls|get <id>|create --title "..."\n' +
        '  ship webhooks tail\n' +
        '  ship listen --forward-to <url> [--events <comma-list>]',
      );
  }
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
