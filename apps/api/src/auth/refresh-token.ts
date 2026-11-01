import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';

export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REFRESH_COOKIE = 'refresh_token';

/**
 * Secure sempre: navegadores aceitam cookie Secure em http://localhost, e assim
 * não existe configuração em que ele saia sem TLS. Path restrito às rotas de
 * auth para o cookie não acompanhar as demais requisições.
 */
const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth',
};

/** 256 bits aleatórios; só o hash vai para o banco. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 basta (sem salt nem argon2): o token já tem entropia máxima. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: REFRESH_TOKEN_TTL_MS });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, COOKIE_OPTIONS);
}
