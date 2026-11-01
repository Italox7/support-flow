import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@support-flow/shared';
import type { AuthenticatedRequest, RequestUser } from './auth.types.js';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';

/** Libera a rota do JwtAuthGuard global. Toda rota é autenticada por padrão. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restringe a rota aos papéis listados (checado pelo RolesGuard global). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Usuário autenticado da requisição. Só use em rotas que não são @Public(). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new Error('CurrentUser usado em rota sem autenticação');
    return user;
  },
);
