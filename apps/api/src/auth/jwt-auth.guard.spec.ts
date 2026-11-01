import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const SECRET = 's'.repeat(32);
const jwt = new JwtService({
  secret: SECRET,
  signOptions: { algorithm: 'HS256', expiresIn: 900 },
  verifyOptions: { algorithms: ['HS256'] },
});
const guard = new JwtAuthGuard(new Reflector(), jwt);

let request: AuthenticatedRequest;

function contextFor(authorization?: string, isPublic = false) {
  const handler = () => undefined;
  if (isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  request = { headers: { authorization } } as AuthenticatedRequest;
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function unsigned(payload: object): string {
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

describe('JwtAuthGuard', () => {
  beforeEach(() => {
    request = { headers: {} } as AuthenticatedRequest;
  });

  it('anexa o usuário quando o token é válido', async () => {
    const token = await jwt.signAsync({ sub: 'u1', role: 'AGENT' });
    await expect(guard.canActivate(contextFor(`Bearer ${token}`))).resolves.toBe(true);
    expect(request.user).toEqual({ id: 'u1', role: 'AGENT' });
  });

  it('libera rota @Public() sem token', async () => {
    await expect(guard.canActivate(contextFor(undefined, true))).resolves.toBe(true);
  });

  it.each([
    ['sem header', undefined],
    ['esquema errado', 'Basic abc'],
    ['token vazio', 'Bearer '],
    ['token malformado', 'Bearer abc.def.ghi'],
  ])('rejeita %s', async (_case, header) => {
    await expect(guard.canActivate(contextFor(header))).rejects.toThrow(UnauthorizedException);
  });

  it('rejeita token assinado com outro segredo', async () => {
    const other = new JwtService({ secret: 'o'.repeat(32) });
    const token = await other.signAsync({ sub: 'u1', role: 'ADMIN' });
    await expect(guard.canActivate(contextFor(`Bearer ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejeita token com alg none', async () => {
    const token = unsigned({ sub: 'u1', role: 'ADMIN', exp: Math.floor(Date.now() / 1000) + 60 });
    await expect(guard.canActivate(contextFor(`Bearer ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejeita token expirado', async () => {
    const token = await jwt.signAsync({ sub: 'u1', role: 'AGENT' }, { expiresIn: -10 });
    await expect(guard.canActivate(contextFor(`Bearer ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejeita token com papel desconhecido', async () => {
    const token = await jwt.signAsync({ sub: 'u1', role: 'ROOT' });
    await expect(guard.canActivate(contextFor(`Bearer ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
