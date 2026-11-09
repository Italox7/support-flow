import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  type HttpException,
} from '@nestjs/common';
import type {
  Paginated,
  SlaClock,
  TicketDetail,
  TicketStatus,
  TicketSummary,
} from '@support-flow/shared';
import { AssignmentService } from '../assignment/assignment.service.js';
import type { RequestUser } from '../auth/auth.types.js';
import { Prisma, type Ticket } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  computeSla,
  firstResponsePatch,
  priorityChangePatch,
  slaTransitionPatch,
  type SlaClockResult,
} from '../sla/sla-calculator.js';
import { computeDeadlines } from '../sla/sla-deadlines.js';
import { slaWhere } from '../sla/sla-filters.js';
import {
  allowedTransitions,
  canTransition,
  commentEffects,
  transitionContext,
  transitionPatch,
  type TransitionRejection,
} from './ticket-state-machine.js';
import type { CreateTicketDto, ListTicketsQuery, UpdateTicketDto } from './tickets.dto.js';

const ticketInclude = {
  requester: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.TicketInclude;

type TicketWithPeople = Prisma.TicketGetPayload<{ include: typeof ticketInclude }>;
type Db = Prisma.TransactionClient;

/** Tickets fechados por execução do job. O que passar disso espera a próxima. */
const CLOSE_BATCH_SIZE = 200;

export const isStaff = (user: RequestUser) => user.role !== 'CUSTOMER';

/**
 * Escopo de dados por papel: o cliente só alcança os próprios tickets. Toda
 * leitura e escrita de ticket passa por aqui, nunca só pelo front.
 */
export function ticketScope(user: RequestUser): Prisma.TicketWhereInput {
  return isStaff(user) ? {} : { requesterId: user.id };
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignment: AssignmentService,
  ) {}

  async list(user: RequestUser, query: ListTicketsQuery): Promise<Paginated<TicketSummary>> {
    const { page, pageSize } = query;
    // O cliente não vê o SLA; filtrar por ele revelaria o estado do relógio.
    if (query.sla && !isStaff(user)) {
      throw new ForbiddenException('Só a equipe de suporte filtra por SLA.');
    }
    const now = new Date();
    const where: Prisma.TicketWhereInput = {
      AND: [
        ticketScope(user),
        {
          status: query.status && { in: query.status },
          priority: query.priority && { in: query.priority },
          assigneeId: assigneeFilter(query.assigneeId, user),
        },
        query.sla ? slaWhere(query.sla, now, this.prisma.ticket.fields) : {},
      ],
    };
    const [total, tickets] = await this.prisma.$transaction([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.findMany({
        where,
        include: ticketInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: tickets.map((ticket) => toTicketSummary(ticket, user, now)),
      page,
      pageSize,
      total,
    };
  }

  /**
   * O ticket nasce atribuído ao agente disponível com menor carga, ou sem
   * responsável se não houver nenhum (vira órfão até alguém ficar disponível).
   */
  create(user: RequestUser, dto: CreateTicketDto): Promise<TicketDetail> {
    const priority = dto.priority ?? 'MEDIUM';
    return this.assignment.inLock(async (tx) => {
      // Lido depois do lock: quem esperou na fila não grava um lastAssignedAt
      // mais antigo que o de quem passou antes.
      const createdAt = new Date();
      const assigneeId = await this.assignment.assignNew(tx, createdAt);
      const policy = await tx.slaPolicy.findUniqueOrThrow({ where: { priority } });
      const ticket = await tx.ticket.create({
        data: {
          title: dto.title,
          description: dto.description,
          priority,
          requesterId: user.id,
          assigneeId,
          createdAt,
          ...computeDeadlines(createdAt, policy),
        },
        include: ticketInclude,
      });
      return toTicketDetail(ticket, user, createdAt);
    });
  }

  async findOne(user: RequestUser, id: string): Promise<TicketDetail> {
    return toTicketDetail(await this.findScoped(this.prisma, user, id), user);
  }

  /**
   * Ticket visível para o usuário, ou 404. Ticket de outro cliente também é 404:
   * o número é sequencial, e um 403 confirmaria que ele existe.
   */
  async findScoped(db: Db, user: RequestUser, id: string): Promise<TicketWithPeople> {
    const ticket = await db.ticket.findFirst({
      where: { id, ...ticketScope(user) },
      include: ticketInclude,
    });
    if (!ticket) throw new NotFoundException('Ticket não encontrado.');
    return ticket;
  }

  /**
   * Trocar a prioridade recalcula os prazos a partir da abertura; trocar o
   * responsável é só do admin e não mexe no status. Os dois campos valem juntos
   * ou nada vale. Erros: 400 → 404 → 403 → 409 → 422.
   */
  async update(user: RequestUser, id: string, dto: UpdateTicketDto): Promise<TicketDetail> {
    if (dto.priority === undefined && dto.assigneeId === undefined) {
      throw new BadRequestException('Informe priority ou assigneeId.');
    }
    // 404 e 403 antes da fila do lock: quem não pode alterar o ticket não ocupa
    // a fila de criação. O escopo vem antes do papel, como em toda rota.
    await this.findScoped(this.prisma, user, id);
    if (!isStaff(user)) throw new ForbiddenException('Só a equipe de suporte altera o ticket.');
    if (dto.assigneeId !== undefined && user.role !== 'ADMIN') {
      throw new ForbiddenException('Só o admin troca o responsável.');
    }

    // A troca de responsável muda a carga; a escrita roda sob o lock da atribuição.
    return this.assignment.inLock(async (tx) => {
      const ticket = await this.findScoped(tx, user, id);
      if (ticket.status === 'CLOSED') throw new ConflictException('Ticket fechado.');

      const data: Prisma.TicketUncheckedUpdateManyInput = {};
      const where: Prisma.TicketWhereInput = { id, status: ticket.status };
      if (dto.priority !== undefined) {
        // O veredito de um ticket resolvido não muda depois: só reabrindo.
        if (ticket.status === 'RESOLVED') {
          throw new ConflictException('Ticket resolvido não muda de prioridade.');
        }
        const policy = await tx.slaPolicy.findUniqueOrThrow({ where: { priority: dto.priority } });
        const sla = priorityChangePatch(ticket, policy);
        Object.assign(data, { priority: dto.priority, ...sla.data });
        Object.assign(where, sla.guard);
      }
      if (dto.assigneeId !== undefined) {
        // Pode ser um agente indisponível: é uma escolha explícita do admin.
        if (!(await this.assignment.isAgent(tx, dto.assigneeId))) {
          throw new UnprocessableEntityException('O responsável precisa ser um agente.');
        }
        data.assigneeId = dto.assigneeId;
      }

      // Transições e comentários não pegam o lock: o update só vale se o status,
      // a pausa do SLA e (ao recalcular a 1ª resposta) a falta dela ainda forem
      // os lidos, senão os prazos recalculados apagariam uma pausa, uma retomada
      // ou o congelamento da 1ª resposta gravados no meio tempo.
      const { count } = await tx.ticket.updateMany({
        where: { ...where, pausedSeconds: ticket.pausedSeconds },
        data,
      });
      if (count === 0) {
        throw new ConflictException('O ticket mudou enquanto isso. Recarregue e tente de novo.');
      }
      return toTicketDetail(
        await tx.ticket.findUniqueOrThrow({ where: { id }, include: ticketInclude }),
        user,
      );
    });
  }

  transition(user: RequestUser, id: string, to: TicketStatus): Promise<TicketDetail> {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await this.findScoped(tx, user, id);
      const now = new Date();
      const check = canTransition(
        ticket.status,
        to,
        user.role,
        transitionContext(ticket, user, now),
      );
      if (!check.ok) throw rejection(check.reason);

      if (!(await this.applyTransition(tx, ticket, to, now))) {
        throw new ConflictException('O ticket mudou enquanto isso. Recarregue e tente de novo.');
      }
      return toTicketDetail(
        await tx.ticket.findUniqueOrThrow({ where: { id }, include: ticketInclude }),
        user,
      );
    });
  }

  /**
   * Único ponto que muda o status, e com ele a pausa e a retomada do SLA. O
   * update só vale se o status ainda for o que foi lido (de duas mudanças
   * simultâneas, uma passa e a outra recebe `false`) e, na retomada, se os
   * prazos também forem: eles são regravados como valores absolutos. `guard`
   * acrescenta outros campos lidos de que a decisão dependeu.
   */
  async applyTransition(
    tx: Db,
    ticket: Ticket,
    to: TicketStatus,
    now: Date,
    guard: Prisma.TicketWhereInput = {},
  ): Promise<boolean> {
    const sla = slaTransitionPatch(ticket.status, to, ticket, now);
    const { count } = await tx.ticket.updateMany({
      where: { ...guard, id: ticket.id, status: ticket.status, ...sla.guard },
      data: { status: to, ...transitionPatch(ticket.status, to, now), ...sla.data },
    });
    return count === 1;
  }

  /**
   * Fecha os tickets resolvidos antes de `cutoff` e retorna quantos fechou. Fora
   * do lock da atribuição: como toda transição, vale pelo update condicional, e
   * um ticket que mudou de status no meio tempo faz `applyTransition` devolver `false`.
   * O `resolvedAt` lido entra na guarda: um ticket reaberto e resolvido de novo
   * entre a leitura e o update volta a RESOLVED com outra data, e fechá-lo
   * pularia a janela de reabertura da resolução nova.
   */
  async closeResolvedBefore(cutoff: Date, now: Date): Promise<number> {
    const tickets = await this.prisma.ticket.findMany({
      where: { status: 'RESOLVED', resolvedAt: { lt: cutoff } },
      orderBy: [{ resolvedAt: 'asc' }, { id: 'asc' }],
      take: CLOSE_BATCH_SIZE,
    });
    let closed = 0;
    for (const ticket of tickets) {
      const ctx = { isRequester: false, isAssignee: false, resolvedAt: ticket.resolvedAt, now };
      if (!canTransition(ticket.status, 'CLOSED', 'SYSTEM', ctx).ok) continue;
      const guard = { resolvedAt: ticket.resolvedAt };
      if (await this.applyTransition(this.prisma, ticket, 'CLOSED', now, guard)) closed += 1;
    }
    return closed;
  }

  /** Chamado na mesma transação que grava o comentário. */
  async applyCommentEffects(
    tx: Db,
    ticket: Ticket,
    author: RequestUser,
    isInternal: boolean,
    now: Date,
  ): Promise<void> {
    const effects = commentEffects(ticket, author, isInternal);
    if (effects.setFirstResponseAt) {
      await retryOnce(
        tx,
        ticket,
        'firstResponse',
        async (current) => {
          const { data, guard } = firstResponsePatch(current, now);
          const { count } = await tx.ticket.updateMany({
            where: { id: ticket.id, ...guard },
            data,
          });
          return count === 1;
        },
        (current) => current.firstResponseAt === null,
      );
    }
    // Se outra requisição já mudou o status, o efeito é descartado e o comentário fica.
    const { statusTo } = effects;
    if (statusTo) {
      await retryOnce(
        tx,
        ticket,
        `status → ${statusTo}`,
        (current) => this.applyTransition(tx, current, statusTo, now),
        (current) => current.status === ticket.status,
      );
    }
  }
}

/**
 * Efeito de comentário que perdeu a corrida para outra escrita (um PATCH mudou
 * os prazos, o ticket pausou no meio): relê e tenta de novo uma vez, se o efeito
 * ainda fizer sentido. Em READ COMMITTED, a releitura vê o que foi commitado.
 */
async function retryOnce(
  tx: Db,
  ticket: Ticket,
  effect: string,
  attempt: (current: Ticket) => Promise<boolean>,
  stillApplies: (current: Ticket) => boolean,
): Promise<void> {
  if (await attempt(ticket)) return;
  const current = await tx.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
  if (!stillApplies(current)) return;
  // Perder duas vezes seguidas é raro e o comentário fica; o efeito, não. Sem o
  // log, uma 1ª resposta perdida assim só apareceria como BREACHED.
  if (!(await attempt(current))) {
    logger.warn(
      `Efeito de comentário descartado após nova tentativa: ${effect}, ticket ${ticket.id}`,
    );
  }
}

const logger = new Logger(TicketsService.name);

function assigneeFilter(filter: string | undefined, user: RequestUser): string | null | undefined {
  if (filter === 'me') return user.id;
  if (filter === 'none') return null;
  return filter;
}

function rejection(reason: TransitionRejection): HttpException {
  switch (reason) {
    case 'NOT_ALLOWED':
      return new ForbiddenException('Você não pode fazer essa mudança de status.');
    case 'REOPEN_WINDOW_EXPIRED':
      return new ConflictException('O prazo de 7 dias para reabrir este ticket terminou.');
    case 'INVALID_TRANSITION':
      return new ConflictException(
        'Essa mudança de status não é possível a partir do status atual.',
      );
  }
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** O SLA só vai para a equipe: para o cliente, a chave nem existe. */
function toTicketSummary(
  ticket: TicketWithPeople,
  user: RequestUser,
  now = new Date(),
): TicketSummary {
  const summary: TicketSummary = {
    id: ticket.id,
    number: ticket.number,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    requester: ticket.requester,
    assignee: ticket.assignee,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
  if (isStaff(user)) {
    const sla = computeSla(ticket, now);
    summary.sla = {
      firstResponse: toSlaClock(sla.firstResponse),
      resolution: toSlaClock(sla.resolution),
    };
  }
  return summary;
}

function toSlaClock(clock: SlaClockResult): SlaClock {
  return { ...clock, dueAt: clock.dueAt.toISOString() };
}

function toTicketDetail(
  ticket: TicketWithPeople,
  user: RequestUser,
  now = new Date(),
): TicketDetail {
  return {
    ...toTicketSummary(ticket, user, now),
    description: ticket.description,
    firstResponseAt: iso(ticket.firstResponseAt),
    resolvedAt: iso(ticket.resolvedAt),
    closedAt: iso(ticket.closedAt),
    allowedTransitions: allowedTransitions(
      ticket.status,
      user.role,
      transitionContext(ticket, user, now),
    ),
  };
}
