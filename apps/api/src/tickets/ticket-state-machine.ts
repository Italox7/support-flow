import type { Role, TicketStatus } from '@support-flow/shared';

// Regras do ciclo de vida do ticket, sem banco: quem aplica é o TicketsService,
// sempre por um update condicional ao status lido.

/** SYSTEM é o job agendado (fechamento automático) e os efeitos de comentário. */
export type Actor = Role | 'SYSTEM';

export interface TransitionContext {
  isRequester: boolean;
  isAssignee: boolean;
  resolvedAt: Date | null;
  now: Date;
}

export type TransitionRejection = 'INVALID_TRANSITION' | 'NOT_ALLOWED' | 'REOPEN_WINDOW_EXPIRED';
export type TransitionCheck = { ok: true } | { ok: false; reason: TransitionRejection };

/** O cliente reabre um ticket resolvido em até 7 dias. */
export const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type Rule = (actor: Actor, ctx: TransitionContext) => boolean;

const isStaff = (actor: Actor) => actor === 'AGENT' || actor === 'ADMIN';
const isOwner = (actor: Actor, ctx: TransitionContext) => actor === 'CUSTOMER' && ctx.isRequester;
const staffOrOwner: Rule = (actor, ctx) => isStaff(actor) || isOwner(actor, ctx);

/** Quem pode fazer cada transição. O que não está aqui não existe (409). */
const RULES: Partial<Record<TicketStatus, Partial<Record<TicketStatus, Rule>>>> = {
  OPEN: {
    // Assumir o ticket é do agente atribuído; o admin pode por qualquer um.
    IN_PROGRESS: (actor, ctx) =>
      actor === 'ADMIN' || actor === 'SYSTEM' || (actor === 'AGENT' && ctx.isAssignee),
  },
  IN_PROGRESS: {
    WAITING_CUSTOMER: isStaff,
    RESOLVED: staffOrOwner,
  },
  WAITING_CUSTOMER: {
    IN_PROGRESS: (actor) => isStaff(actor) || actor === 'SYSTEM',
    RESOLVED: staffOrOwner,
  },
  RESOLVED: {
    IN_PROGRESS: isOwner,
    CLOSED: (actor) => actor === 'SYSTEM',
  },
};

export function canTransition(
  from: TicketStatus,
  to: TicketStatus,
  actor: Actor,
  ctx: TransitionContext,
): TransitionCheck {
  const rule = RULES[from]?.[to];
  if (!rule) return { ok: false, reason: 'INVALID_TRANSITION' };
  if (!rule(actor, ctx)) return { ok: false, reason: 'NOT_ALLOWED' };
  if (from === 'RESOLVED' && to === 'IN_PROGRESS' && isReopenWindowExpired(ctx)) {
    return { ok: false, reason: 'REOPEN_WINDOW_EXPIRED' };
  }
  return { ok: true };
}

function isReopenWindowExpired({ resolvedAt, now }: TransitionContext): boolean {
  return !resolvedAt || now.getTime() - resolvedAt.getTime() > REOPEN_WINDOW_MS;
}

/** Campos gravados junto com a mudança de status. A Fase 5 acrescenta a pausa do SLA. */
export function transitionPatch(
  from: TicketStatus,
  to: TicketStatus,
  now: Date,
): { resolvedAt?: Date | null; closedAt?: Date } {
  if (to === 'RESOLVED') return { resolvedAt: now };
  if (to === 'CLOSED') return { closedAt: now };
  if (from === 'RESOLVED') return { resolvedAt: null };
  return {};
}

export interface CommentEffects {
  /** 1ª resposta do SLA: primeiro comentário público de um agente ou admin. */
  setFirstResponseAt: boolean;
  statusTo?: TicketStatus;
}

/**
 * O que um comentário novo muda no ticket. Nota interna não muda nada; o
 * comentário do cliente em RESOLVED também não (reabrir é explícito).
 */
export function commentEffects(
  ticket: { status: TicketStatus; assigneeId: string | null; firstResponseAt: Date | null },
  author: { id: string; role: Role },
  isInternal: boolean,
): CommentEffects {
  if (isInternal) return { setFirstResponseAt: false };

  if (author.role === 'CUSTOMER') {
    return ticket.status === 'WAITING_CUSTOMER'
      ? { setFirstResponseAt: false, statusTo: 'IN_PROGRESS' }
      : { setFirstResponseAt: false };
  }

  const effects: CommentEffects = { setFirstResponseAt: ticket.firstResponseAt === null };
  // Responder é uma forma de assumir: o agente atribuído tira o ticket de OPEN.
  if (ticket.status === 'OPEN' && ticket.assigneeId === author.id) effects.statusTo = 'IN_PROGRESS';
  return effects;
}
