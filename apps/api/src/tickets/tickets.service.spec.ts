import { ConflictException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssignmentService } from '../assignment/assignment.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TicketsService } from './tickets.service.js';

// A corrida real (PATCH contra pausa, retomada e 1ª resposta) está em
// test/sla.e2e-spec.ts. Aqui fica o mapeamento: update perdido → 409.

const admin = { id: 'admin-id', role: 'ADMIN' as const };
const stored = {
  id: 'ticket-id',
  status: 'WAITING_CUSTOMER',
  pausedSeconds: 600,
  firstResponseAt: null,
  createdAt: new Date('2026-11-01T12:00:00.000Z'),
};

function serviceWith(updated: number) {
  const tx = {
    ticket: {
      findFirst: vi.fn().mockResolvedValue(stored),
      updateMany: vi.fn().mockResolvedValue({ count: updated }),
    },
    slaPolicy: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ firstResponseMinutes: 60, resolutionMinutes: 240 }),
    },
  };
  const assignment = {
    inLock: (fn: (db: typeof tx) => Promise<unknown>) => fn(tx),
    isAgent: vi.fn().mockResolvedValue(true),
  };
  const service = new TicketsService(
    tx as unknown as PrismaService,
    assignment as unknown as AssignmentService,
  );
  return { service, tx };
}

describe('TicketsService.closeResolvedBefore', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date('2026-11-09T12:00:00.000Z');
  const cutoff = new Date(now.getTime() - 7 * DAY);
  const same = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

  /**
   * Uma linha só, em memória: o `updateMany` aplica o `where` como o Postgres
   * (igualdade campo a campo). `between` roda entre a leitura e o update.
   */
  function jobWith(between: (row: Record<string, unknown>) => void) {
    const row: Record<string, unknown> = {
      id: 'ticket-id',
      status: 'RESOLVED',
      resolvedAt: new Date(cutoff.getTime() - 60_000),
      closedAt: null,
    };
    const prisma = {
      ticket: {
        findMany: vi.fn(async () => [{ ...row }]),
        updateMany: vi.fn(
          async ({ where, data }: { where: object; data: Record<string, unknown> }) => {
            between(row);
            if (!Object.entries(where).every(([key, value]) => same(row[key], value))) {
              return { count: 0 };
            }
            Object.assign(row, data);
            return { count: 1 };
          },
        ),
      },
    };
    const service = new TicketsService(
      prisma as unknown as PrismaService,
      {} as unknown as AssignmentService,
    );
    return { service, prisma, row };
  }

  it('não fecha um ticket reaberto e resolvido de novo depois da leitura', async () => {
    const resolvedAgain = new Date(now.getTime() - 1_000);
    const { service, row } = jobWith((current) => {
      // Reabertura que já tinha passado na checagem da janela, e a equipe resolve de novo.
      current.resolvedAt = resolvedAgain;
    });

    await expect(service.closeResolvedBefore(cutoff, now)).resolves.toBe(0);
    expect(row).toMatchObject({ status: 'RESOLVED', resolvedAt: resolvedAgain, closedAt: null });
  });

  it('fecha o que continua como foi lido', async () => {
    const { service, row } = jobWith(() => undefined);

    await expect(service.closeResolvedBefore(cutoff, now)).resolves.toBe(1);
    expect(row).toMatchObject({ status: 'CLOSED', closedAt: now });
  });

  it('lê no máximo 200, dos resolvidos há mais tempo', async () => {
    const { service, prisma } = jobWith(() => undefined);

    await service.closeResolvedBefore(cutoff, now);
    expect(prisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ resolvedAt: 'asc' }, { id: 'asc' }],
        take: 200,
      }),
    );
  });
});

describe('TicketsService.applyTransition', () => {
  it('a guarda extra não substitui o id nem o status lidos', async () => {
    const now = new Date('2026-11-09T12:00:00.000Z');
    const db = { ticket: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } };
    const service = new TicketsService(
      db as unknown as PrismaService,
      {} as unknown as AssignmentService,
    );
    const ticket = { id: 'ticket-id', status: 'RESOLVED', resolvedAt: now };
    const guard = { id: 'outro-ticket', status: 'OPEN' as const, resolvedAt: now };

    await service.applyTransition(
      db as unknown as PrismaService,
      ticket as unknown as Parameters<TicketsService['applyTransition']>[1],
      'CLOSED',
      now,
      guard,
    );
    expect(db.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'ticket-id', status: 'RESOLVED', resolvedAt: now }),
      }),
    );
  });
});

