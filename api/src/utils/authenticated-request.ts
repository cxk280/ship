import type { Request } from 'express';

export type AuthenticatedRequest = Request & {
  userId: string;
  workspaceId: string;
};

export function assertAuthenticatedRequest(req: Request): asserts req is AuthenticatedRequest {
  if (!req.userId || !req.workspaceId) {
    throw new Error('Authenticated route reached without user/workspace context');
  }
}
