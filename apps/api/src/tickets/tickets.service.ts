import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  type HttpException,
} from '@nestjs/common';
import type { Paginated, TicketDetail, TicketStatus, TicketSummary } from '@support-flow/shared';
import { AssignmentService } from '../assignment/assignment.service.js';
import type { RequestUser } from '../auth/auth.types.js';
import { Prisma, type Ticket } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeDeadlines } from '../sla/sla-deadlines.js';
import {
  canTransition,
  commentEffects,
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
    const where: Prisma.TicketWhereInput = {
      AND: [
        ticketScope(user),
        {
          status: query.status && { in: query.status },
          priority: query.priority && { in: query.priority },
          assigneeId: assigneeFilter(query.assigneeId, user),
        },
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
    return { items: tickets.map(toTicketSummary), page, pageSize, total };
  }

  /**
   * O ticket nasce atribuído ao agente disponível com menor carga, ou sem
   * responsável se não houver nenhum (vira órfão até alguém ficar disponível).
   */
  create(user: RequestUser, dto: CreateTicketDto): Promise<TicketDetail> {
    const priority = dto.priority ?? 'MEDIUM';
    const createdAt = new Date();
    return this.assignment.inLock(async (tx) => {
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
      return toTicketDetail(ticket);
    });
  }

  async findOne(user: RequestUser, id: string): Promise<TicketDetail> {
    return toTicketDetail(await this.findScoped(this.prisma, user, id));
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
  update(user: RequestUser, id: string, dto: UpdateTicketDto): Promise<TicketDetail> {
    if (dto.priority === undefined && dto.assigneeId === undefined) {
      throw new BadRequestException('Informe priority ou assigneeId.');
    }
    // A troca de responsável muda a carga; a rota inteira roda sob o lock da atribuição.
    return this.assignment.inLock(async (tx) => {
      const ticket = await this.findScoped(tx, user, id);
      if (!isStaff(user)) throw new ForbiddenException('Só a equipe de suporte altera o ticket.');
      if (dto.assigneeId !== undefined && user.role !== 'ADMIN') {
        throw new ForbiddenException('Só o admin troca o responsável.');
      }
      if (ticket.status === 'CLOSED') throw new ConflictException('Ticket fechado.');

      const data: Prisma.TicketUncheckedUpdateManyInput = {};
      if (dto.priority !== undefined) {
        const policy = await tx.slaPolicy.findUniqueOrThrow({ where: { priority: dto.priority } });
        data.priority = dto.priority;
        Object.assign(data, computeDeadlines(ticket.createdAt, policy, ticket.pausedSeconds));
      }
      if (dto.assigneeId !== undefined) {
        // Pode ser um agente indisponível: é uma escolha explícita do admin.
        if (!(await this.assignment.isAgent(tx, dto.assigneeId))) {
          throw new UnprocessableEntityException('O responsável precisa ser um agente.');
        }
        data.assigneeId = dto.assigneeId;
      }

      // O fechamento (job) não pega o lock: o update só vale se o ticket seguir aberto.
      const { count } = await tx.ticket.updateMany({
        where: { id, status: { not: 'CLOSED' } },
        data,
      });
      if (count === 0) throw new ConflictException('Ticket fechado.');
      return toTicketDetail(
        await tx.ticket.findUniqueOrThrow({ where: { id }, include: ticketInclude }),
      );
    });
  }

  transition(user: RequestUser, id: string, to: TicketStatus): Promise<TicketDetail> {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await this.findScoped(tx, user, id);
      const now = new Date();
      const check = canTransition(ticket.status, to, user.role, {
        isRequester: ticket.requesterId === user.id,
        isAssignee: ticket.assigneeId === user.id,
        resolvedAt: ticket.resolvedAt,
        now,
      });
      if (!check.ok) throw rejection(check.reason);

      if (!(await this.applyTransition(tx, ticket, to, now))) {
        throw new ConflictException('O ticket mudou enquanto isso. Recarregue e tente de novo.');
      }
      return toTicketDetail(
        await tx.ticket.findUniqueOrThrow({ where: { id }, include: ticketInclude }),
      );
    });
  }

  /**
   * Único ponto que muda o status. O update só vale se o status ainda for o que
   * foi lido: de duas mudanças simultâneas, uma passa e a outra recebe `false`.
   * A pausa e a retomada do SLA (Fase 5) entram aqui.
   */
  async applyTransition(
    tx: Db,
    ticket: Pick<Ticket, 'id' | 'status'>,
    to: TicketStatus,
    now: Date,
  ): Promise<boolean> {
    const { count } = await tx.ticket.updateMany({
      where: { id: ticket.id, status: ticket.status },
      data: { status: to, ...transitionPatch(ticket.status, to, now) },
    });
    return count === 1;
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
      await tx.ticket.updateMany({
        where: { id: ticket.id, firstResponseAt: null },
        data: { firstResponseAt: now },
      });
    }
    // Se outra requisição já mudou o status, o efeito é descartado e o comentário fica.
    if (effects.statusTo) await this.applyTransition(tx, ticket, effects.statusTo, now);
  }
}

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

function toTicketSummary(ticket: TicketWithPeople): TicketSummary {
  return {
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
}

function toTicketDetail(ticket: TicketWithPeople): TicketDetail {
  return {
    ...toTicketSummary(ticket),
    description: ticket.description,
    firstResponseAt: iso(ticket.firstResponseAt),
    resolvedAt: iso(ticket.resolvedAt),
    closedAt: iso(ticket.closedAt),
  };
}
