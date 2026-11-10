import { plainToInstance } from 'class-transformer';
import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { LoginDto } from './auth.dto.js';
import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_WINDOW_MS,
  LoginAttempts,
  LoginLockedException,
  LoginLockedFilter,
  MAX_TRACKED_EMAILS,
  type LoginReservation,
} from './login-attempts.js';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

/** Reserva e confirma a falha, como uma senha errada. */
function fail(attempts: LoginAttempts, email: string, times: number): void {
  for (let i = 0; i < times; i += 1) reserveOk(attempts, email).fail();
}

function reserveOk(attempts: LoginAttempts, email: string) {
  const reservation = attempts.reserve(email);
  if (!reservation.ok) throw new Error(`bloqueou ${email}`);
  return reservation;
}

describe('LoginAttempts', () => {
  it(`bloqueia a ${LOGIN_FAILURE_LIMIT + 1}ª tentativa e diz quanto falta`, () => {
    const time = clock();
    const attempts = new LoginAttempts(time.now);
    fail(attempts, 'a@x.com', LOGIN_FAILURE_LIMIT);
    time.advance(60_000);
    expect(attempts.reserve('a@x.com')).toEqual({
      ok: false,
      retryAfterSec: (LOGIN_WINDOW_MS - 60_000) / 1000,
    });
    // Outro e-mail não é afetado.
    expect(attempts.reserve('b@x.com').ok).toBe(true);
  });

  it('a janela expira e libera o e-mail', () => {
    const time = clock();
    const attempts = new LoginAttempts(time.now);
    fail(attempts, 'a@x.com', LOGIN_FAILURE_LIMIT);
    time.advance(LOGIN_WINDOW_MS);
    expect(attempts.reserve('a@x.com').ok).toBe(true);
  });

  it('devolver a reserva (sucesso ou 503) não conta como falha', () => {
    const attempts = new LoginAttempts();
    for (let i = 0; i < LOGIN_FAILURE_LIMIT * 3; i += 1) {
      const reservation = attempts.reserve('a@x.com');
      if (!reservation.ok) throw new Error('bloqueou');
      reservation.release();
      reservation.release(); // duas vezes não devolve em dobro
    }
    expect(attempts.size).toBe(0);
  });

  it('pedidos em paralelo não furam o limite: a reserva vem antes do argon2', () => {
    const attempts = new LoginAttempts();
    const results: LoginReservation[] = Array.from({ length: 50 }, () =>
      attempts.reserve('a@x.com'),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(LOGIN_FAILURE_LIMIT);
  });

  it('com o mesmo e-mail normalizado pelo DTO, conta junto', () => {
    const attempts = new LoginAttempts();
    const email = (raw: string) => plainToInstance(LoginDto, { email: raw, password: 'x' }).email;
    expect(email(' A@X.com ')).toBe('a@x.com');
    fail(attempts, email(' A@X.com '), LOGIN_FAILURE_LIMIT);
    expect(attempts.reserve(email('a@x.com')).ok).toBe(false);
  });

  it('não guarda o e-mail em claro', () => {
    const attempts = new LoginAttempts();
    attempts.reserve('segredo@x.com');
    const keys = [...(attempts as unknown as { entries: Map<string, unknown> }).entries.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('segredo');
    // HMAC com segredo por processo: outra instância dá outra chave.
    const other = new LoginAttempts();
    other.reserve('segredo@x.com');
    expect([...(other as unknown as { entries: Map<string, unknown> }).entries.keys()][0]).not.toBe(
      keys[0],
    );
  });

  it('com o teto cheio, tira o mais antigo confirmado e continua aceitando', () => {
    const attempts = new LoginAttempts();
    fail(attempts, 'primeiro@x.com', LOGIN_FAILURE_LIMIT);
    for (let i = 1; i < MAX_TRACKED_EMAILS; i += 1) fail(attempts, `${i}@x.com`, 1);
    expect(attempts.size).toBe(MAX_TRACKED_EMAILS);

    fail(attempts, 'novo@x.com', 1);
    expect(attempts.size).toBe(MAX_TRACKED_EMAILS);
    expect(attempts.reserve('primeiro@x.com').ok).toBe(true);
  });

  it('pedidos pendentes com e-mails novos não despejam a entrada de um alvo', () => {
    const attempts = new LoginAttempts();
    fail(attempts, 'alvo@x.com', LOGIN_FAILURE_LIMIT - 1);
    // A rajada que fica parada no banco ou leva 503: reserva, nunca confirma.
    const pending = Array.from({ length: MAX_TRACKED_EMAILS + 10 }, (_, i) =>
      reserveOk(attempts, `${i}@x.com`),
    );
    fail(attempts, 'alvo@x.com', 1);
    expect(attempts.reserve('alvo@x.com').ok).toBe(false);
    for (const reservation of pending) reservation.release();
    expect(attempts.size).toBe(1);
  });

  it('confirmar ou devolver duas vezes não conta em dobro', () => {
    const attempts = new LoginAttempts();
    const reservation = reserveOk(attempts, 'a@x.com');
    reservation.fail();
    reservation.fail();
    reservation.release();
    fail(attempts, 'a@x.com', LOGIN_FAILURE_LIMIT - 1);
    expect(attempts.reserve('a@x.com').ok).toBe(false);
  });

  it('a reserva de uma janela vencida não mexe na janela nova', () => {
    const time = clock();
    const attempts = new LoginAttempts(time.now);
    const old = reserveOk(attempts, 'a@x.com');
    time.advance(LOGIN_WINDOW_MS);
    const current = reserveOk(attempts, 'a@x.com');
    old.fail();
    old.release();
    current.release();
    expect(attempts.size).toBe(0);
  });

  it('despejo com reserva em voo: a reserva antiga não toca a entrada nova', () => {
    const attempts = new LoginAttempts();
    const inFlight = reserveOk(attempts, 'primeiro@x.com');
    fail(attempts, 'primeiro@x.com', 1);
    for (let i = 1; i <= MAX_TRACKED_EMAILS; i += 1) fail(attempts, `${i}@x.com`, 1);
    // 'primeiro' saiu; um pedido novo abre outra entrada.
    const fresh = reserveOk(attempts, 'primeiro@x.com');
    inFlight.fail();
    fresh.release();
    expect(attempts.reserve('primeiro@x.com').ok).toBe(true);
  });

  it('a limpeza tira as entradas vencidas', () => {
    const time = clock();
    const attempts = new LoginAttempts(time.now);
    for (let i = 0; i < 100; i += 1) attempts.reserve(`${i}@x.com`);
    time.advance(LOGIN_WINDOW_MS);
    attempts.reserve('novo@x.com');
    expect(attempts.size).toBe(1);
  });
});

describe('LoginLockedFilter', () => {
  it('responde o mesmo corpo do 429 por IP, com o Retry-After', () => {
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
    res.setHeader.mockReturnValue(res);
    res.status.mockReturnValue(res);
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;

    new LoginLockedFilter().catch(new LoginLockedException(840), host);

    const ip = new ThrottlerException();
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '840');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ statusCode: 429, message: ip.getResponse() });
  });
});
