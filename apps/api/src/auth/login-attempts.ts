import { createHmac, randomBytes } from 'node:crypto';
import {
  Catch,
  Inject,
  Injectable,
  Logger,
  Optional,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';

export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_WINDOW_MS = 15 * 60_000;
/** Teto de e-mails com falha confirmada. Cheio, sai o mais antigo: nunca recusa todo mundo. */
export const MAX_TRACKED_EMAILS = 10_000;

/** Relógio injetável, para os testes andarem a janela sem esperar. */
export const LOGIN_CLOCK = Symbol('LOGIN_CLOCK');

export type LoginReservation =
  /** `fail`: senha errada, a falha fica. `release`: qualquer outro desfecho, a vaga volta. */
  { ok: true; release: () => void; fail: () => void } | { ok: false; retryAfterSec: number };

interface Entry {
  /** Pedidos em andamento, já contados no limite. */
  pending: number;
  /** Falhas confirmadas (senha errada verificada). */
  failures: number;
  resetAt: number;
  logged: boolean;
}

/**
 * Falhas de login por e-mail, além do limite por IP do ThrottlerGuard (que um
 * X-Forwarded-For forjado contorna). Cada tentativa reserva uma falha ANTES do
 * banco e do argon2, e o AuthService devolve a reserva no sucesso ou em erro que
 * não seja senha errada: assim pedidos em paralelo não furam o limite, e só ficam
 * entradas de falhas que pagaram um argon2.
 *
 * A chave é um HMAC do e-mail já normalizado pelo DTO, com segredo aleatório por
 * processo: o e-mail em claro não fica na memória, e um SHA-256 puro sairia por
 * dicionário. Não normaliza de novo: juntar e-mails diferentes deixaria uma conta
 * travar outra. Em memória, para uma instância só; o cold start zera tudo.
 * A janela é fixa a partir da primeira falha, então a ordem do Map é a ordem
 * de expiração e a limpeza só olha o começo dele.
 */
@Injectable()
export class LoginAttempts {
  private readonly logger = new Logger(LoginAttempts.name);
  private readonly secret = randomBytes(32);
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  /** Entradas com ao menos uma falha confirmada: as que contam no teto. */
  private confirmed = 0;
  private evictions = 0;

  constructor(@Optional() @Inject(LOGIN_CLOCK) now?: () => number) {
    this.now = now ?? Date.now;
  }

  reserve(email: string): LoginReservation {
    const now = this.now();
    const key = createHmac('sha256', this.secret).update(email).digest('base64url');
    this.dropExpired(now);
    let entry = this.entries.get(key);
    if (entry && entry.pending + entry.failures >= LOGIN_FAILURE_LIMIT) {
      if (!entry.logged) {
        entry.logged = true;
        this.logger.warn({ event: 'login_locked' });
      }
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }
    if (!entry) {
      entry = { pending: 0, failures: 0, resetAt: now + LOGIN_WINDOW_MS, logged: false };
      this.entries.set(key, entry);
    }
    const reserved = entry;
    reserved.pending += 1;
    let settled = false;
    const settle = (failed: boolean) => {
      if (settled) return;
      settled = true;
      reserved.pending -= 1;
      // A entrada venceu ou saiu enquanto o pedido rodava: a janela já recomeçou.
      if (this.entries.get(key) !== reserved) return;
      if (failed) {
        reserved.failures += 1;
        if (reserved.failures === 1) this.confirmed += 1;
        if (this.confirmed > MAX_TRACKED_EMAILS) this.evictOldestConfirmed(key);
      } else if (reserved.pending === 0 && reserved.failures === 0) {
        this.entries.delete(key);
      }
    };
    return { ok: true, release: () => settle(false), fail: () => settle(true) };
  }

  /** Para os testes: quantos e-mails estão sendo acompanhados. */
  get size(): number {
    return this.entries.size;
  }

  private dropExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt > now) return;
      this.remove(key, entry);
    }
  }

  private evictOldestConfirmed(except: string): void {
    for (const [key, entry] of this.entries) {
      if (key === except || entry.failures === 0) continue;
      this.remove(key, entry);
      this.evictions += 1;
      // Amostrado: numa rajada, um aviso a cada mil despejos.
      if (this.evictions % 1000 === 1) {
        this.logger.warn({ event: 'login_attempts_evicted', total: this.evictions });
      }
      return;
    }
  }

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    if (entry.failures > 0) this.confirmed -= 1;
  }
}

/**
 * Mesmo corpo do 429 por IP, e igual para e-mail existente e inexistente. O
 * cliente ainda distingue os dois limites pelo `Retry-After` (acima de 60 s) e
 * pelos `X-RateLimit-*`, mas isso não revela se a conta existe.
 */
export class LoginLockedException extends ThrottlerException {
  constructor(readonly retryAfterSec: number) {
    super();
  }
}

/** O serviço não tem a resposta à mão: o `Retry-After` sai daqui. */
@Catch(LoginLockedException)
export class LoginLockedFilter implements ExceptionFilter {
  catch(exception: LoginLockedException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(exception.retryAfterSec))
      .status(exception.getStatus())
      .json({ statusCode: exception.getStatus(), message: exception.message });
  }
}
