/**
 * @ship/sdk — typed TypeScript client for the Ship public API.
 *
 * Zero runtime dependencies (native fetch + node:crypto), so the production
 * install stays well under the 250 KB budget.
 */
export { ShipClient, type ShipClientOptions } from './client.js';
export { DocumentsClient } from './resources/documents.js';
export { IssuesClient } from './resources/issues.js';
export { SprintsClient } from './resources/sprints.js';
export {
  WebhooksClient,
  type WebhookSubscription,
  type CreatedSubscription,
  type WebhookDelivery,
} from './resources/webhooks.js';
export { ShipError, type ShipErrorKind } from './errors.js';
export {
  InMemoryTokenStore,
  FileTokenStore,
  type ITokenStore,
  type StoredTokens,
} from './token-store.js';
export { runDeviceLogin, type DeviceLoginOptions, type DeviceLoginResult } from './auth/device.js';
export {
  verifyWebhook,
  computeSignature,
  parseSignatureHeader,
  SHIP_SIGNATURE_HEADER,
} from './webhooks/verify.js';
export type {
  ShipUser,
  MeResponse,
  ShipDocument,
  Page,
  ListDocumentsParams,
  CreateDocumentInput,
  ShipIssue,
  IssueState,
  IssuePriority,
  ListIssuesParams,
  CreateIssueInput,
  ShipSprint,
  SprintStatus,
  ListSprintsParams,
} from './types.js';
