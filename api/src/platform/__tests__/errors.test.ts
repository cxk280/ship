/**
 * Unit tests for the public ApiError contract and error middleware.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError, apiErrorHandler, requestIdMiddleware } from '../errors.js';

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  status: (code: number) => FakeRes;
  json: (b: unknown) => FakeRes;
  setHeader: (k: string, v: string) => FakeRes;
}

function mockRes(): FakeRes {
  const res: FakeRes = {
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
      return res;
    },
  };
  return res;
}

const asRes = (r: FakeRes) => r as unknown as Response;

describe('ApiError', () => {
  it('maps each code to the right HTTP status', () => {
    expect(ApiError.unauthorized().status).toBe(401);
    expect(ApiError.forbidden().status).toBe(403);
    expect(ApiError.notFound().status).toBe(404);
    expect(ApiError.validation().status).toBe(400);
    expect(ApiError.rateLimited().status).toBe(429);
    expect(ApiError.server().status).toBe(500);
  });

  it('serializes to {code,message,details?,request_id} and omits empty details', () => {
    const withDetails = ApiError.forbidden('nope', { required_scope: 'documents:read' });
    expect(withDetails.toBody('rid-1')).toEqual({
      code: 'forbidden',
      message: 'nope',
      details: { required_scope: 'documents:read' },
      request_id: 'rid-1',
    });
    const noDetails = ApiError.notFound('gone');
    expect(noDetails.toBody('rid-2')).toEqual({
      code: 'not_found',
      message: 'gone',
      request_id: 'rid-2',
    });
    expect('details' in noDetails.toBody('rid-2')).toBe(false);
  });
});

describe('requestIdMiddleware', () => {
  it('honors a valid inbound X-Request-Id and echoes it', () => {
    const req = { headers: { 'x-request-id': 'caller-supplied' } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();
    requestIdMiddleware(req, asRes(res), next);
    expect(req.requestId).toBe('caller-supplied');
    expect(res.headers['X-Request-Id']).toBe('caller-supplied');
    expect(next).toHaveBeenCalledOnce();
  });

  it('mints a uuid when none supplied', () => {
    const req = { headers: {} } as unknown as Request;
    const res = mockRes();
    requestIdMiddleware(req, asRes(res), vi.fn());
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['X-Request-Id']).toBe(req.requestId);
  });
});

describe('apiErrorHandler', () => {
  it('passes an ApiError through with its status and stamps request_id', () => {
    const req = { requestId: 'rid-3' } as unknown as Request;
    const res = mockRes();
    apiErrorHandler(ApiError.unauthorized('nope'), req, asRes(res), vi.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ code: 'unauthorized', message: 'nope', request_id: 'rid-3' });
  });

  it('converts a ZodError into validation_failed (400)', () => {
    const req = { requestId: 'rid-4' } as unknown as Request;
    const res = mockRes();
    const zErr = z.object({ title: z.string() }).safeParse({});
    expect(zErr.success).toBe(false);
    if (zErr.success) return;
    apiErrorHandler(zErr.error, req, asRes(res), vi.fn());
    expect(res.statusCode).toBe(400);
    const body = res.body as { code: string; request_id: string; details?: unknown };
    expect(body.code).toBe('validation_failed');
    expect(body.request_id).toBe('rid-4');
    expect(body.details).toBeDefined();
  });

  it('never leaks an unexpected error — returns opaque server_error', () => {
    const req = { requestId: 'rid-5' } as unknown as Request;
    const res = mockRes();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiErrorHandler(new Error('SECRET internal detail'), req, asRes(res), vi.fn());
    expect(res.statusCode).toBe(500);
    const body = res.body as { code: string; message: string };
    expect(body.code).toBe('server_error');
    expect(body.message).not.toContain('SECRET');
    spy.mockRestore();
  });
});
