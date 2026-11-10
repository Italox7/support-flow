import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import { DEMO_EMAILS } from './demo-emails.js';
import { LOGIN_FAILURE_LIMIT, LoginAttempts, LoginLockedException } from './login-attempts.js';
import { hashPassword, PasswordHashBusyError, verifyPassword } from './password.js';
import type { RefreshTokensService } from './refresh-tokens.service.js';

vi.mock('./password.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./password.js')>()),
  hashPassword: vi.fn(async () => 'hash'),
  verifyPassword: vi.fn(async () => false),
}));

const USER = { id: 'u1', email: 'a@x.com', name: 'A', role: 'CUSTOMER', passwordHash: 'hash' };

function setup(DEMO_RESET_ENABLED = false) {
  const prisma = {
    user: { findUnique: vi.fn(async () => USER), create: vi.fn(async () => USER) },
  };
  const attempts = new LoginAttempts();
  const service = new AuthService(
    prisma as unknown as PrismaService,
    { signAsync: vi.fn(async () => 'jwt') } as unknown as JwtService,
    { issue: vi.fn(async () => 'refresh') } as unknown as RefreshTokensService,
    attempts,
    { DEMO_RESET_ENABLED },
  );
  return { service, prisma, attempts };
}

const login = (service: AuthService, email = USER.email, password = 'errada') =>
  service.login({ email, password });

/** Erra a senha `times` vezes. */
async function failTimes(service: AuthService, times: number, email = USER.email) {
  for (let i = 0; i < times; i += 1) {
    await expect(login(service, email)).rejects.toBeInstanceOf(UnauthorizedException);
  }
}

describe('AuthService.login com limite por e-mail', () => {
  beforeEach(() => {
    vi.mocked(verifyPassword).mockReset().mockResolvedValue(false);
    vi.mocked(hashPassword).mockReset().mockResolvedValue('hash');
  });

  it('bloqueado, responde 429 sem ir ao banco nem ao argon2', async () => {
    const { service, prisma } = setup();
    await failTimes(service, LOGIN_FAILURE_LIMIT);
    prisma.user.findUnique.mockClear();
    vi.mocked(verifyPassword).mockClear();

    await expect(login(service)).rejects.toBeInstanceOf(LoginLockedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('a senha certa durante o bloqueio também leva 429', async () => {
    const { service } = setup();
    await failTimes(service, LOGIN_FAILURE_LIMIT);
    vi.mocked(verifyPassword).mockResolvedValue(true);
    await expect(login(service, USER.email, 'certa')).rejects.toBeInstanceOf(LoginLockedException);
  });

  it('e-mail inexistente conta e bloqueia do mesmo jeito', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue(null as never);
    await failTimes(service, LOGIN_FAILURE_LIMIT, 'ninguem@x.com');
    await expect(login(service, 'ninguem@x.com')).rejects.toBeInstanceOf(LoginLockedException);
  });

  it('logins certos não acumulam', async () => {
    const { service, attempts } = setup();
    vi.mocked(verifyPassword).mockResolvedValue(true);
    for (let i = 0; i < LOGIN_FAILURE_LIMIT * 2; i += 1) await login(service, USER.email, 'certa');
    expect(attempts.size).toBe(0);
  });

  it('fila do argon2 cheia (503) devolve a reserva', async () => {
    const { service, attempts } = setup();
    vi.mocked(verifyPassword).mockRejectedValue(new PasswordHashBusyError());
    for (let i = 0; i < LOGIN_FAILURE_LIMIT * 2; i += 1) {
      await expect(login(service)).rejects.toBeInstanceOf(PasswordHashBusyError);
    }
    expect(attempts.size).toBe(0);
  });

  it('erro do banco devolve a reserva', async () => {
    const { service, prisma, attempts } = setup();
    prisma.user.findUnique.mockRejectedValue(new Error('banco fora'));
    await expect(login(service)).rejects.toThrow('banco fora');
    expect(attempts.size).toBe(0);
  });

  it('as contas da demo ficam isentas só com a demo ligada', async () => {
    const demo = DEMO_EMAILS.agent;
    const on = setup(true);
    await failTimes(on.service, LOGIN_FAILURE_LIMIT * 2, demo);
    expect(on.attempts.size).toBe(0);
    // Outro e-mail, com a demo ligada, continua limitado.
    await failTimes(on.service, LOGIN_FAILURE_LIMIT);
    await expect(login(on.service)).rejects.toBeInstanceOf(LoginLockedException);

    const off = setup(false);
    await failTimes(off.service, LOGIN_FAILURE_LIMIT, demo);
    await expect(login(off.service, demo)).rejects.toBeInstanceOf(LoginLockedException);
  });
});

describe('AuthService.register com a fila do argon2 cheia', () => {
  it('não chega a gravar o usuário', async () => {
    const { service, prisma } = setup();
    vi.mocked(hashPassword).mockRejectedValue(new PasswordHashBusyError());
    await expect(
      service.register({ email: 'b@x.com', name: 'B', password: 'senha-longa' }),
    ).rejects.toBeInstanceOf(PasswordHashBusyError);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
