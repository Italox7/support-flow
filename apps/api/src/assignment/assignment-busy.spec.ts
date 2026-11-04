import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../app.setup.js';
import { loadEnv } from '../config/env.js';
import { AssignmentBusyException } from './assignment-busy.js';

@Controller('teste')
class ThrowingController {
  @Get('ocupado')
  busy(): never {
    throw new AssignmentBusyException();
  }

  @Get('fora-do-ar')
  down(): never {
    throw new ServiceUnavailableException({ status: 'error', database: 'down' });
  }
}

// Sem banco, mas com o configureApp de verdade: prova que o filtro está registrado.
describe('503 do lock da atribuição', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ThrowingController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(
      app,
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://unused@localhost/unused',
        JWT_ACCESS_SECRET: 'unit-'.padEnd(48, 'x'),
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('traz Retry-After e mantém o corpo padrão do Nest', async () => {
    const res = await request(app.getHttpServer()).get('/api/teste/ocupado').expect(503);

    expect(res.headers['retry-after']).toBe('1');
    expect(res.body).toEqual({
      statusCode: 503,
      message: 'O sistema está ocupado. Tente de novo em instantes.',
      error: 'Service Unavailable',
    });
  });

  it('outro 503, como o do health check, não traz o cabeçalho', async () => {
    const res = await request(app.getHttpServer()).get('/api/teste/fora-do-ar').expect(503);

    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.body).toEqual({ status: 'error', database: 'down' });
  });
});
