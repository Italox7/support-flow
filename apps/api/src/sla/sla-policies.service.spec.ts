import { BadRequestException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { SlaPoliciesService } from './sla-policies.service.js';

// Sem histórico de política, o log é o único registro de quem mudou o quê: o
// payload é conferido inteiro, para nada entrar ou sumir dele sem querer.

const admin = { id: 'admin-id', role: 'ADMIN' as const };
const updatedAt = new Date('2026-11-12T12:00:00.000Z');

function serviceWith(before: { firstResponseMinutes: number; resolutionMinutes: number } | null) {
  const prisma = {
    $transaction: vi.fn(async ([, upsert]: [unknown, { args: { update: object } }]) => [
      before && { priority: 'HIGH', ...before, updatedAt },
      { priority: 'HIGH', ...upsert.args.update, updatedAt },
    ]),
    slaPolicy: {
      findUnique: vi.fn(() => 'findUnique'),
      // Devolve os argumentos para o $transaction falso montar a política gravada.
      upsert: vi.fn((args: object) => ({ args })),
    },
  };
  const service = new SlaPoliciesService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('SlaPoliciesService.update', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registra quem mudou, a prioridade e os prazos antes e depois', async () => {
    const { service } = serviceWith({ firstResponseMinutes: 120, resolutionMinutes: 480 });

    await service.update(admin, 'HIGH', { firstResponseMinutes: 30, resolutionMinutes: 90 });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      event: 'sla_policy_updated',
      adminId: 'admin-id',
      priority: 'HIGH',
      before: { firstResponseMinutes: 120, resolutionMinutes: 480 },
      after: { firstResponseMinutes: 30, resolutionMinutes: 90 },
    });
  });

  it('prioridade ainda sem política: before é null', async () => {
    const { service } = serviceWith(null);

    await service.update(admin, 'HIGH', { firstResponseMinutes: 30, resolutionMinutes: 90 });

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'sla_policy_updated', before: null }),
    );
  });

  it('pedido recusado não grava nem registra', async () => {
    const { service, prisma } = serviceWith({ firstResponseMinutes: 120, resolutionMinutes: 480 });

    await expect(
      service.update(admin, 'HIGH', { firstResponseMinutes: 90, resolutionMinutes: 90 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
