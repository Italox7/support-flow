import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AssignmentService } from '../assignment/assignment.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TicketsService } from './tickets.service.js';

// A corrida real (PATCH contra uma pausa do SLA) entra nos E2E da Fase 5, quando
// pausedSeconds passar a mudar. Aqui fica o mapeamento: update perdido → 409.

const admin = { id: 'admin-id', role: 'ADMIN' as const };
const stored = {
  id: 'ticket-id',
  status: 'WAITING_CUSTOMER',
  pausedSeconds: 600,
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

describe('TicketsService.update', () => {
  it('só grava se o status e a pausa do SLA ainda forem os lidos', async () => {
    const { service, tx } = serviceWith(0);

    await expect(
      service.update(admin, stored.id, { priority: 'URGENT', assigneeId: 'agent-id' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: stored.id, status: 'WAITING_CUSTOMER', pausedSeconds: 600 },
      }),
    );
  });
});
