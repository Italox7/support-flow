import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
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
