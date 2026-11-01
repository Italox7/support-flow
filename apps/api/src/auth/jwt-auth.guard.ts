import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@support-flow/shared';
import { IS_PUBLIC_KEY } from './auth.decorators.js';
import type { AccessTokenPayload, AuthenticatedRequest } from './auth.types.js';

const ROLES = new Set<string>(Object.values(Role));

/** Guard global: exige `Authorization: Bearer <access token>` exceto em @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException();

    let payload: Partial<AccessTokenPayload>;
    try {
      // Algoritmo fixado no JwtModule (HS256): `alg: none` e troca de algoritmo falham aqui.
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException();
    }
    if (typeof payload.sub !== 'string' || !payload.role || !ROLES.has(payload.role)) {
      throw new UnauthorizedException();
    }

    request.user = { id: payload.sub, role: payload.role };
    return true;
  }
}
