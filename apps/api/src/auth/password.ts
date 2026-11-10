import argon2 from 'argon2';

/**
 * argon2id com o mínimo recomendado pela OWASP (19 MiB, 2 iterações). Os
 * parâmetros padrão da lib (64 MiB) pesam demais na instância gratuita do Render
 * quando vários logins chegam juntos. Os parâmetros ficam gravados no próprio
 * hash, então aumentá-los depois não invalida as senhas existentes.
 */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A fila do hash está cheia, ou a espera nela estourou. É lançado antes de o
 * argon2 começar, e todo chamador faz o hash antes de gravar: nada foi gravado.
 * É erro de domínio (o seed e o job também o recebem); o 503 sai do
 * PasswordHashBusyFilter, na borda HTTP.
 */
export class PasswordHashBusyError extends Error {
  constructor() {
    super('Fila do hash de senha cheia');
    this.name = 'PasswordHashBusyError';
  }
}

export interface PasswordGateOptions {
  /** Quantos hashes rodam ao mesmo tempo. */
  permits: number;
  /** Quantos pedidos comuns esperam na fila; acima disso, recusa na hora. */
  maxQueue: number;
  /** Quanto um pedido comum espera na fila antes de desistir. */
  maxWaitMs: number;
}

interface Waiter {
  priority: boolean;
  start: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Semáforo do argon2. Cada hash ocupa ~19 MiB nativos e uma thread do libuv, a
 * mesma que o DNS do pg e o fs usam; sem teto, uma rajada de logins enche a
 * memória e prende essas threads. O timeout vale só na fila: um argon2 que já
 * começou não é cancelado, e a vaga dele só volta quando ele termina.
 * Pedidos com prioridade (o demo-reset) vão para a frente da fila, sem teto nem
 * timeout, mas sem passar do número de vagas.
 */
export function createPasswordGate({ permits, maxQueue, maxWaitMs }: PasswordGateOptions) {
  let active = 0;
  const queue: Waiter[] = [];
  const queuedCommon = () => queue.filter((w) => !w.priority).length;

  function acquire(priority: boolean): Promise<void> {
    if (active < permits) {
      active += 1;
      return Promise.resolve();
    }
    if (!priority && queuedCommon() >= maxQueue) return Promise.reject(new PasswordHashBusyError());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { priority, start: resolve };
      if (priority) {
        const firstCommon = queue.findIndex((w) => !w.priority);
        queue.splice(firstCommon === -1 ? queue.length : firstCommon, 0, waiter);
      } else {
        waiter.timer = setTimeout(() => {
          const index = queue.indexOf(waiter);
          if (index !== -1) queue.splice(index, 1);
          reject(new PasswordHashBusyError());
        }, maxWaitMs);
        queue.push(waiter);
      }
    });
  }

  /** Passa a vaga direto ao próximo da fila; `active` só cai quando ninguém espera. */
  function release(): void {
    const next = queue.shift();
    if (!next) {
      active -= 1;
      return;
    }
    clearTimeout(next.timer);
    next.start();
  }

  return {
    async run<T>(fn: () => Promise<T>, priority = false): Promise<T> {
      await acquire(priority);
      try {
        return await fn();
      } finally {
        release();
      }
    },
    stats: () => ({ active, queued: queue.length }),
  };
}

/**
 * Números do Perry (2026-11-09), medidos local e extrapolados ao Render free
 * (~0,1 vCPU, 512 MB): ~35 ms de CPU e ~19 MiB por hash. Duas vagas custam
 * ~38 MiB e deixam duas das quatro threads do libuv livres; mais vagas não
 * rendem vazão com CPU fracionada, só empilham latência. Fila de 8 com espera de
 * 3 s: perto do que duas vagas escoam nesse tempo. Rever com a duração real do
 * verify medida no Render (se passar de 1 s, cair para 1 vaga).
 * Exportado só para os E2E ocuparem as vagas; o código chama hashPassword/verifyPassword.
 */
export const PASSWORD_GATE_LIMITS: PasswordGateOptions = {
  permits: 2,
  maxQueue: 8,
  maxWaitMs: 3_000,
};
export const passwordGate = createPasswordGate(PASSWORD_GATE_LIMITS);

/** Pode lançar PasswordHashBusyError. `priority` só para o demo-reset. */
export function hashPassword(password: string, { priority = false } = {}): Promise<string> {
  return passwordGate.run(() => argon2.hash(password, OPTIONS), priority);
}

/**
 * Nunca lança por hash malformado: trata como senha errada. Pode lançar
 * PasswordHashBusyError, que fica fora do try de propósito.
 */
export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return passwordGate.run(async () => {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  });
}
