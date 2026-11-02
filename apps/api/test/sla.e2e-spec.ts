import type { NestExpressApplication } from '@nestjs/platform-express';
import type {
  Priority,
  SlaState,
  TicketDetail,
  TicketStatus,
  TicketSummary,
} from '@support-flow/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSIGNMENT_LOCK_KEY } from '../src/assignment/assignment.service.js';
import type { Prisma, Ticket } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SLA_RUNNING_STATUSES } from '../src/sla/sla-calculator.js';
import { computeDeadlines } from '../src/sla/sla-deadlines.js';
import { TicketsService } from '../src/tickets/tickets.service.js';
import {
  createActor,
  createApp,
  resetDatabase,
  TEST_DATABASE_URL,
  type Actor,
  withSlaClock,
} from './e2e-setup.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Políticas da migration de dados; os testes que editam restauram estas. */
const DEFAULT_POLICIES: Record<Priority, [number, number]> = {
  URGENT: [60, 240],
  HIGH: [240, 1440],
  MEDIUM: [480, 2880],
  LOW: [1440, 7200],
};

describe.skipIf(!TEST_DATABASE_URL)('SLA (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tickets: TicketsService;
  let customer: Actor;
  let agent: Actor;
  let admin: Actor;

  const http = () => request(app.getHttpServer());
  const as = (actor: Actor) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${actor.token}`),
    post: (url: string) => http().post(url).set('Authorization', `Bearer ${actor.token}`),
    patch: (url: string) => http().patch(url).set('Authorization', `Bearer ${actor.token}`),
    put: (url: string) => http().put(url).set('Authorization', `Bearer ${actor.token}`),
  });

  async function openTicket(body: object = {}): Promise<TicketDetail> {
    const res = await as(customer)
      .post('/api/tickets')
      .send({ title: 'Sem acesso', description: 'Erro 500 no login.', ...body })
      .expect(201);
    await setTicket(res.body.id, { assignee: { connect: { id: agent.id } } });
    return res.body;
  }

  async function setTicket(id: string, data: Prisma.TicketUpdateInput): Promise<Ticket> {
    return prisma.ticket.update({ where: { id }, data: withSlaClock(data) });
  }

  const stored = (id: string) => prisma.ticket.findUniqueOrThrow({ where: { id } });

  /** Prazos gravados de acordo com a política da prioridade e a pausa acumulada. */
  async function expectDeadlinesOf(ticket: Ticket, priority: Priority): Promise<void> {
    const [firstResponseMinutes, resolutionMinutes] = DEFAULT_POLICIES[priority];
    expect(ticket.priority).toBe(priority);
    expect({
      firstResponseDueAt: ticket.firstResponseDueAt,
      firstResponseRiskAt: ticket.firstResponseRiskAt,
      resolutionDueAt: ticket.resolutionDueAt,
      resolutionRiskAt: ticket.resolutionRiskAt,
    }).toEqual(
      computeDeadlines(
        ticket.createdAt,
        { firstResponseMinutes, resolutionMinutes },
        ticket.pausedSeconds,
      ),
    );
  }

  /** Ticket em WAITING_CUSTOMER, pausado há uma hora. */
  async function waitingForAnHour(body: object = {}): Promise<Ticket> {
    const ticket = await openTicket(body);
    return setTicket(ticket.id, {
      status: 'WAITING_CUSTOMER',
      slaPausedAt: new Date(Date.now() - HOUR),
    });
  }

  /**
   * Segura a linha do ticket numa transação do teste: uma escrita da API nela
   * espera, mas a leitura passa. NO KEY UPDATE deixa passar o INSERT de um
   * comentário (a FK só pede KEY SHARE) e prende o UPDATE do ticket que vem
   * depois. `during` recebe o pid da transação que segura a linha.
   */
  async function withRowHeld(
    id: string,
    mode: 'UPDATE' | 'NO KEY UPDATE',
    during: (tx: Prisma.TransactionClient, holderPid: number) => Promise<void>,
  ): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        if (mode === 'UPDATE') {
          await tx.$queryRaw`SELECT "id" FROM "tickets" WHERE "id" = ${id}::uuid FOR UPDATE`;
        } else {
          await tx.$queryRaw`SELECT "id" FROM "tickets" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`;
        }
        const [{ pid }] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
        await during(tx, pid);
      },
      { timeout: 10_000 },
    );
  }

  /**
   * Dispara as requisições contra a linha presa, espera todas pararem nela, roda
   * `middle` com a linha ainda presa e solta. Devolve as respostas na ordem.
   */
  async function raceOnRow(
    id: string,
    mode: 'UPDATE' | 'NO KEY UPDATE',
    requests: (() => request.Test)[],
    middle: (tx: Prisma.TransactionClient) => Promise<void> = async () => undefined,
  ): Promise<request.Response[]> {
    let pending: Promise<request.Response>[] = [];
    try {
      await withRowHeld(id, mode, async (tx, holderPid) => {
        pending = requests.map((send) => start(send()));
        await waitForBlockedBy(holderPid, requests.length);
        await middle(tx);
      });
      return await Promise.all(pending);
    } finally {
      await Promise.allSettled(pending);
    }
  }

  async function withAssignmentLockHeld(during: () => Promise<void>): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ASSIGNMENT_LOCK_KEY}::bigint)`;
        await during();
      },
      { timeout: 10_000 },
    );
  }

  async function waitFor(
    what: string,
    count: number,
    sql: () => Promise<[{ waiting: number }]>,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [{ waiting }] = await sql();
      if (waiting >= count) return;
      await sleep(20);
    }
    throw new Error(`Menos de ${count} requisição(ões) ficaram esperando ${what}.`);
  }

  /**
   * Conexões presas pela transação do teste: direto, ou atrás de outra que já
   * espera por ela (a segunda escrita na mesma linha espera a primeira).
   */
  const waitForBlockedBy = (holderPid: number, count: number) =>
    waitFor(
      'a linha do ticket',
      count,
      () =>
        prisma.$queryRaw<[{ waiting: number }]>`
        WITH blocked AS (SELECT pid, pg_blocking_pids(pid) AS by FROM pg_stat_activity)
        SELECT count(*)::int AS waiting FROM blocked b
        WHERE ${holderPid}::int = ANY(b.by)
           OR EXISTS (SELECT 1 FROM blocked o WHERE o.pid = ANY(b.by) AND ${holderPid}::int = ANY(o.by))`,
    );

  const waitForAssignmentLockWaiter = () =>
    waitFor(
      'o lock da atribuição',
      1,
      () =>
        prisma.$queryRaw<[{ waiting: number }]>`
        SELECT count(*)::int AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
          AND classid = (${ASSIGNMENT_LOCK_KEY}::bigint >> 32)::oid
          AND objid = (${ASSIGNMENT_LOCK_KEY}::bigint & 4294967295)::oid`,
    );

  /** Dispara a requisição já (supertest só envia no then) e devolve a promise. */
  const start = (req: request.Test) => req.then((res) => res);

  beforeAll(async () => {
    app = await createApp({ throttle: false });
    prisma = app.get(PrismaService);
    tickets = app.get(TicketsService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    customer = await createActor(app, 'CUSTOMER', 'cliente');
    agent = await createActor(app, 'AGENT', 'agente', { isAvailable: false });
    admin = await createActor(app, 'ADMIN', 'admin');
  });

  describe('visibilidade', () => {
    it('a equipe recebe os dois relógios; para o cliente a chave sla não existe', async () => {
      const created = await openTicket({ priority: 'URGENT' });
      expect(created).not.toHaveProperty('sla');

      const forCustomer = await as(customer).get(`/api/tickets/${created.id}`).expect(200);
      const customerList = await as(customer).get('/api/tickets').expect(200);
      expect(forCustomer.body).not.toHaveProperty('sla');
      expect(customerList.body.items[0]).not.toHaveProperty('sla');

      const forAgent = await as(agent).get(`/api/tickets/${created.id}`).expect(200);
      const ticket = await stored(created.id);
      expect(forAgent.body.sla).toEqual({
        firstResponse: {
          state: 'OK',
          dueAt: ticket.firstResponseDueAt.toISOString(),
          remainingSeconds: expect.any(Number),
        },
        resolution: {
          state: 'OK',
          dueAt: ticket.resolutionDueAt.toISOString(),
          remainingSeconds: expect.any(Number),
        },
      });
      const agentList = await as(agent).get('/api/tickets').expect(200);
      expect(agentList.body.items[0].sla.resolution.state).toBe('OK');
    });

    it('o cliente não filtra por SLA (403); valor inválido ou repetido é 400', async () => {
      await as(customer).get('/api/tickets?sla=AT_RISK').expect(403);
      await as(agent).get('/api/tickets?sla=LATE').expect(400);
      await as(agent).get('/api/tickets?sla=BREACHED&sla=BREACHED').expect(400);
      await as(agent).get('/api/tickets?sla=AT_RISK&sla=BREACHED&sla=AT_RISK').expect(400);
    });

    it('a resposta da reabertura pelo cliente também não traz a chave sla', async () => {
      const ticket = await openTicket();
      await setTicket(ticket.id, { status: 'RESOLVED', resolvedAt: new Date() });
      const res = await as(customer)
        .post(`/api/tickets/${ticket.id}/transitions`)
        .send({ to: 'IN_PROGRESS' })
        .expect(200);
      expect(res.body).not.toHaveProperty('sla');
    });
  });

  describe('pausa e retomada', () => {
    it('esperar o cliente pausa; o comentário dele retoma e empurra os prazos pelo tempo parado', async () => {
      const ticket = await openTicket({ priority: 'URGENT' });
      await setTicket(ticket.id, { status: 'IN_PROGRESS' });
      await as(agent)
        .post(`/api/tickets/${ticket.id}/transitions`)
        .send({ to: 'WAITING_CUSTOMER' })
        .expect(200);
      const paused = await stored(ticket.id);
      expect(paused.slaPausedAt).not.toBeNull();
      const res = await as(agent).get(`/api/tickets/${ticket.id}`).expect(200);
      expect(res.body.sla.resolution.state).toBe('PAUSED');

      // Pausado há uma hora (direto no banco: o teste não espera uma hora).
      await setTicket(ticket.id, { slaPausedAt: new Date(Date.now() - HOUR) });
      await as(customer)
        .post(`/api/tickets/${ticket.id}/comments`)
        .send({ body: 'Segue o print.' })
        .expect(201);

      const resumed = await stored(ticket.id);
      expect(resumed.status).toBe('IN_PROGRESS');
      expect(resumed.slaPausedAt).toBeNull();
      expect(resumed.pausedSeconds).toBeGreaterThanOrEqual(3600);
      expect(resumed.pausedSeconds).toBeLessThan(3630);
      await expectDeadlinesOf(resumed, 'URGENT');
    });

    it('a 1ª resposta com o ticket pausado vale onde o relógio parou', async () => {
      const ticket = await openTicket({ priority: 'URGENT' });
      // Parou 10 min antes do prazo da 1ª resposta, que já passou no relógio de parede.
      const dueAt = new Date(Date.now() - 20 * MIN);
      await setTicket(ticket.id, {
        status: 'WAITING_CUSTOMER',
        firstResponseDueAt: dueAt,
        firstResponseRiskAt: new Date(dueAt.getTime() - 12 * MIN),
        slaPausedAt: new Date(dueAt.getTime() - 10 * MIN),
      });

      await as(agent)
        .post(`/api/tickets/${ticket.id}/comments`)
        .send({ body: 'Pode mandar o print?' })
        .expect(201);

      const res = await as(agent).get(`/api/tickets/${ticket.id}`).expect(200);
      expect(res.body.sla.firstResponse.state).toBe('MET');
      expect(res.body.sla.firstResponse.remainingSeconds).toBe(600);
    });

    it('o ticket resolvido sem resposta mostra a 1ª resposta como NOT_APPLICABLE', async () => {
      const ticket = await openTicket();
      await setTicket(ticket.id, { status: 'IN_PROGRESS' });
      await as(customer)
        .post(`/api/tickets/${ticket.id}/transitions`)
        .send({ to: 'RESOLVED' })
        .expect(200);

      const res = await as(agent).get(`/api/tickets/${ticket.id}`).expect(200);
      expect(res.body.sla.firstResponse.state).toBe('NOT_APPLICABLE');
      expect(res.body.sla.resolution.state).toBe('MET');

      // Responder depois de resolvido não muda o veredito.
      await as(agent)
        .post(`/api/tickets/${ticket.id}/comments`)
        .send({ body: 'Que bom que resolveu!' })
        .expect(201);
      expect((await stored(ticket.id)).firstResponseAt).toBeNull();
      const after = await as(agent).get(`/api/tickets/${ticket.id}`).expect(200);
      expect(after.body.sla.firstResponse.state).toBe('NOT_APPLICABLE');
    });

    it('o banco recusa relógio correndo com pausa e relógio parado sem pausa', async () => {
      const { id } = await openTicket();
      const violation = /tickets_sla_paused_check|check constraint/i;
      await expect(
        prisma.ticket.update({ where: { id }, data: { slaPausedAt: new Date() } }),
      ).rejects.toThrow(violation);
      await expect(
        prisma.ticket.update({ where: { id }, data: { status: 'WAITING_CUSTOMER' } }),
      ).rejects.toThrow(violation);
      await expect(
        prisma.ticket.update({ where: { id }, data: { status: 'CLOSED' } }),
      ).rejects.toThrow(violation);
    });
  });

  // Comentários (sem o lock da atribuição) contra outras escritas no ticket. A
  // linha fica presa em NO KEY UPDATE: o comentário é inserido e o efeito dele
  // no ticket é que espera.
  describe('corrida de comentários × relógio', () => {
    it(
      '1ª resposta com o ticket pausando no meio: relê e mede onde o relógio parou',
      { timeout: 15_000 },
      async () => {
        const ticket = await openTicket({ priority: 'URGENT' });
        const before = await setTicket(ticket.id, { status: 'IN_PROGRESS' });

        const [res] = await raceOnRow(
          ticket.id,
          'NO KEY UPDATE',
          [() => as(agent).post(`/api/tickets/${ticket.id}/comments`).send({ body: 'Olhando.' })],
          async (tx) => {
            const current = await tx.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
            // O comentário marca o horário antes de parar na linha; a pausa vem com
            // horário anterior a ele, para a resposta cair de fato dentro da pausa.
            const pausedAt = new Date(Date.now() - 30 * MIN);
            expect(await tickets.applyTransition(tx, current, 'WAITING_CUSTOMER', pausedAt)).toBe(
              true,
            );
          },
        );

        expect(res!.status).toBe(201);
        const after = await stored(ticket.id);
        expect(after.status).toBe('WAITING_CUSTOMER');
        expect(after.firstResponseAt).not.toBeNull();
        // A 1ª tentativa perdeu (guarda slaPausedAt nulo); a releitura empurrou o
        // prazo exatamente pelo tempo entre a pausa e a resposta.
        const pushedBy = after.firstResponseAt!.getTime() - after.slaPausedAt!.getTime();
        expect(pushedBy).toBeGreaterThan(29 * MIN);
        expect(after.firstResponseDueAt.getTime() - before.firstResponseDueAt.getTime()).toBe(
          pushedBy,
        );
        const sla = (await as(agent).get(`/api/tickets/${ticket.id}`).expect(200)).body.sla;
        expect(sla.firstResponse.state).toBe('MET');
        expect(sla.firstResponse.remainingSeconds).toBe(
          Math.floor((before.firstResponseDueAt.getTime() - after.slaPausedAt!.getTime()) / 1000),
        );
      },
    );

    it(
      'equipe e cliente retomando ao mesmo tempo: a pausa entra uma vez só',
      { timeout: 15_000 },
      async () => {
        const ticket = await waitingForAnHour();

        const [transition, comment] = await raceOnRow(ticket.id, 'NO KEY UPDATE', [
          () => as(agent).post(`/api/tickets/${ticket.id}/transitions`).send({ to: 'IN_PROGRESS' }),
          () => as(customer).post(`/api/tickets/${ticket.id}/comments`).send({ body: 'Voltei.' }),
        ]);

        // Quem chega depois perde: a transição leva 409, o comentário fica sem efeito.
        expect([200, 409]).toContain(transition!.status);
        expect(comment!.status).toBe(201);
        const after = await stored(ticket.id);
        expect(after.status).toBe('IN_PROGRESS');
        expect(after.pausedSeconds).toBeGreaterThanOrEqual(3600);
        expect(after.pausedSeconds).toBeLessThan(3630);
        await expectDeadlinesOf(after, 'MEDIUM');
        expect(await prisma.comment.count({ where: { ticketId: ticket.id } })).toBe(1);
      },
    );
  });

  describe('troca de prioridade', () => {
    it('recalcula a partir da abertura, somando as pausas encerradas', async () => {
      const ticket = await openTicket();
      await setTicket(ticket.id, { status: 'IN_PROGRESS', pausedSeconds: 900 });
      await as(agent).patch(`/api/tickets/${ticket.id}`).send({ priority: 'URGENT' }).expect(200);
      await expectDeadlinesOf(await stored(ticket.id), 'URGENT');
    });

    it('não mexe no prazo da 1ª resposta já dada', async () => {
      const ticket = await openTicket();
      await setTicket(ticket.id, { status: 'IN_PROGRESS', firstResponseAt: new Date() });
      const before = await stored(ticket.id);

      await as(agent).patch(`/api/tickets/${ticket.id}`).send({ priority: 'URGENT' }).expect(200);
      const after = await stored(ticket.id);
      expect(after.firstResponseDueAt).toEqual(before.firstResponseDueAt);
      expect(after.resolutionDueAt.getTime() - after.createdAt.getTime()).toBe(4 * HOUR);
    });

    it('em ticket resolvido é 409', async () => {
      const ticket = await openTicket();
      await setTicket(ticket.id, { status: 'RESOLVED', resolvedAt: new Date() });
      await as(agent).patch(`/api/tickets/${ticket.id}`).send({ priority: 'URGENT' }).expect(409);
    });
  });

  // PATCH de prioridade (sob o lock da atribuição) contra pausa, retomada e 1ª
  // resposta (sem o lock). O teste prende a linha do ticket: o PATCH lê, fica
  // parado na escrita, e a outra escrita roda pelo código real no meio.
  describe('corrida PATCH × relógio', () => {
    async function patchDuring(
      id: string,
      middle: (tx: Prisma.TransactionClient) => Promise<void>,
    ): Promise<number> {
      const [res] = await raceOnRow(
        id,
        'UPDATE',
        [() => as(agent).patch(`/api/tickets/${id}`).send({ priority: 'URGENT' })],
        middle,
      );
      return res!.status;
    }

    const reread = (tx: Prisma.TransactionClient, id: string) =>
      tx.ticket.findUniqueOrThrow({ where: { id } });

    it('(a) retomada no meio: 409, e a retomada fica', { timeout: 15_000 }, async () => {
      const ticket = await waitingForAnHour();

      const status = await patchDuring(ticket.id, async (tx) => {
        expect(
          await tickets.applyTransition(tx, await reread(tx, ticket.id), 'IN_PROGRESS', new Date()),
        ).toBe(true);
      });

      expect(status).toBe(409);
      const after = await stored(ticket.id);
      expect(after.status).toBe('IN_PROGRESS');
      expect(after.pausedSeconds).toBeGreaterThanOrEqual(3600);
      await expectDeadlinesOf(after, 'MEDIUM');
    });

    it(
      '(b) retomada e nova pausa no meio: o status volta igual e só a guarda de pausedSeconds pega',
      { timeout: 15_000 },
      async () => {
        const ticket = await waitingForAnHour();

        const status = await patchDuring(ticket.id, async (tx) => {
          const now = new Date();
          await tickets.applyTransition(tx, await reread(tx, ticket.id), 'IN_PROGRESS', now);
          await tickets.applyTransition(tx, await reread(tx, ticket.id), 'WAITING_CUSTOMER', now);
        });

        expect(status).toBe(409);
        const after = await stored(ticket.id);
        expect(after.status).toBe('WAITING_CUSTOMER');
        expect(after.pausedSeconds).toBeGreaterThanOrEqual(3600);
        await expectDeadlinesOf(after, 'MEDIUM');
      },
    );

    it(
      '(c) a retomada passa enquanto o PATCH espera o lock: ele recalcula com a pausa nova',
      { timeout: 15_000 },
      async () => {
        const ticket = await waitingForAnHour();

        let pending: Promise<request.Response> | undefined;
        try {
          await withAssignmentLockHeld(async () => {
            pending = start(
              as(agent).patch(`/api/tickets/${ticket.id}`).send({ priority: 'URGENT' }),
            );
            await waitForAssignmentLockWaiter();
            await as(agent)
              .post(`/api/tickets/${ticket.id}/transitions`)
              .send({ to: 'IN_PROGRESS' })
              .expect(200);
          });
          expect((await pending!).status).toBe(200);
        } finally {
          await pending?.catch(() => undefined);
        }

        const after = await stored(ticket.id);
        expect(after.pausedSeconds).toBeGreaterThanOrEqual(3600);
        await expectDeadlinesOf(after, 'URGENT');
      },
    );

    it('(d) PATCH no meio de uma retomada: a retomada não regrava os prazos antigos', async () => {
      const ticket = await waitingForAnHour();
      // A retomada leu o ticket antes de o PATCH passar.
      const readByResume = await stored(ticket.id);
      await as(agent).patch(`/api/tickets/${ticket.id}`).send({ priority: 'URGENT' }).expect(200);

      expect(await tickets.applyTransition(prisma, readByResume, 'IN_PROGRESS', new Date())).toBe(
        false,
      );
      const stillPaused = await stored(ticket.id);
      expect(stillPaused.status).toBe('WAITING_CUSTOMER');
      await expectDeadlinesOf(stillPaused, 'URGENT');

      // Vindo de um comentário do cliente, o efeito relê e retoma com os prazos novos.
      await prisma.$transaction((tx) =>
        tickets.applyCommentEffects(
          tx,
          readByResume,
          { id: customer.id, role: 'CUSTOMER' },
          false,
          new Date(),
        ),
      );
      const resumed = await stored(ticket.id);
      expect(resumed.status).toBe('IN_PROGRESS');
      expect(resumed.pausedSeconds).toBeGreaterThanOrEqual(3600);
      await expectDeadlinesOf(resumed, 'URGENT');
    });

    it(
      '(e) 1ª resposta no meio: 409, e o prazo congelado da 1ª resposta fica',
      { timeout: 15_000 },
      async () => {
        const ticket = await waitingForAnHour();
        let frozen: Date | undefined;

        const status = await patchDuring(ticket.id, async (tx) => {
          await tickets.applyCommentEffects(
            tx,
            await reread(tx, ticket.id),
            { id: agent.id, role: 'AGENT' },
            false,
            new Date(),
          );
          frozen = (await reread(tx, ticket.id)).firstResponseDueAt;
        });

        expect(status).toBe(409);
        const after = await stored(ticket.id);
        expect(after.priority).toBe('MEDIUM');
        expect(after.firstResponseAt).not.toBeNull();
        expect(after.firstResponseDueAt).toEqual(frozen);
        // Empurrado pela hora de pausa até a resposta.
        expect(after.firstResponseDueAt.getTime()).toBeGreaterThan(
          ticket.firstResponseDueAt.getTime() + HOUR - MIN,
        );
      },
    );
  });

  // O filtro em SQL e o computeSla são duas implementações da mesma regra. A
  // matriz cobre status × 1ª resposta × posição do relógio e exige que o filtro
  // devolva exatamente os tickets que o cálculo põe no estado.
  describe('filtro ?sla= bate com o computeSla', () => {
    const STATUSES: TicketStatus[] = [
      'OPEN',
      'IN_PROGRESS',
      'WAITING_CUSTOMER',
      'RESOLVED',
      'CLOSED',
    ];
    type Position = 'EARLY' | 'RISK' | 'LATE';
    const POSITIONS: Position[] = ['EARLY', 'RISK', 'LATE'];
    type FirstResponse = Position | 'ANSWERED_ON_TIME' | 'ANSWERED_LATE';
    const FIRST_RESPONSES: FirstResponse[] = [...POSITIONS, 'ANSWERED_ON_TIME', 'ANSWERED_LATE'];

    /** Prazo e risco em torno do instante em que o relógio está. */
    function around(clockAt: number, position: Position): { due: Date; risk: Date } {
      const offsets: Record<Position, [number, number]> = {
        EARLY: [8, 10],
        RISK: [-1, 1],
        LATE: [-2, -1],
      };
      const [riskHours, dueHours] = offsets[position];
      return {
        risk: new Date(clockAt + riskHours * HOUR),
        due: new Date(clockAt + dueHours * HOUR),
      };
    }

    const states = (t: TicketSummary): SlaState[] => [
      t.sla!.firstResponse.state,
      t.sla!.resolution.state,
    ];

    /**
     * Lista tudo (o computeSla de cada ticket vem na resposta) e exige que cada
     * filtro devolva exatamente os tickets com um relógio no estado, e que nenhum
     * filtro venha vazio: os dois lados degradando juntos não passam.
     */
    async function expectFiltersToMatchComputed(expectedTotal: number): Promise<TicketSummary[]> {
      const list = async (query: string) => {
        const res = await as(agent).get(`/api/tickets?pageSize=100${query}`).expect(200);
        return res.body as { items: TicketSummary[]; total: number };
      };
      const all = await list('');
      expect(all.total).toBe(expectedTotal);
      expect(all.items).toHaveLength(expectedTotal);

      const titlesWhere = (wanted: SlaState[]) =>
        all.items
          .filter((t) => states(t).some((s) => wanted.includes(s)))
          .map((t) => t.title)
          .sort();
      const filters: [string, SlaState[]][] = [
        ['&sla=AT_RISK', ['AT_RISK']],
        ['&sla=BREACHED', ['BREACHED']],
        ['&sla=AT_RISK&sla=BREACHED', ['AT_RISK', 'BREACHED']],
      ];
      for (const [query, wanted] of filters) {
        const filtered = await list(query);
        const expected = titlesWhere(wanted);
        expect(expected.length).toBeGreaterThan(0);
        expect(filtered.total).toBe(expected.length);
        expect(filtered.items.map((t) => t.title).sort()).toEqual(expected);
      }
      return all.items;
    }

    it('para AT_RISK, BREACHED e os dois juntos', { timeout: 30_000 }, async () => {
      const now = Date.now();
      // Relógio parado há 5 h: com o "agora", as posições dariam outro resultado.
      const pausedAt = now - 5 * HOUR;
      const data: Prisma.TicketCreateManyInput[] = [];
      for (const status of STATUSES) {
        const running = SLA_RUNNING_STATUSES.includes(status);
        const clockAt = running ? now : pausedAt;
        for (const fr of FIRST_RESPONSES) {
          for (const res of POSITIONS) {
            const first = around(clockAt, fr.startsWith('ANSWERED') ? 'EARLY' : (fr as Position));
            const resolution = around(clockAt, res);
            const answeredAt =
              fr === 'ANSWERED_ON_TIME'
                ? new Date(first.due.getTime() - MIN)
                : fr === 'ANSWERED_LATE'
                  ? new Date(first.due.getTime() + MIN)
                  : null;
            data.push({
              title: `${status} ${fr} ${res}`,
              description: 'matriz',
              requesterId: customer.id,
              status,
              createdAt: new Date(now - 30 * HOUR),
              firstResponseAt: answeredAt,
              firstResponseDueAt: first.due,
              firstResponseRiskAt: first.risk,
              resolutionDueAt: resolution.due,
              resolutionRiskAt: resolution.risk,
              slaPausedAt: running ? null : new Date(pausedAt),
              resolvedAt: status === 'RESOLVED' || status === 'CLOSED' ? new Date(pausedAt) : null,
            });
          }
        }
      }
      await prisma.ticket.createMany({ data });

      const all = await expectFiltersToMatchComputed(data.length);
      // A matriz passa por todos os estados.
      expect(new Set(all.flatMap(states))).toEqual(
        new Set(['OK', 'AT_RISK', 'BREACHED', 'MET', 'PAUSED', 'NOT_APPLICABLE']),
      );
    });

    // Os mesmos limites do cálculo, ao milissegundo: risco e prazo exatos, 1 ms
    // antes e depois, com o relógio correndo, parado e cumprido. Date fica fixo
    // (só Date: o driver do Postgres precisa dos timers de verdade).
    it('nos limites exatos de risco, prazo e pausa', { timeout: 30_000 }, async () => {
      const T = Math.floor(Date.now() / 1000) * 1000;
      const P = T - 5 * HOUR;
      const ms = (base: number, delta: number) => new Date(base + delta);
      const far = (base: number) => ({ risk: ms(base, 8 * HOUR), due: ms(base, 10 * HOUR) });

      // título → [status, campos, estados esperados [1ª resposta, resolução]]
      const cases: [
        string,
        TicketStatus,
        Partial<Prisma.TicketCreateManyInput>,
        [SlaState, SlaState],
      ][] = [
        ['res risco = agora', 'IN_PROGRESS', { resolutionRiskAt: ms(T, 0) }, ['OK', 'AT_RISK']],
        ['res risco = agora + 1ms', 'IN_PROGRESS', { resolutionRiskAt: ms(T, 1) }, ['OK', 'OK']],
        [
          'res prazo = agora',
          'IN_PROGRESS',
          { resolutionRiskAt: ms(T, -HOUR), resolutionDueAt: ms(T, 0) },
          ['OK', 'AT_RISK'],
        ],
        [
          'res prazo = agora - 1ms',
          'IN_PROGRESS',
          { resolutionRiskAt: ms(T, -HOUR), resolutionDueAt: ms(T, -1) },
          ['OK', 'BREACHED'],
        ],
        ['1ª risco = agora', 'OPEN', { firstResponseRiskAt: ms(T, 0) }, ['AT_RISK', 'OK']],
        ['1ª risco = agora + 1ms', 'OPEN', { firstResponseRiskAt: ms(T, 1) }, ['OK', 'OK']],
        [
          '1ª prazo = agora',
          'OPEN',
          { firstResponseRiskAt: ms(T, -HOUR), firstResponseDueAt: ms(T, 0) },
          ['AT_RISK', 'OK'],
        ],
        [
          '1ª prazo = agora - 1ms',
          'OPEN',
          { firstResponseRiskAt: ms(T, -HOUR), firstResponseDueAt: ms(T, -1) },
          ['BREACHED', 'OK'],
        ],
        [
          'pausa = prazo da res',
          'WAITING_CUSTOMER',
          { resolutionRiskAt: ms(P, -HOUR), resolutionDueAt: ms(P, 0) },
          ['PAUSED', 'PAUSED'],
        ],
        [
          'pausa = prazo da res + 1ms',
          'WAITING_CUSTOMER',
          { resolutionRiskAt: ms(P, -HOUR), resolutionDueAt: ms(P, -1) },
          ['PAUSED', 'BREACHED'],
        ],
        [
          'pausa = prazo da 1ª',
          'WAITING_CUSTOMER',
          { firstResponseRiskAt: ms(P, -HOUR), firstResponseDueAt: ms(P, 0) },
          ['PAUSED', 'PAUSED'],
        ],
        [
          'pausa = prazo da 1ª + 1ms',
          'WAITING_CUSTOMER',
          { firstResponseRiskAt: ms(P, -HOUR), firstResponseDueAt: ms(P, -1) },
          ['BREACHED', 'PAUSED'],
        ],
        [
          'resolvido no prazo exato',
          'RESOLVED',
          { resolutionRiskAt: ms(P, -HOUR), resolutionDueAt: ms(P, 0) },
          ['NOT_APPLICABLE', 'MET'],
        ],
        [
          'resolvido 1ms depois',
          'RESOLVED',
          { resolutionRiskAt: ms(P, -HOUR), resolutionDueAt: ms(P, -1) },
          ['NOT_APPLICABLE', 'BREACHED'],
        ],
        [
          'respondido no prazo exato',
          'IN_PROGRESS',
          {
            firstResponseDueAt: ms(T, -HOUR),
            firstResponseRiskAt: ms(T, -2 * HOUR),
            firstResponseAt: ms(T, -HOUR),
          },
          ['MET', 'OK'],
        ],
        [
          'respondido 1ms depois',
          'IN_PROGRESS',
          {
            firstResponseDueAt: ms(T, -HOUR),
            firstResponseRiskAt: ms(T, -2 * HOUR),
            firstResponseAt: ms(T, -HOUR + 1),
          },
          ['BREACHED', 'OK'],
        ],
      ];
      await prisma.ticket.createMany({
        data: cases.map(([title, status, fields]) => {
          const running = SLA_RUNNING_STATUSES.includes(status);
          const base = far(running ? T : P);
          return {
            title,
            description: 'limites',
            requesterId: customer.id,
            status,
            createdAt: ms(T, -30 * HOUR),
            firstResponseDueAt: base.due,
            firstResponseRiskAt: base.risk,
            resolutionDueAt: base.due,
            resolutionRiskAt: base.risk,
            slaPausedAt: running ? null : new Date(P),
            resolvedAt: status === 'RESOLVED' ? new Date(P) : null,
            ...fields,
          };
        }),
      });

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T);
      try {
        const all = await expectFiltersToMatchComputed(cases.length);
        const stateOf = new Map(
          all.map((t) => [t.title, [t.sla!.firstResponse.state, t.sla!.resolution.state]]),
        );
        for (const [title, , , expected] of cases)
          expect([title, stateOf.get(title)]).toEqual([title, expected]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('/api/sla-policies', () => {
    afterEach(async () => {
      for (const [priority, [firstResponseMinutes, resolutionMinutes]] of Object.entries(
        DEFAULT_POLICIES,
      )) {
        await prisma.slaPolicy.update({
          where: { priority: priority as Priority },
          data: { firstResponseMinutes, resolutionMinutes },
        });
      }
    });

    it('a equipe lista, da mais urgente para a menos; o cliente recebe 403', async () => {
      const res = await as(agent).get('/api/sla-policies').expect(200);
      expect(res.body.map((p: { priority: Priority }) => p.priority)).toEqual([
        'URGENT',
        'HIGH',
        'MEDIUM',
        'LOW',
      ]);
      expect(res.body[0]).toEqual({
        priority: 'URGENT',
        firstResponseMinutes: 60,
        resolutionMinutes: 240,
        updatedAt: expect.any(String),
      });
      await as(customer).get('/api/sla-policies').expect(403);
    });

    it('o admin edita; vale para tickets novos, não para os que já existem', async () => {
      const existing = await openTicket({ priority: 'HIGH' });
      const before = await stored(existing.id);

      await as(admin)
        .put('/api/sla-policies/HIGH')
        .send({ firstResponseMinutes: 30, resolutionMinutes: 90 })
        .expect(200);

      expect(await stored(existing.id)).toMatchObject({
        firstResponseDueAt: before.firstResponseDueAt,
        resolutionDueAt: before.resolutionDueAt,
      });
      const created = await stored((await openTicket({ priority: 'HIGH' })).id);
      expect(created.resolutionDueAt.getTime() - created.createdAt.getTime()).toBe(90 * MIN);
    });

    it('só o admin edita', async () => {
      await as(agent)
        .put('/api/sla-policies/HIGH')
        .send({ firstResponseMinutes: 30, resolutionMinutes: 90 })
        .expect(403);
      await as(customer)
        .put('/api/sla-policies/HIGH')
        .send({ firstResponseMinutes: 30, resolutionMinutes: 90 })
        .expect(403);
    });

    it.each([
      ['prioridade inexistente', 'CRITICAL', { firstResponseMinutes: 30, resolutionMinutes: 90 }],
      ['minutos zerados', 'HIGH', { firstResponseMinutes: 0, resolutionMinutes: 90 }],
      ['minutos fracionados', 'HIGH', { firstResponseMinutes: 1.5, resolutionMinutes: 90 }],
      ['acima de 30 dias', 'HIGH', { firstResponseMinutes: 30, resolutionMinutes: 43_201 }],
      [
        '1ª resposta maior que a resolução',
        'HIGH',
        { firstResponseMinutes: 90, resolutionMinutes: 30 },
      ],
      [
        '1ª resposta igual à resolução',
        'HIGH',
        { firstResponseMinutes: 90, resolutionMinutes: 90 },
      ],
      ['campo faltando', 'HIGH', { firstResponseMinutes: 30 }],
    ])('retorna 400 com %s', async (_case, priority, body) => {
      await as(admin).put(`/api/sla-policies/${priority}`).send(body).expect(400);
    });
  });
});
