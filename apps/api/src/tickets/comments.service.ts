import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { CommentDto } from '@support-flow/shared';
import type { RequestUser } from '../auth/auth.types.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateCommentDto } from './tickets.dto.js';
import { isStaff, TicketsService } from './tickets.service.js';

const commentInclude = {
  author: { select: { id: true, name: true, role: true } },
} satisfies Prisma.CommentInclude;

type CommentWithAuthor = Prisma.CommentGetPayload<{ include: typeof commentInclude }>;

/** Depende de TicketsService, nunca o contrário: as regras do ticket ficam lá. */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
  ) {}

  /** Notas internas ficam fora da consulta para o cliente, não só da tela. */
  async list(user: RequestUser, ticketId: string): Promise<CommentDto[]> {
    await this.tickets.findScoped(this.prisma, user, ticketId);
    const comments = await this.prisma.comment.findMany({
      where: { ticketId, ...(isStaff(user) ? {} : { isInternal: false }) },
      include: commentInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return comments.map(toCommentDto);
  }

  create(user: RequestUser, ticketId: string, dto: CreateCommentDto): Promise<CommentDto> {
    return this.prisma.$transaction(async (tx) => {
      const ticket = await this.tickets.findScoped(tx, user, ticketId);
      if (dto.isInternal && !isStaff(user)) {
        throw new ForbiddenException('Notas internas são só da equipe de suporte.');
      }
      if (ticket.status === 'CLOSED') {
        throw new ConflictException('Ticket fechado não aceita comentários.');
      }

      const now = new Date();
      const comment = await tx.comment.create({
        data: {
          ticketId,
          authorId: user.id,
          body: dto.body,
          isInternal: dto.isInternal,
          createdAt: now,
        },
        include: commentInclude,
      });
      await this.tickets.applyCommentEffects(tx, ticket, user, dto.isInternal, now);
      return toCommentDto(comment);
    });
  }
}

function toCommentDto(comment: CommentWithAuthor): CommentDto {
  return {
    id: comment.id,
    ticketId: comment.ticketId,
    author: comment.author,
    body: comment.body,
    isInternal: comment.isInternal,
    createdAt: comment.createdAt.toISOString(),
  };
}
