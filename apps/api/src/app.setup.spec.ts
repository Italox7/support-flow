import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { noStore } from './app.setup.js';

describe('noStore', () => {
  it('marca a resposta como no-store e segue para a rota', () => {
    const setHeader = vi.fn();
    const next = vi.fn() as unknown as NextFunction;
    noStore({} as Request, { setHeader } as unknown as Response, next);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).toHaveBeenCalledOnce();
  });
});
