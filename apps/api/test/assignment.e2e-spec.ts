import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AgentSummary, TicketDetail } from '@support-flow/shared';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ASSIGNMENT_LOCK_KEY } from '../src/assignment/assignment.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  createActor,
  createApp,
  resetDatabase,
  TEST_DATABASE_URL,
  type Actor,
} from './e2e-setup.js';

const MISSING = '00000000-0000-4000-8000-000000000000';
const HOUR = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)('atribuição (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let customer: Actor;
  let otherCustomer: Actor;
  let admin: Actor;

  const http = () => request(app.getHttpServer());
  const as = (actor: Actor) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${actor.token}`),
    post: (url: string) => http().post(url).set('Authorization', `Bearer ${actor.token}`),
    patch: (url: string) => http().patch(url).set('Authorization', `Bearer ${actor.token}`),
  });

  const agentNamed = (name: string, isAvailable = true) =>
    createActor(app, 'AGENT', name, { isAvailable });

  async function openTicket(by: Actor = customer): Promise<TicketDetail> {
    const res = await as(by)
      .post('/api/tickets')
      .send({ title: 'Não consigo entrar', description: 'Dá erro 500 no login.' })
      .expect(201);
    return res.body;
  }

  async function setTicket(id: string, data: Prisma.TicketUpdateInput): Promise<void> {
    await prisma.ticket.update({ where: { id }, data });
  }

  /**
   * Espera até alguma requisição estar na fila do advisory lock. Prova a
   * espera em vez de só a ausência do ticket depois de um tempo arbitrário.
   */
  async function waitForLockWaiter(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      // Lock de chave bigint: os 32 bits altos vão em classid, os baixos em objid
      // e objsubid é 1. Filtrar pela chave ignora outros advisory locks do banco.
      const [{ waiting }] = await prisma.$queryRaw<[{ waiting: number }]>`
        SELECT count(*)::int AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
          AND classid = (${ASSIGNMENT_LOCK_KEY}::bigint >> 32)::oid
          AND objid = (${ASSIGNMENT_LOCK_KEY}::bigint & 4294967295)::oid`;
      if (waiting > 0) return;
      await sleep(20);
    }
    throw new Error('Nenhuma requisição entrou na fila do lock da atribuição.');
  }

  /**
   * Segura o lock da atribuição numa transação do próprio teste enquanto `run`
   * roda. Ela usa uma conexão do mesmo pool da API, o que só travaria com pool 1.
   */
  async function withLockHeld(run: () => Promise<void>): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ASSIGNMENT_LOCK_KEY}::bigint)`;
        await run();
      },
      { timeout: 10_000 },
    );
  }

  const assigneeOf = async (id: string) =>
    (await prisma.ticket.findUniqueOrThrow({ where: { id } })).assigneeId;

  /** Tickets abertos por responsável, como a atribuição os conta. */
  async function loads(): Promise<Record<string, number>> {
    const res = await as(admin).get('/api/users/agents').expect(200);
    return Object.fromEntries(
      (res.body as AgentSummary[]).map((agent) => [agent.name, agent.openTickets]),
    );
  }

  beforeAll(async () => {
    app = await createApp({ throttle: false });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    customer = await createActor(app, 'CUSTOMER', 'cliente');
    otherCustomer = await createActor(app, 'CUSTOMER', 'outro-cliente');
    admin = await createActor(app, 'ADMIN', 'admin');
  });

  describe('na abertura do ticket', () => {
    it('vai para o agente disponível; indisponível, cliente e admin não recebem', async () => {
      const available = await agentNamed('disponivel');
      await agentNamed('ausente', false);

      const ticket = await openTicket();
      expect(ticket.assignee).toEqual({ id: available.id, name: 'disponivel' });
    });

    it('vai para quem tem menos tickets abertos; resolvidos e fechados não contam', async () => {
      const busy = await agentNamed('a-ocupado');
      const light = await agentNamed('b-leve');
      for (const status of ['IN_PROGRESS', 'WAITING_CUSTOMER'] as const) {
        const { id } = await openTicket();
        await setTicket(id, { status, assignee: { connect: { id: busy.id } } });
      }
      for (const status of ['RESOLVED', 'CLOSED'] as const) {
        const { id } = await openTicket();
        await setTicket(id, { status, assignee: { connect: { id: light.id } } });
      }
      // 2 abertos contra 0 abertos (e 2 encerrados).
      expect((await openTicket()).assignee?.id).toBe(light.id);
    });

    it('no empate de carga, alterna pelo lastAssignedAt mais antigo', async () => {
      const first = await agentNamed('a-primeiro');
      const second = await agentNamed('b-segundo');

      const assignees = [];
      for (let i = 0; i < 4; i++) assignees.push((await openTicket()).assignee?.id);
      // Nunca receberam: decide o id. Depois, a carga e o lastAssignedAt alternam.
      const [firstPick, secondPick] = [first.id, second.id].sort();
      expect(assignees).toEqual([firstPick, secondPick, firstPick, secondPick]);

      const cursors = await prisma.user.findMany({
        where: { id: { in: [first.id, second.id] } },
        select: { lastAssignedAt: true },
      });
      for (const { lastAssignedAt } of cursors) expect(lastAssignedAt).not.toBeNull();
    });

    it('a criação espera quem segura o lock da atribuição', async () => {
      const agent = await agentNamed('agente');

      let pending: Promise<TicketDetail> | undefined;
      try {
        await withLockHeld(async () => {
          pending = openTicket();
          await waitForLockWaiter();
          expect(await prisma.ticket.count()).toBe(0);
        });
        expect((await pending)?.assignee?.id).toBe(agent.id);
      } finally {
        // Se um expect falhar no meio, o POST ainda conclui depois: não deixa a promise solta.
        await pending?.catch(() => undefined);
      }
    });

    it(
      'sem o lock em 2 s, a criação recebe 503 e não grava nada',
      { timeout: 15_000 },
      async () => {
        await agentNamed('agente');

        await withLockHeld(async () => {
          await as(customer)
            .post('/api/tickets')
            .send({ title: 'Na fila', description: 'Esperando o lock.' })
            .expect(503);
        });
        expect(await prisma.ticket.count()).toBe(0);
      },
    );

    it('tickets simultâneos não veem a mesma carga: a divisão fica equilibrada', async () => {
      await agentNamed('a');
      await agentNamed('b');

      await Promise.all(Array.from({ length: 8 }, () => openTicket()));
      expect(await loads()).toEqual({ a: 4, b: 4 });
    });

    it('sem agente disponível, o ticket fica sem responsável', async () => {
      await agentNamed('ausente', false);
      expect((await openTicket()).assignee).toBeNull();
    });

    it('o agente atribuído tira o ticket de OPEN', async () => {
      const agent = await agentNamed('agente');
      const ticket = await openTicket();
      const res = await as(agent)
        .post(`/api/tickets/${ticket.id}/transitions`)
        .send({ to: 'IN_PROGRESS' })
        .expect(200);
      expect(res.body.status).toBe('IN_PROGRESS');
    });
  });

  describe('disponibilidade', () => {
    it('ficar disponível distribui os órfãos abertos, e só eles', async () => {
      const agent = await agentNamed('agente', false);
      const orphans = [await openTicket(), await openTicket()];
      const resolved = await openTicket();
      await setTicket(resolved.id, { status: 'RESOLVED', resolvedAt: new Date() });

      const res = await as(agent)
        .patch('/api/users/me/availability')
        .send({ isAvailable: true })
        .expect(200);
      expect(res.body).toEqual({ isAvailable: true });

      for (const { id } of orphans) expect(await assigneeOf(id)).toBe(agent.id);
      expect(await assigneeOf(resolved.id)).toBeNull();
    });

    it('os órfãos se dividem pela carga entre os agentes disponíveis', async () => {
      const first = await agentNamed('a', false);
      const second = await agentNamed('b', false);
      for (let i = 0; i < 4; i++) await openTicket();
      // O primeiro volta direto pelo banco, sem varredura: os 4 seguem órfãos.
      await prisma.user.update({ where: { id: first.id }, data: { isAvailable: true } });

      await as(second).patch('/api/users/me/availability').send({ isAvailable: true }).expect(200);
      expect(await loads()).toEqual({ a: 2, b: 2 });
    });

    it('a varredura atribui até 100 órfãos, os de prazo mais curto primeiro', async () => {
      const agent = await agentNamed('agente', false);
      const base = Date.now();
      // #0 tem o prazo mais folgado e é inserido primeiro: só a ordem por prazo o deixa de fora.
      await prisma.ticket.createMany({
        data: Array.from({ length: 101 }, (_, i) => ({
          title: `#${i}`,
          description: 'órfão',
          requesterId: customer.id,
          firstResponseDueAt: new Date(base + (101 - i) * HOUR),
          resolutionDueAt: new Date(base + (101 - i) * 2 * HOUR),
        })),
      });

      await as(agent).patch('/api/users/me/availability').send({ isAvailable: true }).expect(200);
      const left = await prisma.ticket.findMany({ where: { assigneeId: null } });
      expect(left.map((ticket) => ticket.title)).toEqual(['#0']);
    });

    it('ficar indisponível mantém os tickets e tira o agente da fila', async () => {
      const agent = await agentNamed('agente');
      const ticket = await openTicket();

      await as(agent).patch('/api/users/me/availability').send({ isAvailable: false }).expect(200);
      const me = await as(agent).get('/api/users/me/availability').expect(200);
      expect(me.body).toEqual({ isAvailable: false });

      expect(await assigneeOf(ticket.id)).toBe(agent.id);
      expect((await openTicket()).assignee).toBeNull();
    });

    it('o admin muda a disponibilidade de qualquer agente, e só de agentes', async () => {
      const agent = await agentNamed('agente', false);
      await openTicket();

      await as(admin)
        .patch(`/api/users/${agent.id}/availability`)
        .send({ isAvailable: true })
        .expect(200);
      expect(await loads()).toEqual({ agente: 1 });

      for (const target of [customer.id, admin.id, MISSING]) {
        await as(admin)
          .patch(`/api/users/${target}/availability`)
          .send({ isAvailable: true })
          .expect(404);
      }
    });

    it('o agente não muda a disponibilidade de outro; cliente e admin não têm "me"', async () => {
      const agent = await agentNamed('agente');
      const other = await agentNamed('outro', false);

      await as(agent)
        .patch(`/api/users/${other.id}/availability`)
        .send({ isAvailable: true })
        .expect(403);
      for (const actor of [customer, admin]) {
        await as(actor).get('/api/users/me/availability').expect(403);
        await as(actor).patch('/api/users/me/availability').send({ isAvailable: true }).expect(403);
      }
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
      expect(stored.isAvailable).toBe(false);
    });

    it.each([
      ['corpo vazio', {}],
      ['isAvailable que não é booleano', { isAvailable: 'sim' }],
      ['campo a mais', { isAvailable: true, role: 'ADMIN' }],
    ])('retorna 400 com %s', async (_case, body) => {
      const agent = await agentNamed('agente');
      await as(agent).patch('/api/users/me/availability').send(body).expect(400);
    });
  });

  describe('GET /api/users/agents', () => {
    it('lista os agentes com disponibilidade e carga, só para o admin', async () => {
      const agent = await agentNamed('agente');
      await agentNamed('ausente', false);
      await openTicket();

      const res = await as(admin).get('/api/users/agents').expect(200);
      expect(res.body).toEqual([
        {
          id: agent.id,
          name: 'agente',
          email: 'agente@example.com',
          isAvailable: true,
          openTickets: 1,
        },
        expect.objectContaining({ name: 'ausente', isAvailable: false, openTickets: 0 }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');

      await as(agent).get('/api/users/agents').expect(403);
      await as(customer).get('/api/users/agents').expect(403);
    });
  });

  describe('reatribuição (PATCH /api/tickets/:id)', () => {
    let agent: Actor;
    let other: Actor;
    let ticket: TicketDetail;

    beforeEach(async () => {
      agent = await agentNamed('agente');
      other = await agentNamed('outro', false);
      ticket = await openTicket();
      await setTicket(ticket.id, { status: 'IN_PROGRESS' });
    });

    const reassign = (by: Actor, body: object, id = ticket.id) =>
      as(by).patch(`/api/tickets/${id}`).send(body);

    it('o admin troca o responsável, inclusive para um agente indisponível', async () => {
      const before = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });

      const res = await reassign(admin, { assigneeId: other.id }).expect(200);
      expect(res.body).toMatchObject({
        assignee: { id: other.id, name: 'outro' },
        status: 'IN_PROGRESS',
      });
      // Atribuição manual não mexe no cursor da fila automática.
      const after = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
      expect(after.lastAssignedAt).toEqual(before.lastAssignedAt);
    });

    it('o admin troca prioridade e responsável de uma vez', async () => {
      const res = await reassign(admin, { priority: 'URGENT', assigneeId: other.id }).expect(200);
      expect(res.body).toMatchObject({ priority: 'URGENT', assignee: { id: other.id } });
    });

    it('o agente que manda assigneeId recebe 403 e nada é aplicado', async () => {
      await reassign(agent, { priority: 'URGENT', assigneeId: other.id }).expect(403);
      const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(stored).toMatchObject({ priority: 'MEDIUM', assigneeId: agent.id });
    });

    it('quem não pode alterar recebe 403/404 sem entrar na fila do lock', async () => {
      const foreign = await openTicket(otherCustomer);
      // Com o lock seguro, quem entrasse na fila esperaria 2 s e receberia 503.
      await withLockHeld(async () => {
        await reassign(customer, { priority: 'URGENT' }).expect(403);
        await reassign(customer, { priority: 'URGENT' }, foreign.id).expect(404);
        await reassign(agent, { assigneeId: other.id }).expect(403);
      });
    });

    it('o cliente recebe 403 no próprio ticket e 404 no de outro', async () => {
      await reassign(customer, { assigneeId: other.id }).expect(403);
      const foreign = await openTicket(otherCustomer);
      await reassign(customer, { assigneeId: other.id }, foreign.id).expect(404);
    });

    it.each([
      ['um cliente', () => customer.id],
      ['um admin', () => admin.id],
      ['um id inexistente', () => MISSING],
    ])('responsável que é %s é 422', async (_case, target) => {
      await reassign(admin, { assigneeId: target() }).expect(422);
      expect(await assigneeOf(ticket.id)).toBe(agent.id);
    });

    it.each([
      ['corpo vazio', {}],
      ['assigneeId nulo', { assigneeId: null }],
      ['prioridade nula', { priority: null }],
      ['assigneeId que não é UUID', { assigneeId: 'fulano' }],
    ])('retorna 400 com %s', async (_case, body) => {
      await reassign(admin, body).expect(400);
    });

    it('ordem dos erros: 403 antes de 409, e 409 antes de 422', async () => {
      await setTicket(ticket.id, { status: 'CLOSED' });
      await reassign(agent, { assigneeId: other.id }).expect(403);
      await reassign(admin, { assigneeId: customer.id }).expect(409);
    });
  });
});
