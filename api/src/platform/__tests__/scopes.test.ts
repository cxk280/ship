/**
 * Unit tests for ScopeRegistry (scopes-as-data / OCP) and require(scope).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { scopeRegistry, SCOPES } from '../scopes/registry.js';
import { requireScope } from '../scopes/require-scope.js';
import { ApiError } from '../errors.js';

describe('ScopeRegistry', () => {
  it('registers the seven PRD scopes as data', () => {
    expect(scopeRegistry.names()).toEqual([
      'documents:read',
      'documents:write',
      'issues:read',
      'issues:write',
      'sprints:read',
      'sprints:write',
      'webhooks:manage',
    ]);
  });

  it('every registered scope has a human description', () => {
    for (const def of scopeRegistry.list()) {
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});

describe('requireScope factory', () => {
  it('throws at wiring time for an unregistered scope (fail fast at boot)', () => {
    expect(() => requireScope('documents:delete')).toThrow(/unknown scope/i);
  });

  it('calls next() when the granted scopes include the required one', () => {
    const mw = requireScope(SCOPES.DOCUMENTS_READ);
    const req = { platformAuth: { scopes: ['documents:read', 'issues:read'] } } as unknown as Request;
    const next = vi.fn();
    mw(req, {} as Response, next);
    expect(next).toHaveBeenCalledWith(); // no error
  });

  it('403s naming the MISSING scope explicitly (never opaque "forbidden")', () => {
    const mw = requireScope(SCOPES.DOCUMENTS_WRITE);
    const req = { platformAuth: { scopes: ['documents:read'] } } as unknown as Request;
    const next = vi.fn();
    mw(req, {} as Response, next);
    const err = next.mock.calls[0]?.[0] as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain('documents:write');
    expect(err.details).toMatchObject({
      required_scope: 'documents:write',
      granted_scopes: ['documents:read'],
    });
  });

  it('401s when there is no authenticated principal', () => {
    const mw = requireScope(SCOPES.DOCUMENTS_READ);
    const req = {} as unknown as Request;
    const next = vi.fn();
    mw(req, {} as Response, next);
    const err = next.mock.calls[0]?.[0] as ApiError;
    expect(err.status).toBe(401);
  });
});
