import type { Role } from '@support-flow/shared';
import type { Request } from 'express';

/** Claims do access token. */
export interface AccessTokenPayload {
  sub: string;
  role: Role;
}

/**
 * Identidade anexada à requisição pelo JwtAuthGuard. O papel vem do token: uma
 * mudança de papel só vale para o usuário no próximo refresh (até 15 min).
 */
export interface RequestUser {
  id: string;
  role: Role;
}

export type AuthenticatedRequest = Request & { user?: RequestUser };
