import { describe, expect, it, vi } from 'vitest';
import type { AssignmentService } from '../assignment/assignment.service.js';
import { hashPassword } from '../auth/password.js';
import type { Env } from '../config/env.js';
import { DemoResetService } from './demo-reset.service.js';

vi.mock('../auth/password.js', () => ({ hashPassword: vi.fn(async () => 'hash') }));

describe('DemoResetService', () => {
  it('faz um hash só, com prioridade na fila do argon2, antes do lock', async () => {
    const inLock = vi.fn(async () => {
      expect(hashPassword).toHaveBeenCalledOnce();
    });
    const service = new DemoResetService(
      { inLock } as unknown as AssignmentService,
      {
        DEMO_RESET_ENABLED: true,
        DEMO_PASSWORD: 'senha-publica-da-demo',
        RENDER: 'true',
        DATABASE_URL: 'postgresql://u@localhost/db?schema=public',
      } as Env,
    );

    await expect(service.restore()).resolves.toBe(true);
    expect(hashPassword).toHaveBeenCalledWith('senha-publica-da-demo', { priority: true });
    expect(inLock).toHaveBeenCalledOnce();
  });
});