describe('TicketsService.update', () => {
  it('só grava se o status, a pausa do SLA e a falta da 1ª resposta ainda forem os lidos', async () => {
    const { service, tx } = serviceWith(0);

    await expect(
      service.update(admin, stored.id, { priority: 'URGENT', assigneeId: 'agent-id' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: stored.id,
          status: 'WAITING_CUSTOMER',
          firstResponseAt: null,
          pausedSeconds: 600,
        },
      }),
    );
  });
});

describe('TicketsService.applyCommentEffects', () => {
  // A corrida que perde e acerta na releitura com banco de verdade está no E2E
  // "1ª resposta com o ticket pausando no meio". Aqui ficam os outros caminhos.
  const now = new Date('2026-11-12T12:00:00.000Z');
  const agent = { id: 'agent-id', role: 'AGENT' as const };
  const customer = { id: 'customer-id', role: 'CUSTOMER' as const };
  const ticket = {
    id: 'ticket-id',
    status: 'IN_PROGRESS',
    assigneeId: agent.id,
    firstResponseAt: null,
    slaPausedAt: null,
    pausedSeconds: 0,
    createdAt: new Date('2026-11-12T10:00:00.000Z'),
    firstResponseDueAt: new Date('2026-11-12T13:00:00.000Z'),
    firstResponseRiskAt: new Date('2026-11-12T12:30:00.000Z'),
    resolutionDueAt: new Date('2026-11-12T18:00:00.000Z'),
    resolutionRiskAt: new Date('2026-11-12T17:00:00.000Z'),
  };
  type Ticket = Parameters<TicketsService['applyCommentEffects']>[1];
  type Tx = Parameters<TicketsService['applyCommentEffects']>[0];

  /** `counts`: o resultado de cada `updateMany`, na ordem; `reread`: a releitura. */
  function effectsWith(counts: number[], reread: object) {
    const updateMany = vi.fn();
    for (const count of counts) updateMany.mockResolvedValueOnce({ count });
    const tx = {
      ticket: {
        updateMany,
        findUniqueOrThrow: vi.fn().mockResolvedValue({ ...ticket, ...reread }),
      },
    };
    const service = new TicketsService(
      tx as unknown as PrismaService,
      {} as unknown as AssignmentService,
    );
    const run = (current: object, author: typeof agent | typeof customer) =>
      service.applyCommentEffects(
        tx as unknown as Tx,
        { ...ticket, ...current } as unknown as Ticket,
        author,
        false,
        now,
      );
    return { run, tx };
  }

  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1ª resposta', () => {
    it('perde, relê e acerta: sem aviso', async () => {
      const { run, tx } = effectsWith([0, 1], {});

      await run({}, agent);

      expect(tx.ticket.updateMany).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it('perde duas vezes: o efeito é descartado com aviso', async () => {
      const { run, tx } = effectsWith([0, 0], {});

      await run({}, agent);

      expect(tx.ticket.updateMany).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Efeito de comentário descartado após nova tentativa: firstResponse, ticket ticket-id',
      );
    });

    it('outra resposta já marcou: não tenta de novo nem avisa', async () => {
      const { run, tx } = effectsWith([0], { firstResponseAt: now });

      await run({}, agent);

      expect(tx.ticket.updateMany).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('status pelo comentário do cliente', () => {
    const waiting = { status: 'WAITING_CUSTOMER', firstResponseAt: now, slaPausedAt: now };

    it('perde duas vezes: o efeito é descartado com aviso', async () => {
      const { run, tx } = effectsWith([0, 0], waiting);

      await run(waiting, customer);

      expect(tx.ticket.updateMany).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        'Efeito de comentário descartado após nova tentativa: status → IN_PROGRESS, ticket ticket-id',
      );
    });

    it('o status já mudou na releitura: não tenta de novo nem avisa', async () => {
      const { run, tx } = effectsWith([0], { status: 'IN_PROGRESS' });

      await run(waiting, customer);

      expect(tx.ticket.updateMany).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
