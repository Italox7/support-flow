import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@support-flow/shared';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators.js';
import type { RequestUser } from './auth.types.js';
import { RolesGuard } from './roles.guard.js';

function contextFor(metadata: { roles?: Role[]; isPublic?: boolean }, user?: RequestUser) {
  const handler = () => undefined;
  if (metadata.roles) Reflect.defineMetadata(ROLES_KEY, metadata.roles, handler);
  if (metadata.isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const guard = new RolesGuard(new Reflector());
const agent: RequestUser = { id: 'u1', role: 'AGENT' };

describe('RolesGuard', () => {
  it('deixa passar rota sem @Roles()', () => {
    expect(guard.canActivate(contextFor({}, agent))).toBe(true);
  });

  it('deixa passar quando o papel está na lista', () => {
    expect(guard.canActivate(contextFor({ roles: ['AGENT', 'ADMIN'] }, agent))).toBe(true);
  });

  it('retorna 403 quando o papel não está na lista', () => {
    expect(() => guard.canActivate(contextFor({ roles: ['ADMIN'] }, agent))).toThrow(
      ForbiddenException,
    );
  });

  it('retorna 403 quando a rota exige papel e não há usuário', () => {
    expect(() => guard.canActivate(contextFor({ roles: ['ADMIN'] }))).toThrow(ForbiddenException);
  });

  it('ignora rotas @Public()', () => {
    expect(guard.canActivate(contextFor({ roles: ['ADMIN'], isPublic: true }))).toBe(true);
  });
});
