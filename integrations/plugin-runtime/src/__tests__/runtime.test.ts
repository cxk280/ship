/**
 * Tests for the plugin runtime.
 *
 * Covers:
 * - Successful hook mutation (uppercase-title plugin)
 * - Veto via thrown error (require-title plugin)
 * - CPU timeout enforcement (infinite-loop plugin)
 * - Memory safety: plugin cannot access host globals (process, require, fetch)
 * - Invalid export (not a function) → PluginRuntimeError
 */
import { describe, it, expect } from 'vitest';
import { runBeforeCreate, PluginRuntimeError } from '../runtime.js';
import {
  UPPERCASE_TITLE_PLUGIN,
  REQUIRE_TITLE_PLUGIN,
  DEFAULT_TAG_PLUGIN,
} from '../example-plugins.js';
import type { PluginManifest, DocumentContext } from '../types.js';

function manifest(name: string, source: string): PluginManifest {
  return { name, version: '0.1.0', source };
}

const baseCtx: DocumentContext = {
  title: 'hello world',
  document_type: 'wiki',
  properties: {},
};

describe('plugin runtime — document.beforeCreate', () => {
  it('uppercase-title plugin mutates the title', async () => {
    const result = await runBeforeCreate(manifest('uppercase', UPPERCASE_TITLE_PLUGIN), { ...baseCtx });
    expect(result.context.title).toBe('HELLO WORLD');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('require-title plugin passes a non-empty title', async () => {
    const result = await runBeforeCreate(manifest('require-title', REQUIRE_TITLE_PLUGIN), { ...baseCtx });
    expect(result.context.title).toBe('hello world');
  });

  it('require-title plugin VETO: throws PluginRuntimeError for empty title', async () => {
    const ctx = { ...baseCtx, title: '' };
    let caughtErr: unknown;
    try {
      await runBeforeCreate(manifest('require-title', REQUIRE_TITLE_PLUGIN), ctx);
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(PluginRuntimeError);
    expect((caughtErr as PluginRuntimeError).kind).toBe('veto');
  });

  it('default-tag plugin adds tags property', async () => {
    const result = await runBeforeCreate(manifest('default-tag', DEFAULT_TAG_PLUGIN), { ...baseCtx });
    expect(result.context.properties['tags']).toEqual(['untagged']);
  });

  it('default-tag plugin does not overwrite existing tags', async () => {
    const ctx: DocumentContext = { ...baseCtx, properties: { tags: ['existing'] } };
    const result = await runBeforeCreate(manifest('default-tag', DEFAULT_TAG_PLUGIN), ctx);
    expect(result.context.properties['tags']).toEqual(['existing']);
  });

  it('plugin cannot access process global', async () => {
    const source = `
module.exports = function(ctx) {
  if (typeof process !== 'undefined') {
    throw new Error('process should not be accessible');
  }
  return ctx;
};`;
    // If process were accessible, the plugin would throw and we'd get a veto error.
    // We expect it to succeed (process is undefined in the sandbox).
    const result = await runBeforeCreate(manifest('sandbox-check', source), { ...baseCtx });
    expect(result.context.title).toBe('hello world');
  });

  it('plugin cannot access require', async () => {
    const source = `
module.exports = function(ctx) {
  if (typeof require !== 'undefined') {
    throw new Error('require should not be accessible');
  }
  return ctx;
};`;
    const result = await runBeforeCreate(manifest('sandbox-check-require', source), { ...baseCtx });
    expect(result.context.title).toBe('hello world');
  });

  it('CPU timeout: infinite loop is terminated', async () => {
    const source = `
module.exports = function(ctx) {
  // Deliberately infinite loop to test CPU cap.
  let i = 0;
  while (true) { i++; }
  return ctx;
};`;
    let caughtErr: unknown;
    try {
      await runBeforeCreate(manifest('infinite-loop', source), baseCtx, { cpuTimeLimitMs: 300 });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(PluginRuntimeError);
    expect((caughtErr as PluginRuntimeError).kind).toBe('timeout');
  }, 10_000);

  it('invalid export (not a function) throws PluginRuntimeError', async () => {
    const source = `module.exports = { notAFunction: true };`;
    let caughtErr: unknown;
    try {
      await runBeforeCreate(manifest('bad-export', source), baseCtx);
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(PluginRuntimeError);
    expect((caughtErr as PluginRuntimeError).kind).toBe('runtime');
  });

  it('plugin context is deep-cloned (mutation does not affect caller)', async () => {
    const ctx: DocumentContext = { ...baseCtx, title: 'original' };
    const source = `
module.exports = function(ctx) {
  ctx.title = 'mutated';
  return ctx;
};`;
    await runBeforeCreate(manifest('mutation-test', source), ctx);
    // Caller's ctx should be untouched.
    expect(ctx.title).toBe('original');
  });
});
