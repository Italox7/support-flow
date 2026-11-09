import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedRequest } from './auth.types.js';

// Limites que o ThrottlerGuard global não expressa, porque ele conta por IP: por
// usuário e tetos da aplicação inteira. Usam o mesmo armazenamento em memória,
// suficiente para uma única instância; um cold start zera as contagens.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const USER_WRITE_LIMIT = 10;
export const GLOBAL_WRITE_LIMIT = 30;
export const GLOBAL_REGISTER_LIMIT = 30;

async function consume(
  storage: ThrottlerStorage,
  context: ExecutionContext,
  key: string,
  limit: number,
  ttl: number,
): Promise<void> {
  const { isBlocked, timeToBlockExpire } = await storage.increment(key, ttl, limit, ttl, 'default');
  if (!isBlocked) return;
  context.switchToHttp().getResponse<Response>().setHeader('Retry-After', timeToBlockExpire);
  throw new ThrottlerException();
}

/**
 * Escritas que entram no lock da atribuição ou enchem o banco: 10/min por usuário
 * em cada rota e 30/min somando todos. O cadastro é aberto e as senhas da demo são
 * públicas, então o limite por usuário sozinho não segura várias contas; o teto dá
 * uma folga conhecida ao banco, ao custo de um abuso contínuo travar as escritas.
 *
 * Roda em @UseGuards, depois do JwtAuthGuard global, e soma ao @Throttle por IP da
 * rota, não o substitui. Quem já passou do próprio limite não consome o teto, para
 * uma só conta não bloquear todo mundo. A chave por rota é `Classe.método`: renomear
 * o handler zera a contagem dele, e o teto de 30 é um só para todas as rotas.
 * Quais rotas usam o guard está fixado em rate-limit.bindings.spec.ts.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Só falta `user` numa rota @Public() por engano: sem ele não há o que contar.
    if (!user) throw new UnauthorizedException();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    await consume(
      this.storage,
      context,
      `user-write:${route}:${user.id}`,
      USER_WRITE_LIMIT,
      MINUTE_MS,
    );
    await consume(this.storage, context, 'global-write', GLOBAL_WRITE_LIMIT, MINUTE_MS);
    return true;
  }
}

/**
 * Teto de cadastros por hora, independente de IP: X-Forwarded-For forjado escapa
 * do limite por IP, e cada cadastro paga um argon2 e abre mais uma conta.
 */
@Injectable()
export class GlobalRegisterLimitGuard implements CanActivate {
  constructor(@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await consume(this.storage, context, 'global-register', GLOBAL_REGISTER_LIMIT, HOUR_MS);
    return true;
  }
}
