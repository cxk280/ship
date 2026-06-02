/**
 * ShipClient — the typed entry point. Resource clients are segregated (ISP):
 * a consumer that only touches documents never sees webhook types.
 */
import { Http } from './http.js';
import { DocumentsClient } from './resources/documents.js';
import { IssuesClient } from './resources/issues.js';
import { SprintsClient } from './resources/sprints.js';
import { WebhooksClient } from './resources/webhooks.js';
import { InMemoryTokenStore, type ITokenStore } from './token-store.js';
import { runDeviceLogin, type DeviceLoginOptions } from './auth/device.js';
import type { MeResponse } from './types.js';

export interface ShipClientOptions {
  /** Server origin, e.g. https://ship.example.com. Default http://localhost:3000. */
  baseUrl?: string;
  /** Convenience: a pre-obtained access token (wrapped in an in-memory store). */
  token?: string;
  /** Or supply a token store (file/localStorage/in-memory). Takes precedence. */
  tokenStore?: ITokenStore;
  /** Enables refresh-on-401. */
  clientId?: string;
  clientSecret?: string;
}

export class ShipClient {
  private readonly http: Http;
  readonly documents: DocumentsClient;
  readonly issues: IssuesClient;
  readonly sprints: SprintsClient;
  readonly webhooks: WebhooksClient;

  constructor(opts: ShipClientOptions = {}) {
    const origin = (opts.baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
    const tokenStore = opts.tokenStore ?? new InMemoryTokenStore(opts.token ? { access_token: opts.token } : undefined);
    this.http = new Http({ origin, tokenStore, clientId: opts.clientId, clientSecret: opts.clientSecret });
    this.documents = new DocumentsClient(this.http);
    this.issues = new IssuesClient(this.http);
    this.sprints = new SprintsClient(this.http);
    this.webhooks = new WebhooksClient(this.http);
  }

  /** The authenticated principal (user for delegated tokens, app for client-credentials). */
  me(): Promise<MeResponse> {
    return this.http.request<MeResponse>('GET', '/me');
  }

  /**
   * Device Authorization Grant login (the CLI's `ship login`). Resolves to a
   * ready-to-use ShipClient backed by the resulting tokens.
   */
  static async deviceLogin(opts: DeviceLoginOptions): Promise<ShipClient> {
    const result = await runDeviceLogin(opts);
    return new ShipClient({
      baseUrl: result.origin,
      tokenStore: result.tokenStore,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
    });
  }
}
