import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { inspect } from 'node:util';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  createActor,
  createApp,
  resetDatabase,
  TEST_DATABASE_URL,
  type Actor,
} from './e2e-setup.js';

const VALID = { name: 'Nova Agente', email: 'nova@example.com', password: 'senha-inicial' };

describe.skipIf(!TEST_DATABASE_URL)('criação de agentes (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let admin: Actor;
  let customer: Actor;

  const http = () => request(app.getHttpServer());
  const create = (by: Actor, body: object = VALID) =>
    http().post('/api/users/agents').set('Authorization', `Bearer ${by.token}`).send(body);

  beforeAll(async () => {
    app = await createApp({ throttle: false });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await createActor(app, 'ADMIN', 'admin');
    customer = await createActor(app, 'CUSTOMER', 'cliente');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('o admin cria o agente; a resposta não traz senha nem hash', async () => {
    const res = await create(admin).expect(201);

    expect(res.body).toEqual({
      id: expect.any(String),
      name: 'Nova Agente',
      email: 'nova@example.com',
      isAvailable: false,
      openTickets: 0,
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.role).toBe('AGENT');
    expect(stored.passwordHash).not.toContain(VALID.password);
  });

  it('o agente nasce indisponível: não recebe ticket antes de ficar disponível', async () => {
    const { body: agent } = await create(admin).expect(201);
    const { isAvailable } = await prisma.user.findUniqueOrThrow({ where: { id: agent.id } });
    expect(isAvailable).toBe(false);

    const ticket = await http()
      .post('/api/tickets')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ title: 'Sem agente', description: 'Ninguém disponível ainda.' })
      .expect(201);
    expect(ticket.body.assignee).toBeNull();
  });

  it('o agente criado entra com a senha definida e ganha o papel certo', async () => {
    await create(admin).expect(201);

    const res = await http()
      .post('/api/auth/login')
      .send({ email: VALID.email, password: VALID.password })
      .expect(200);
    expect(res.body.user).toMatchObject({ email: VALID.email, role: 'AGENT' });
  });

  it('normaliza o e-mail como o cadastro', async () => {
    const res = await create(admin, { ...VALID, email: '  NOVA@Example.com ' }).expect(201);
    expect(res.body.email).toBe('nova@example.com');
  });

  it('e-mail de um cliente é 409 e não promove a conta', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });

    const res = await create(admin, { ...VALID, email: before.email }).expect(409);
    // Corpo fixo: o `meta` do P2002 do Prisma não chega ao cliente.
    expect(res.body).toEqual({
      statusCode: 409,
      message: 'Este e-mail já está cadastrado.',
      error: 'Conflict',
    });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.role).toBe('CUSTOMER');
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('só o admin cria: agente e cliente recebem 403, sem token é 401', async () => {
    const agent = await createActor(app, 'AGENT', 'agente');
    await create(agent).expect(403);
    await create(customer).expect(403);
    await http().post('/api/users/agents').send(VALID).expect(401);
    expect(await prisma.user.count({ where: { email: VALID.email } })).toBe(0);
  });

  it('sem ser admin, a rota não revela se o e-mail existe nem valida o corpo', async () => {
    const agent = await createActor(app, 'AGENT', 'agente');
    const taken = { ...VALID, email: 'cliente@example.com' };

    await create(agent, taken).expect(403);
    await create(customer, taken).expect(403);
    await create(customer, {}).expect(403);
    await http().post('/api/users/agents').send(taken).expect(401);
    await http().post('/api/users/agents').send({}).expect(401);
  });

  it.each([
    ['senha curta', { ...VALID, password: '1234567' }],
    ['senha longa demais', { ...VALID, password: 'x'.repeat(129) }],
    ['e-mail inválido', { ...VALID, email: 'nao-e-email' }],
    ['nome vazio', { ...VALID, name: '   ' }],
    ['papel no corpo', { ...VALID, role: 'ADMIN' }],
    ['disponibilidade no corpo', { ...VALID, isAvailable: true }],
  ])('retorna 400 com %s', async (_case, body) => {
    await create(admin, body).expect(400);
    expect(await prisma.user.count({ where: { email: VALID.email } })).toBe(0);
  });

  it('registra quem criou; nenhum log traz e-mail, senha ou hash', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const error = vi.spyOn(Logger.prototype, 'error');

    const { body: agent } = await create(admin).expect(201);
    await create(admin).expect(409);

    const { passwordHash } = await prisma.user.findUniqueOrThrow({ where: { id: agent.id } });
    const logged = inspect([log.mock.calls, warn.mock.calls, error.mock.calls], { depth: null });
    for (const secret of [VALID.email, VALID.password, passwordHash]) {
      expect(logged).not.toContain(secret);
    }

    const entry = log.mock.calls.find(
      ([message]) => (message as { event?: string })?.event === 'agent_created',
    );
    expect(entry?.[0]).toEqual({
      event: 'agent_created',
      adminId: admin.id,
      agentId: agent.id,
    });
  });

  it('limita a 10 criações por minuto', async () => {
    const throttled = await createApp({ throttle: true });
    try {
      const send = () =>
        request(throttled.getHttpServer())
          .post('/api/users/agents')
          .set('Authorization', `Bearer ${admin.token}`)
          .send({});
      // Corpo inválido: o limite conta antes da validação, sem pagar argon2.
      for (let i = 0; i < 10; i++) await send().expect(400);
      await send().expect(429);
    } finally {
      await throttled.close();
    }
  });
});
