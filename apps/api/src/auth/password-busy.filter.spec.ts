import type { ArgumentsHost } from '@nestjs/common';
import { PASSWORD_HASH_BUSY_CODE } from '@support-flow/shared';
import { describe, expect, it, vi } from 'vitest';
import { PasswordHashBusyFilter } from './password-busy.filter.js';
import { PasswordHashBusyError } from './password.js';

describe('PasswordHashBusyFilter', () => {
  it('responde 503 com Retry-After: 2 e o code próprio', () => {
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
    res.setHeader.mockReturnValue(res);
    res.status.mockReturnValue(res);
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;

    new PasswordHashBusyFilter().catch(new PasswordHashBusyError(), host);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '2');
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 503, code: PASSWORD_HASH_BUSY_CODE }),
    );
  });
});
