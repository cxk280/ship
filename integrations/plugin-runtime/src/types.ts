/**
 * Public types for the Ship plugin runtime.
 */

export interface DocumentContext {
  title: string;
  document_type: string;
  properties: Record<string, unknown>;
}

/** A hook that can mutate or veto a document before creation. */
export interface BeforeCreateHook {
  /** Return the (optionally mutated) context, or throw to veto. */
  (ctx: DocumentContext): DocumentContext | Promise<DocumentContext>;
}

export interface PluginManifest {
  name: string;
  version: string;
  /** JavaScript source (CommonJS-style module, no require/import). */
  source: string;
}

export interface RuntimeOptions {
  /** CPU time budget in milliseconds (wall-clock). Default 500ms. */
  cpuTimeLimitMs?: number;
  /** Approximate memory limit in bytes for the sandbox context. Default 8MB. */
  memoryLimitBytes?: number;
}

export interface HookResult {
  /** The (possibly mutated) document context after the hook ran. */
  context: DocumentContext;
  /** Wall-clock time spent in the hook, ms. */
  elapsedMs: number;
}
