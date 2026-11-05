import { NotFoundException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { JOB_SECRET_HEADER, JobSecretGuard } from './job-secret.guard.js';

const SECRET = 's'.repeat(32);

const contextWith = (headers: Record<string, unknown>) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext;

describe('JobSecretGuard', () => {
  const guard = new JobSecretGuard({ JOBS_SECRET: SECRET });

  it('aceita o segredo certo', () => {
    expect(guard.canActivate(contextWith({ [JOB_SECRET_HEADER]: SECRET }))).toBe(true);
  });

  it.each([
    ['ausente', {}],
    ['errado', { [JOB_SECRET_HEADER]: 'x'.repeat(32) }],
    ['de outro tamanho', { [JOB_SECRET_HEADER]: 'curto' }],
    ['vazio', { [JOB_SECRET_HEADER]: '' }],
    ['repetido', { [JOB_SECRET_HEADER]: [SECRET, SECRET] }],
  ])('responde 401 com segredo %s', (_name, headers) => {
    expect(() => guard.canActivate(contextWith(headers))).toThrow(UnauthorizedException);
  });

  it('responde 404 sem segredo configurado, mesmo que o pedido traga um', () => {
    const unset = new JobSecretGuard({ JOBS_SECRET: undefined });
    expect(() => unset.canActivate(contextWith({ [JOB_SECRET_HEADER]: SECRET }))).toThrow(
      NotFoundException,
    );
  });
});
