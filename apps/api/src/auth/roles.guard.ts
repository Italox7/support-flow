import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@support-flow/shared';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest } from './auth.types.js';

/**
 * Guard global, roda depois do JwtAuthGuard. Sem @Roles(), qualquer usuário
 * autenticado passa; o escopo dos dados (cliente só vê o que é seu) fica nos
 * serviços, não aqui.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (!roles || roles.length === 0) return true;

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}
