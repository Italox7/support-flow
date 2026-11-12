import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TicketDetail } from '@support-flow/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TicketsService } from '../src/tickets/tickets.service.js';
import {
  createActor,
  createApp,
  resetDatabase,
  TEST_DATABASE_URL,
  type Actor,
  withSlaClock,
} from './e2e-setup.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Datas de abertura distintas: dois tickets no mesmo ms trocariam de ordem. */
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR);

// Os agentes daqui ficam indisponíveis: o ticket nasce sem responsável e cada
// teste atribui quem precisar. A atribuição automática é testada em
// assignment.e2e-spec.ts.

describe.skipIf(!TEST_DATABASE_URL)('tickets (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let customer: Actor;
  let otherCustomer: Actor;
  let agent: Actor;
  let otherAgent: Actor;
  let admin: Actor;

  const http = () => request(app.getHttpServer());
  const as = (actor: Actor) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${actor.token}`),
    post: (url: string) => http().post(url).set('Authorization', `Bearer ${actor.token}`),
    patch: (url: string) => http().patch(url).set('Authorization', `Bearer ${actor.token}`),
  });

  async function openTicket(by: Actor, body: object = {}): Promise<TicketDetail> {
    const res = await as(by)
      .post('/api/tickets')
      .send({ title: 'Não consigo entrar', description: 'Dá erro 500 no login.', ...body })
      .expect(201);
    return res.body;
  }

  /** Coloca o ticket num estado direto pelo banco, sem passar pelas regras. */
  async function setTicket(id: string, data: Prisma.TicketUpdateInput): Promise<void> {
    await prisma.ticket.update({ where: { id }, data: withSlaClock(data) });
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
    agent = await createActor(app, 'AGENT', 'agente', { isAvailable: false });
    otherAgent = await createActor(app, 'AGENT', 'outro-agente', { isAvailable: false });
    admin = await createActor(app, 'ADMIN', 'admin');
  });

  it('exige autenticação', async () => {
    await http().get('/api/tickets').expect(401);
    await http().post('/api/tickets').send({}).expect(401);
  });

  it('nenhuma resposta da API pode ir para cache', async () => {
    await openTicket(customer);
    const list = await as(customer).get('/api/tickets').expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const unauthorized = await http().get('/api/tickets').expect(401);
    expect(unauthorized.headers['cache-control']).toBe('no-store');
    const missing = await as(customer).get('/api/rota-que-nao-existe').expect(404);
    expect(missing.headers['cache-control']).toBe('no-store');
  });

  describe('POST /api/tickets', () => {
    it('sem agente disponível, abre em OPEN, sem responsável, com os prazos da MEDIUM', async () => {
      const ticket = await openTicket(customer);

      expect(ticket).toEqual({
        id: expect.any(String),
        number: expect.any(Number),
        title: 'Não consigo entrar',
        description: 'Dá erro 500 no login.',
        status: 'OPEN',
        priority: 'MEDIUM',
        requester: { id: customer.id, name: 'cliente' },
        assignee: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        firstResponseAt: null,
        resolvedAt: null,
        closedAt: null,
        allowedTransitions: [],
      });
      const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      const createdAt = stored.createdAt.getTime();
      expect(stored.firstResponseDueAt.getTime() - createdAt).toBe(8 * HOUR);
      expect(stored.resolutionDueAt.getTime() - createdAt).toBe(48 * HOUR);
    });

    it('usa a prioridade sugerida pelo cliente para os prazos', async () => {
      const ticket = await openTicket(customer, { priority: 'URGENT' });
      const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(stored.firstResponseDueAt.getTime() - stored.createdAt.getTime()).toBe(HOUR);
    });

    it.each([
      ['título vazio', { title: '   ' }],
      ['título longo demais', { title: 'x'.repeat(201) }],
      // O Postgres recusa NUL em texto: sem a validação, o INSERT daria 500.
      ['título com NUL', { title: 'a\u0000b' }],
      ['descrição com NUL', { description: 'a\u0000b' }],
      ['prioridade inexistente', { priority: 'CRITICAL' }],
      ['responsável no corpo', { assigneeId: '00000000-0000-4000-8000-000000000000' }],
      ['status no corpo', { status: 'RESOLVED' }],
    ])('retorna 400 com %s', async (_case, override) => {
      await as(customer)
        .post('/api/tickets')
        .send({ title: 'Título', description: 'Descrição', ...override })
        .expect(400);
    });
  });

  describe('GET /api/tickets', () => {
    it('o cliente só vê os próprios tickets; a equipe vê todos', async () => {
      const mine = await openTicket(customer);
      await openTicket(otherCustomer);

      const res = await as(customer).get('/api/tickets').expect(200);
      expect(res.body).toEqual({
        items: [expect.objectContaining({ id: mine.id })],
        page: 1,
        pageSize: 20,
        total: 1,
      });

      expect((await as(agent).get('/api/tickets').expect(200)).body.total).toBe(2);
      expect((await as(admin).get('/api/tickets').expect(200)).body.total).toBe(2);
    });

    it('filtra por status (repetível), prioridade e responsável', async () => {
      const open = await openTicket(customer, { priority: 'HIGH' });
      const waiting = await openTicket(customer);
      const resolved = await openTicket(customer);
      await setTicket(open.id, { createdAt: hoursAgo(3) });
      await setTicket(waiting.id, {
        status: 'WAITING_CUSTOMER',
        assignee: { connect: { id: agent.id } },
        createdAt: hoursAgo(2),
      });
      await setTicket(resolved.id, {
        status: 'RESOLVED',
        assignee: { connect: { id: otherAgent.id } },
        createdAt: hoursAgo(1),
      });

      const ids = async (query: string) =>
        (await as(agent).get(`/api/tickets?${query}`).expect(200)).body.items.map(
          (t: TicketDetail) => t.id,
        );

      expect(await ids('status=OPEN&status=WAITING_CUSTOMER')).toEqual([waiting.id, open.id]);
      expect(await ids('priority=HIGH')).toEqual([open.id]);
      expect(await ids('assigneeId=me')).toEqual([waiting.id]);
      expect(await ids('assigneeId=none')).toEqual([open.id]);
      expect(await ids(`assigneeId=${otherAgent.id}`)).toEqual([resolved.id]);
    });

    it('pagina do mais novo para o mais antigo', async () => {
      const created: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { id } = await openTicket(customer);
        await setTicket(id, { createdAt: hoursAgo(3 - i) });
        created.push(id);
      }

      const res = await as(customer).get('/api/tickets?page=2&pageSize=2').expect(200);
      expect(res.body).toEqual({
        items: [expect.objectContaining({ id: created[0] })],
        page: 2,
        pageSize: 2,
        total: 3,
      });
    });

    it.each([
      ['pageSize acima de 100', 'pageSize=101'],
      ['página zero', 'page=0'],
      ['página acima do máximo', 'page=10001'],
      ['página fora da faixa de inteiros', 'page=1e300'],
      ['status inexistente', 'status=PENDING'],
      ['responsável inválido', 'assigneeId=fulano'],
    ])('retorna 400 com %s', async (_case, query) => {
      await as(agent).get(`/api/tickets?${query}`).expect(400);
    });
  });

  describe('escopo do cliente', () => {
    it('ticket de outro cliente é 404 em toda rota, igual a um ticket inexistente', async () => {
      const { id } = await openTicket(otherCustomer);
      const missing = '00000000-0000-4000-8000-000000000000';

      for (const target of [id, missing]) {
        await as(customer).get(`/api/tickets/${target}`).expect(404);
        await as(customer).patch(`/api/tickets/${target}`).send({ priority: 'URGENT' }).expect(404);
        await as(customer)
          .post(`/api/tickets/${target}/transitions`)
          .send({ to: 'RESOLVED' })
          .expect(404);
        await as(customer).get(`/api/tickets/${target}/comments`).expect(404);
        await as(customer).post(`/api/tickets/${target}/comments`).send({ body: 'oi' }).expect(404);
      }
      expect(await prisma.comment.count()).toBe(0);
    });

    it('id que não é UUID é 400', async () => {
      await as(customer).get('/api/tickets/123').expect(400);
    });
  });

  describe('PATCH /api/tickets/:id', () => {
    it('o agente troca a prioridade e os prazos são recalculados a partir da abertura', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { pausedSeconds: 600 });

      const res = await as(agent)
        .patch(`/api/tickets/${ticket.id}`)
        .send({ priority: 'URGENT' })
        .expect(200);
      expect(res.body.priority).toBe('URGENT');

      const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(stored.firstResponseDueAt.getTime() - stored.createdAt.getTime()).toBe(HOUR + 600_000);
      expect(stored.resolutionDueAt.getTime() - stored.createdAt.getTime()).toBe(
        4 * HOUR + 600_000,
      );
    });

    it('o cliente não altera a prioridade do próprio ticket', async () => {
      const ticket = await openTicket(customer);
      await as(customer)
        .patch(`/api/tickets/${ticket.id}`)
        .send({ priority: 'URGENT' })
        .expect(403);
    });

    it('não altera ticket fechado', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { status: 'CLOSED' });
      await as(agent).patch(`/api/tickets/${ticket.id}`).send({ priority: 'LOW' }).expect(409);
    });
  });

  describe('POST /api/tickets/:id/transitions', () => {
    const transition = (by: Actor, id: string, to: string) =>
      as(by).post(`/api/tickets/${id}/transitions`).send({ to });

    it('o agente responsável assume o ticket; outro agente não', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { assignee: { connect: { id: agent.id } } });

      await transition(otherAgent, ticket.id, 'IN_PROGRESS').expect(403);
      const res = await transition(agent, ticket.id, 'IN_PROGRESS').expect(200);
      expect(res.body.status).toBe('IN_PROGRESS');
    });

    it('o admin tira de OPEN um ticket sem responsável', async () => {
      const ticket = await openTicket(customer);
      await transition(admin, ticket.id, 'IN_PROGRESS').expect(200);
    });

    it('o cliente resolve e reabre o próprio ticket', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { status: 'IN_PROGRESS' });

      const resolved = await transition(customer, ticket.id, 'RESOLVED').expect(200);
      expect(resolved.body.resolvedAt).toEqual(expect.any(String));

      const reopened = await transition(customer, ticket.id, 'IN_PROGRESS').expect(200);
      expect(reopened.body).toMatchObject({ status: 'IN_PROGRESS', resolvedAt: null });
    });

    it('o cliente não reabre no 8º dia', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, {
        status: 'RESOLVED',
        resolvedAt: new Date(Date.now() - 8 * DAY),
      });
      await transition(customer, ticket.id, 'IN_PROGRESS').expect(409);
    });

    it('allowedTransitions vem em toda resposta de detalhe, para quem pede', async () => {
      const ticket = await openTicket(customer);
      expect(ticket.allowedTransitions).toEqual([]);
      await setTicket(ticket.id, { assignee: { connect: { id: agent.id } } });

      const get = (by: Actor) => as(by).get(`/api/tickets/${ticket.id}`).expect(200);
      expect((await get(agent)).body.allowedTransitions).toEqual(['IN_PROGRESS']);
      expect((await get(otherAgent)).body.allowedTransitions).toEqual([]);

      const patched = await as(agent)
        .patch(`/api/tickets/${ticket.id}`)
        .send({ priority: 'HIGH' })
        .expect(200);
      expect(patched.body.allowedTransitions).toEqual(['IN_PROGRESS']);

      const moved = await transition(agent, ticket.id, 'IN_PROGRESS').expect(200);
      expect(moved.body.allowedTransitions).toEqual(['WAITING_CUSTOMER', 'RESOLVED']);
    });

    it('allowedTransitions concorda com a rota: o listado passa, o resto é recusado', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { status: 'IN_PROGRESS' });

      const before = await as(customer).get(`/api/tickets/${ticket.id}`).expect(200);
      expect(before.body.allowedTransitions).toEqual(['RESOLVED']);
      await transition(customer, ticket.id, 'WAITING_CUSTOMER').expect(403);

      const resolved = await transition(customer, ticket.id, 'RESOLVED').expect(200);
      expect(resolved.body.allowedTransitions).toEqual(['IN_PROGRESS']);

      await setTicket(ticket.id, { resolvedAt: new Date(Date.now() - 8 * DAY) });
      const expired = await as(customer).get(`/api/tickets/${ticket.id}`).expect(200);
      expect(expired.body.allowedTransitions).toEqual([]);
      await transition(customer, ticket.id, 'IN_PROGRESS').expect(409);
    });

    it('o cliente não pede informação a si mesmo', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { status: 'IN_PROGRESS' });
      await transition(customer, ticket.id, 'WAITING_CUSTOMER').expect(403);
    });

    it('ninguém fecha pelo endpoint: o fechamento é do job', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { status: 'RESOLVED', resolvedAt: new Date() });
      await transition(admin, ticket.id, 'CLOSED').expect(403);
    });

    it('transição fora do ciclo de vida é 409', async () => {
      const ticket = await openTicket(customer);
      await transition(admin, ticket.id, 'RESOLVED').expect(409);
      await transition(admin, ticket.id, 'OPEN').expect(409);
    });

    it('de duas transições simultâneas, uma passa e a outra recebe 409', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { status: 'IN_PROGRESS' });

      // Mesmo destino: em qualquer ordem, a segunda vê RESOLVED (ou perde o
      // update condicional) e recebe 409.
      const results = await Promise.all([
        transition(agent, ticket.id, 'RESOLVED'),
        transition(admin, ticket.id, 'RESOLVED'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('applyTransition recusa um status lido que já mudou no banco', async () => {
      const ticket = await openTicket(customer);
      const stale = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      await setTicket(ticket.id, { status: 'WAITING_CUSTOMER' });

      const tickets = app.get(TicketsService);
      expect(await tickets.applyTransition(prisma, stale, 'IN_PROGRESS', new Date())).toBe(false);

      const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(stored.status).toBe('WAITING_CUSTOMER');
    });

    it('rejeita status inexistente com 400', async () => {
      const ticket = await openTicket(customer);
      await transition(admin, ticket.id, 'ARCHIVED').expect(400);
    });
  });

  describe('comentários', () => {
    const comment = (by: Actor, id: string, body: object) =>
      as(by).post(`/api/tickets/${id}/comments`).send(body);

    it('o cliente nunca recebe notas internas', async () => {
      const ticket = await openTicket(customer);
      await comment(agent, ticket.id, { body: 'Nota: cliente VIP', isInternal: true }).expect(201);
      await comment(agent, ticket.id, { body: 'Olá! Estamos vendo.' }).expect(201);

      const forCustomer = await as(customer).get(`/api/tickets/${ticket.id}/comments`).expect(200);
      expect(forCustomer.body).toEqual([
        expect.objectContaining({ body: 'Olá! Estamos vendo.', isInternal: false }),
      ]);
      expect(JSON.stringify(forCustomer.body)).not.toContain('VIP');

      const forAgent = await as(agent).get(`/api/tickets/${ticket.id}/comments`).expect(200);
      expect(forAgent.body.map((c: { body: string }) => c.body)).toEqual([
        'Nota: cliente VIP',
        'Olá! Estamos vendo.',
      ]);
      expect(forAgent.body[0]).toEqual({
        id: expect.any(String),
        ticketId: ticket.id,
        author: { id: agent.id, name: 'agente', role: 'AGENT' },
        body: 'Nota: cliente VIP',
        isInternal: true,
        createdAt: expect.any(String),
      });
    });

    it('o cliente não cria nota interna', async () => {
      const ticket = await openTicket(customer);
      await comment(customer, ticket.id, { body: 'segredo', isInternal: true }).expect(403);
      expect(await prisma.comment.count()).toBe(0);
    });

    it('a 1ª resposta pública de um agente marca a 1ª resposta; nota interna não', async () => {
      const ticket = await openTicket(customer);

      await comment(otherAgent, ticket.id, { body: 'nota', isInternal: true }).expect(201);
      let stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(stored.firstResponseAt).toBeNull();

      await comment(otherAgent, ticket.id, { body: 'Olá!' }).expect(201);
      stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(stored.firstResponseAt).not.toBeNull();
      // Sem ser o responsável, responder não tira o ticket de OPEN.
      expect(stored.status).toBe('OPEN');
    });

    it('a resposta do agente responsável leva o ticket de OPEN para IN_PROGRESS', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { assignee: { connect: { id: agent.id } } });
      await comment(agent, ticket.id, { body: 'Vou verificar.' }).expect(201);

      const res = await as(customer).get(`/api/tickets/${ticket.id}`).expect(200);
      expect(res.body.status).toBe('IN_PROGRESS');
    });

    it('o comentário do cliente devolve WAITING_CUSTOMER para IN_PROGRESS', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { status: 'WAITING_CUSTOMER' });
      await comment(customer, ticket.id, { body: 'Segue o print.' }).expect(201);

      const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(stored.status).toBe('IN_PROGRESS');
    });

    it('o comentário do cliente num ticket resolvido não o reabre', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { status: 'RESOLVED', resolvedAt: new Date() });
      await comment(customer, ticket.id, { body: 'Obrigado!' }).expect(201);

      const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(stored.status).toBe('RESOLVED');
    });

    it('ticket fechado não aceita comentários', async () => {
      const ticket = await openTicket(customer);
      await setTicket(ticket.id, { status: 'CLOSED' });
      await comment(agent, ticket.id, { body: 'tarde demais' }).expect(409);
    });

    it.each([
      ['corpo vazio', { body: '   ' }],
      ['corpo longo demais', { body: 'x'.repeat(10_001) }],
      ['corpo com NUL', { body: 'a\u0000b' }],
      ['isInternal que não é booleano', { body: 'oi', isInternal: 'sim' }],
    ])('retorna 400 com %s', async (_case, body) => {
      const ticket = await openTicket(customer);
      await comment(agent, ticket.id, body).expect(400);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('rate limit global (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ throttle: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('bloqueia a 121ª requisição no mesmo minuto, antes mesmo da autenticação', async () => {
    const attempt = () => request(app.getHttpServer()).get('/api/tickets');
    for (let i = 0; i < 120; i++) await attempt().expect(401);
    const blocked = await attempt().expect(429);
    expect(blocked.headers['cache-control']).toBe('no-store');
  });
});
