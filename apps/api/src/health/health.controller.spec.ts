import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { HealthController } from './health.controller.js';

const controllerWith = ($queryRaw: () => Promise<unknown>) => {
  const query = vi.fn($queryRaw);
  return {
    query,
    controller: new HealthController({ $queryRaw: query } as unknown as PrismaService),
  };
};

describe('HealthController', () => {
  it('/health/live responde sem tocar no banco', () => {
    const { controller, query } = controllerWith(() => Promise.reject(new Error('fora do ar')));
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
  });

  it('/health/live fica fora do rate limit; /health continua nele', () => {
    const skip = 'THROTTLER:SKIPdefault';
    expect(Reflect.getMetadata(skip, HealthController.prototype.live)).toBe(true);
    expect(Reflect.getMetadata(skip, HealthController.prototype.check)).toBeUndefined();
  });

  it('/health responde 503 com o banco fora', async () => {
    const { controller } = controllerWith(() => Promise.reject(new Error('fora do ar')));
    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
