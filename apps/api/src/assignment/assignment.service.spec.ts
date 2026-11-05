import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AssignmentBusyException } from './assignment-busy.js';
import { AssignmentService } from './assignment.service.js';

const p2028 = () =>
  new Prisma.PrismaClientKnownRequestError('Transaction already closed', {
    code: 'P2028',
    clientVersion: 'teste',
  });

const tx = (executeRaw: () => Promise<number> = () => Promise.resolve(1)) => ({
  $executeRaw: vi.fn(executeRaw),
});

function serviceWith($transaction: (run: (client: never) => Promise<unknown>) => Promise<unknown>) {
  return new AssignmentService({ $transaction } as unknown as PrismaService);
}

describe('AssignmentService.inLock', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('sem conexão, antes de abrir a transação: 503, com o erro original no log', async () => {
    const original = p2028();
    const fn = vi.fn();
    const service = serviceWith(() => Promise.reject(original));

    await expect(service.inLock(fn)).rejects.toBeInstanceOf(AssignmentBusyException);
    expect(fn).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('Transaction already closed'),
    );
  });

  it('transação expirada depois de começar não vira 503: pode ter gravado', async () => {
    const expired = p2028();
    const service = serviceWith(async (run) => {
      await run(tx() as never);
      throw expired;
    });

    await expect(service.inLock(() => Promise.resolve('ok'))).rejects.toBe(expired);
  });

  it('erro da regra de negócio dentro do lock sobe intacto', async () => {
    const failure = new Error('regra');
    const service = serviceWith((run) => run(tx() as never));

    await expect(service.inLock(() => Promise.reject(failure))).rejects.toBe(failure);
  });

  it('falha ao configurar ou tomar o lock: 503, sem rodar o trabalho', async () => {
    const fn = vi.fn();
    const service = serviceWith((run) =>
      run(tx(() => Promise.reject(new Error('lock_timeout'))) as never),
    );

    await expect(service.inLock(fn)).rejects.toBeInstanceOf(AssignmentBusyException);
    expect(fn).not.toHaveBeenCalled();
  });

  it('com o lock, devolve o resultado do trabalho', async () => {
    const service = serviceWith((run) => run(tx() as never));
    await expect(service.inLock(() => Promise.resolve(42))).resolves.toBe(42);
  });
});
