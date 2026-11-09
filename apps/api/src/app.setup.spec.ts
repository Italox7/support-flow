import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureApp, logForwardedForCount, noStore } from './app.setup.js';
import type { Env } from './config/env.js';

describe('noStore', () => {
  it('marca a resposta como no-store e segue para a rota', () => {
    const setHeader = vi.fn();
    const next = vi.fn() as unknown as NextFunction;
    noStore({} as Request, { setHeader } as unknown as Response, next);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('logForwardedForCount', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const logged = (forwarded: string | string[] | undefined) => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const next = vi.fn() as unknown as NextFunction;
    const headers = forwarded === undefined ? {} : { 'x-forwarded-for': forwarded };
    logForwardedForCount({ headers } as Request, {} as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    return String(log.mock.calls[0]![0]);
  };

  it.each([
    ['ausente', undefined, 0],
    ['com um IP', '203.0.113.7', 1],
    ['com a cadeia do proxy', '203.0.113.7, 198.51.100.2, 10.0.0.1, 10.0.0.2', 4],
    ['repetido', ['203.0.113.7, 198.51.100.2', '10.0.0.1'], 3],
  ])('registra só a contagem, %s', (_name, forwarded, count) => {
    const message = logged(forwarded);
    expect(message).toBe(`X-Forwarded-For com ${count} entrada(s)`);
    expect(message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

describe('configureApp', () => {
  const appMock = () => {
    const app = {
      disable: vi.fn(),
      set: vi.fn(),
      use: vi.fn(),
      setGlobalPrefix: vi.fn(),
      useGlobalPipes: vi.fn(),
      useGlobalFilters: vi.fn(),
    };
    return app;
  };
  const env = (LOG_XFF_COUNT: boolean) => ({ TRUST_PROXY: 0, LOG_XFF_COUNT }) as unknown as Env;
  const used = (app: ReturnType<typeof appMock>) => app.use.mock.calls.map(([fn]) => fn);

  it('liga o log do X-Forwarded-For só com LOG_XFF_COUNT', () => {
    const on = appMock();
    configureApp(on as unknown as NestExpressApplication, env(true));
    expect(used(on)).toContain(logForwardedForCount);

    const off = appMock();
    configureApp(off as unknown as NestExpressApplication, env(false));
    expect(used(off)).not.toContain(logForwardedForCount);
  });
});
