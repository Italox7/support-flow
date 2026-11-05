import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AssignmentService } from '../src/assignment/assignment.service.js';
import { verifyPassword } from '../src/auth/password.js';
import {
  DEFAULT_SLA_POLICIES,
  DEMO_ACCOUNTS,
  DEMO_AGENT_ID,
  DEMO_CUSTOMER_ID,
} from '../src/jobs/demo-data.js';
import { DemoResetService } from '../src/jobs/demo-reset.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { computeDeadlines } from '../src/sla/sla-deadlines.js';
import { REOPEN_WINDOW_MS } from '../src/tickets/ticket-state-machine.js';
import {
  createActor,
  createApp,
  resetDatabase,
  TEST_DATABASE_URL,
  type Actor,
  type EnvOverrides,
} from './e2e-setup.js';

const SECRET = 'jobs-e2e-'.padEnd(40, 'x');
const DEMO_PASSWORD = 'senha-publica-da-demo';
const DEMO_ENV: EnvOverrides = {
  JOBS_SECRET: SECRET,
  RENDER: 'true',
  DEMO_RESET_ENABLED: true,
  DEMO_PASSWORD,
};
const SENTINEL_SCHEMA = 'e2e_sentinela';

describe.skipIf(!TEST_DATABASE_URL)('POST /api/jobs/run (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  const run = (target = app) =>
    request(target.getHttpServer()).post('/api/jobs/run').set('x-job-secret', SECRET);

  async function makeTicket(
    requester: Actor,
    data: { status: 'OPEN' | 'RESOLVED' | 'CLOSED'; resolvedAt?: Date; assigneeId?: string },
  ) {
    const createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return prisma.ticket.create({
      data: {
        title: 't',
        description: 'd',
        requesterId: requester.id,
        createdAt,
        ...computeDeadlines(createdAt, DEFAULT_SLA_POLICIES.MEDIUM),
        ...data,
        slaPausedAt: data.status === 'OPEN' ? null : (data.resolvedAt ?? createdAt),
      },
    });
  }

  describe('sem restauração', () => {
    beforeAll(async () => {
      app = await createApp({ throttle: false, env: { JOBS_SECRET: SECRET } });
      prisma = app.get(PrismaService);
    });
    afterAll(async () => {
      await app?.close();
    });
    beforeEach(() => resetDatabase(prisma));

    it('responde 401 com segredo errado ou ausente, sem fazer nada', async () => {
      const customer = await createActor(app, 'CUSTOMER', 'cliente');
      const old = new Date(Date.now() - REOPEN_WINDOW_MS - 60_000);
      const ticket = await makeTicket(customer, { status: 'RESOLVED', resolvedAt: old });

      const http = () => request(app.getHttpServer()).post('/api/jobs/run');
      await http().expect(401);
      await http().set('x-job-secret', 'errado').expect(401);
      await http().set('Authorization', `Bearer ${customer.token}`).expect(401);

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(after.status).toBe('RESOLVED');
    });

    it('fecha só o que passou de 7 dias e distribui os órfãos', async () => {
      const customer = await createActor(app, 'CUSTOMER', 'cliente');
      const agent = await createActor(app, 'AGENT', 'agente', { isAvailable: true });
      const expired = new Date(Date.now() - REOPEN_WINDOW_MS - 60_000);
      const recent = new Date(Date.now() - REOPEN_WINDOW_MS + 60_000);
      const old = await makeTicket(customer, { status: 'RESOLVED', resolvedAt: expired });
      const fresh = await makeTicket(customer, { status: 'RESOLVED', resolvedAt: recent });
      const orphan = await makeTicket(customer, { status: 'OPEN' });

      const res = await run().expect(200);
      expect(res.body).toEqual({ restored: false, closed: 1, assigned: 1 });

      const byId = async (id: string) => prisma.ticket.findUniqueOrThrow({ where: { id } });
      const closed = await byId(old.id);
      expect(closed.status).toBe('CLOSED');
      expect(closed.closedAt).not.toBeNull();
      expect(closed.slaPausedAt).toEqual(expired);
      expect((await byId(fresh.id)).status).toBe('RESOLVED');
      expect((await byId(orphan.id)).assigneeId).toBe(agent.id);
    });

    it('rodar de novo não muda nada', async () => {
      const customer = await createActor(app, 'CUSTOMER', 'cliente');
      const expired = new Date(Date.now() - REOPEN_WINDOW_MS - 60_000);
      await makeTicket(customer, { status: 'RESOLVED', resolvedAt: expired });

      await run().expect(200);
      const res = await run().expect(200);
      expect(res.body).toEqual({ restored: false, closed: 0, assigned: 0 });
    });
  });

  it('responde 404 sem JOBS_SECRET configurado', async () => {
    const unset = await createApp({ throttle: false });
    try {
      await run(unset).expect(404);
    } finally {
      await unset.close();
    }
  });

  it('limita a 5 chamadas por minuto', async () => {
    const throttled = await createApp({ throttle: true, env: { JOBS_SECRET: SECRET } });
    try {
      const wrong = () =>
        request(throttled.getHttpServer()).post('/api/jobs/run').set('x-job-secret', 'errado');
      for (let i = 0; i < 5; i++) await wrong().expect(401);
      await wrong().expect(429);
    } finally {
      await throttled.close();
    }
  });

  // A trava do schema lê a URL do banco: TEST_DATABASE_URL precisa trazer ?schema=public.
  describe('com restauração', () => {
    beforeAll(async () => {
      app = await createApp({ throttle: false, env: DEMO_ENV });
      prisma = app.get(PrismaService);
    });
    afterAll(async () => {
      await app?.close();
    });
    beforeEach(() => resetDatabase(prisma));
    afterEach(async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SENTINEL_SCHEMA}" CASCADE`);
      await resetDatabase(prisma);
    });

    it('recria a demo, fecha o ticket vencido e atribui o órfão', async () => {
      const stranger = await createActor(app, 'CUSTOMER', 'estranho');
      await makeTicket(stranger, { status: 'OPEN' });

      const res = await run().expect(200);
      expect(res.body).toEqual({ restored: true, closed: 1, assigned: 1 });

      const users = await prisma.user.findMany({ orderBy: { email: 'asc' } });
      expect(users.map((user) => user.email).sort()).toEqual(
        DEMO_ACCOUNTS.map((account) => account.email).sort(),
      );
      const tickets = await prisma.ticket.findMany();
      expect(tickets.every((ticket) => ticket.requesterId === DEMO_CUSTOMER_ID)).toBe(true);
      expect(tickets.filter((ticket) => ticket.status === 'CLOSED')).toHaveLength(2);
      expect(tickets.filter((ticket) => ticket.assigneeId !== DEMO_AGENT_ID)).toHaveLength(0);
    });

    it('as contas entram com a senha da demo e a API funciona depois', async () => {
      await run().expect(200);
      const admin = await prisma.user.findUniqueOrThrow({
        where: { email: 'admin@demo.example.com' },
      });
      expect(await verifyPassword(admin.passwordHash, DEMO_PASSWORD)).toBe(true);

      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'cliente@demo.example.com', password: DEMO_PASSWORD })
        .expect(200);
      const list = await request(app.getHttpServer())
        .get('/api/tickets')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(200);
      expect(list.body.total).toBeGreaterThan(0);
    });

    it('restaura as políticas de SLA alteradas pelo admin', async () => {
      await prisma.slaPolicy.update({
        where: { priority: 'LOW' },
        data: { firstResponseMinutes: 1, resolutionMinutes: 2 },
      });
      await run().expect(200);
      const rows = await prisma.slaPolicy.findMany();
      expect(
        Object.fromEntries(
          rows.map(({ priority, firstResponseMinutes, resolutionMinutes }) => [
            priority,
            { firstResponseMinutes, resolutionMinutes },
          ]),
        ),
      ).toEqual(DEFAULT_SLA_POLICIES);
    });

    it('não toca em outro schema do banco', async () => {
      await prisma.$executeRawUnsafe(`CREATE SCHEMA "${SENTINEL_SCHEMA}"`);
      await prisma.$executeRawUnsafe(`CREATE TABLE "${SENTINEL_SCHEMA}".users (id int)`);
      await prisma.$executeRawUnsafe(`INSERT INTO "${SENTINEL_SCHEMA}".users VALUES (1)`);

      await run().expect(200);

      const [{ total }] = await prisma.$queryRawUnsafe<[{ total: number }]>(
        `SELECT count(*)::int AS total FROM "${SENTINEL_SCHEMA}".users`,
      );
      expect(total).toBe(1);
    });

    // A transação do serviço usa o banco de teste de verdade: se uma trava falhar,
    // o usuário abaixo some e o teste acusa.
    it.each([
      ['schema de outro ambiente', { DATABASE_URL: 'postgresql://x@localhost/x?schema=dev' }],
      ['schema ausente', { DATABASE_URL: 'postgresql://x@localhost/x' }],
      [
        'schema duplicado',
        { DATABASE_URL: 'postgresql://x@localhost/x?schema=public&schema=public' },
      ],
      ['fora do Render', { RENDER: undefined }],
      ['flag desligada', { DEMO_RESET_ENABLED: false }],
      ['sem senha', { DEMO_PASSWORD: undefined }],
    ])('não faz nada com %s', async (_name, change) => {
      const survivor = await createActor(app, 'CUSTOMER', 'sobrevivente');
      const service = new DemoResetService(app.get(AssignmentService), {
        DATABASE_URL: 'postgresql://x@localhost/x?schema=public',
        RENDER: 'true',
        DEMO_RESET_ENABLED: true,
        DEMO_PASSWORD,
        ...change,
      });

      await expect(service.restore()).resolves.toBe(false);
      await expect(
        prisma.user.findUniqueOrThrow({ where: { id: survivor.id } }),
      ).resolves.toBeTruthy();
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('limites de escrita (e2e)', () => {
  it('POST /tickets e comentários passam pelo limite por usuário, depois do JWT', async () => {
    const app = await createApp({ throttle: true });
    const prisma = app.get(PrismaService);
    try {
      await resetDatabase(prisma);
      const customer = await createActor(app, 'CUSTOMER', 'cliente');
      const other = await createActor(app, 'CUSTOMER', 'outro');
      const post = (actor: Actor, url: string) =>
        request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${actor.token}`);
      const ticket = () => ({ title: 'Título do ticket', description: 'Descrição do ticket' });

      // Sem token: 401 antes de contar, e o limite do usuário segue intacto.
      await request(app.getHttpServer()).post('/api/tickets').send(ticket()).expect(401);

      let id = '';
      for (let i = 0; i < 10; i++) {
        const res = await post(customer, '/api/tickets').send(ticket()).expect(201);
        id = res.body.id;
      }
      const blocked = await post(customer, '/api/tickets').send(ticket()).expect(429);
      expect(blocked.headers['retry-after']).toBeDefined();

      await post(other, '/api/tickets').send(ticket()).expect(201);
      // Comentários têm o próprio limite: os 10 tickets acima não contam aqui.
      const comment = () => post(customer, `/api/tickets/${id}/comments`).send({ body: 'Oi' });
      for (let i = 0; i < 10; i++) await comment().expect(201);
      await comment().expect(429);
    } finally {
      await resetDatabase(prisma);
      await app.close();
    }
  });

  it('o cadastro tem um teto por hora, que não depende do IP', async () => {
    const app = await createApp({ throttle: false, rateLimitGuards: true });
    try {
      const send = () => request(app.getHttpServer()).post('/api/auth/register').send({});
      for (let i = 0; i < 30; i++) await send().expect(400);
      await send().expect(429);
    } finally {
      await app.close();
    }
  });
});
