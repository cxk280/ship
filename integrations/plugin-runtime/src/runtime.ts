/**
 * ⚠️  EXPERIMENTAL — Ship Plugin Runtime (node:vm implementation)
 *
 * SECURITY CAVEAT: This implementation uses Node's built-in `node:vm` module,
 * which provides context isolation but is NOT a true security sandbox. Code
 * running in a vm.Script can escape the sandbox through prototype chain attacks,
 * shared native objects, or async callback shenanigans. It is SAFE for
 * first-party or trusted plugins but MUST NOT be used to run untrusted
 * third-party code without a proper sandbox like `isolated-vm` or a worker
 * subprocess with `--no-experimental-*` flags.
 *
 * For production-grade sandboxing, replace the `runInContext` call with
 * `isolated-vm` (npm: isolated-vm) and set `memoryLimitMb` there. The API
 * surface of this module is designed to make that swap straightforward.
 *
 * One hook supported today: `document.beforeCreate`.
 */
import vm from 'node:vm';
import type { DocumentContext, PluginManifest, RuntimeOptions, HookResult } from './types.js';

export class PluginRuntimeError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'memory' | 'veto' | 'runtime',
  ) {
    super(message);
    this.name = 'PluginRuntimeError';
  }
}

/**
 * Run a plugin's `document.beforeCreate` hook against a context.
 *
 * The plugin source must export a function via `module.exports`:
 *
 *   module.exports = function beforeCreate(ctx) {
 *     ctx.title = ctx.title.trim();
 *     if (!ctx.title) throw new Error('Title cannot be empty');
 *     return ctx;
 *   };
 *
 * The hook may be sync or return a thenable. Throw to veto creation.
 */
export async function runBeforeCreate(
  manifest: PluginManifest,
  context: DocumentContext,
  opts: RuntimeOptions = {},
): Promise<HookResult> {
  const cpuLimit = opts.cpuTimeLimitMs ?? 500;
  // memoryLimitBytes is informational here (node:vm doesn't enforce it);
  // with isolated-vm you'd pass memoryLimitMb = memoryLimitBytes / (1024*1024).
  const _memoryLimit = opts.memoryLimitBytes ?? 8 * 1024 * 1024; // 8MB

  // Build a minimal sandbox. Expose only a safe subset of globals.
  const sandbox = {
    // node:vm CommonJS shim
    module: { exports: {} as unknown },
    exports: {} as unknown,
    console: {
      log: (...args: unknown[]) => console.log(`[plugin:${manifest.name}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[plugin:${manifest.name}]`, ...args),
      error: (...args: unknown[]) => console.error(`[plugin:${manifest.name}]`, ...args),
    },
    // No setTimeout/setInterval/fetch/require/process — intentionally absent.
  };
  vm.createContext(sandbox);

  // Execute the plugin module code.
  const script = new vm.Script(manifest.source, {
    filename: `plugin:${manifest.name}@${manifest.version}`,
  });

  try {
    script.runInContext(sandbox, { timeout: cpuLimit });
  } catch (err) {
    if (err instanceof Error && err.message.includes('timed out')) {
      throw new PluginRuntimeError(`Plugin "${manifest.name}" exceeded CPU limit (${cpuLimit}ms)`, 'timeout');
    }
    throw new PluginRuntimeError(
      `Plugin "${manifest.name}" threw during load: ${err instanceof Error ? err.message : String(err)}`,
      'runtime',
    );
  }

  const hookFn = (sandbox.module as { exports: unknown }).exports as (ctx: DocumentContext) => unknown;
  if (typeof hookFn !== 'function') {
    throw new PluginRuntimeError(
      `Plugin "${manifest.name}" did not export a function via module.exports`,
      'runtime',
    );
  }

  // Deep-clone the context so the plugin can't mutate caller's object directly.
  const ctxCopy: DocumentContext = JSON.parse(JSON.stringify(context)) as DocumentContext;

  // Add the cloned context and result slot to the sandbox so the call script
  // can pass them. We call the hook synchronously inside a new vm.Script so
  // the timeout option applies to the hook body itself (not just module load).
  (sandbox as Record<string, unknown>)['__ctx'] = ctxCopy;
  (sandbox as Record<string, unknown>)['__result'] = undefined;

  const callScript = new vm.Script('__result = module.exports(__ctx);', {
    filename: `plugin:${manifest.name}@${manifest.version}/call`,
  });

  const t0 = performance.now();
  try {
    callScript.runInContext(sandbox, { timeout: cpuLimit });
  } catch (err) {
    // NOTE: errors thrown by vm.Script's timeout have a different Error prototype
    // (vm context's own Error), so `instanceof Error` is false. We use duck-typing
    // on the .code property which Node sets to ERR_SCRIPT_EXECUTION_TIMEOUT.
    const code = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? String(err);
    if (
      code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
      message.includes('timed out') ||
      message.includes('Script execution timed out')
    ) {
      throw new PluginRuntimeError(`Plugin "${manifest.name}" exceeded CPU limit (${cpuLimit}ms)`, 'timeout');
    }
    // Plugin threw deliberately to veto (or runtime error).
    throw new PluginRuntimeError(
      `Plugin "${manifest.name}" vetoed document.beforeCreate: ${message}`,
      'veto',
    );
  }
  const elapsedMs = performance.now() - t0;

  const result = (sandbox as Record<string, unknown>)['__result'];
  if (!result || typeof result !== 'object') {
    throw new PluginRuntimeError(
      `Plugin "${manifest.name}" must return a DocumentContext object`,
      'runtime',
    );
  }

  return { context: result as DocumentContext, elapsedMs };
}
