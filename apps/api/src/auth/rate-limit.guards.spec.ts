import { HttpException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_REGISTER_LIMIT,
  GLOBAL_WRITE_LIMIT,
  GlobalRegisterLimitGuard,
  USER_WRITE_LIMIT,
  UserRateLimitGuard,
} from './rate-limit.guards.js';

class TicketsController {}
function create() {}
function comment() {}

function contextFor(userId: string | undefined, handler = create) {
  const headers = new Map<string, unknown>();
  const context = {
    getClass: () => TicketsController,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({ user: userId ? { id: userId, role: 'CUSTOMER' } : undefined }),
      getResponse: () => ({
        setHeader: (name: string, value: unknown) => headers.set(name, value),
      }),
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

describe('limites de escrita', () => {
  const expect429 = async (run: Promise<unknown>) => {
    const error = await run.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
  };

  it('recusa sem usuário, em vez de contar todos num balde só', async () => {
    const guard = new UserRateLimitGuard(new ThrottlerStorageService());
    await expect(guard.canActivate(contextFor(undefined).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('bloqueia o usuário acima do limite, com Retry-After, sem atingir outro', async () => {
    const guard = new UserRateLimitGuard(new ThrottlerStorageService());
    for (let i = 0; i < USER_WRITE_LIMIT; i++) {
      await expect(guard.canActivate(contextFor('a').context)).resolves.toBe(true);
    }
    const blocked = contextFor('a');
    await expect429(guard.canActivate(blocked.context));
    expect(blocked.headers.get('Retry-After')).toBeGreaterThan(0);
    await expect(guard.canActivate(contextFor('b').context)).resolves.toBe(true);
  });

  it('conta cada rota separadamente para o mesmo usuário', async () => {
    const guard = new UserRateLimitGuard(new ThrottlerStorageService());
    for (let i = 0; i < USER_WRITE_LIMIT; i++) await guard.canActivate(contextFor('a').context);
    await expect(guard.canActivate(contextFor('a', comment).context)).resolves.toBe(true);
  });

  it('o teto soma todos os usuários e as duas rotas', async () => {
    const guard = new UserRateLimitGuard(new ThrottlerStorageService());
    for (let i = 0; i < GLOBAL_WRITE_LIMIT; i++) {
      const handler = i % 2 === 0 ? create : comment;
      await guard.canActivate(contextFor(`u${i}`, handler).context);
    }
    await expect429(guard.canActivate(contextFor('novo').context));
  });

  it('quem já passou do próprio limite não consome o teto', async () => {
    const guard = new UserRateLimitGuard(new ThrottlerStorageService());
    for (let i = 0; i < USER_WRITE_LIMIT; i++) await guard.canActivate(contextFor('a').context);
    for (let i = 0; i < GLOBAL_WRITE_LIMIT; i++) {
      await expect429(guard.canActivate(contextFor('a').context));
    }
    await expect(guard.canActivate(contextFor('b').context)).resolves.toBe(true);
  });

  it('o teto de cadastro não depende de quem pede', async () => {
    const guard = new GlobalRegisterLimitGuard(new ThrottlerStorageService());
    for (let i = 0; i < GLOBAL_REGISTER_LIMIT; i++) {
      await expect(guard.canActivate(contextFor(undefined).context)).resolves.toBe(true);
    }
    const blocked = contextFor(undefined);
    await expect429(guard.canActivate(blocked.context));
    expect(blocked.headers.get('Retry-After')).toBeGreaterThan(60);
  });
});
