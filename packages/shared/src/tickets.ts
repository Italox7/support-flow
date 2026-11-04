import type { Priority, Role, SlaState, TicketStatus } from './enums.js';

// Respostas da API de tickets. Datas chegam como string ISO 8601 (é o que o
// JSON carrega); quem precisar de Date converte no cliente.

export interface UserSummary {
  id: string;
  name: string;
}

/** Um relógio de SLA (1ª resposta ou resolução), calculado no instante da resposta. */
export interface SlaClock {
  state: SlaState;
  /** Com o relógio pausado, ainda muda: a retomada empurra o prazo pelo tempo parado. */
  dueAt: string;
  /**
   * Segundos do instante de referência até o prazo: agora (relógio correndo), a
   * pausa (pausado) ou o cumprimento. Negativo quando estourou.
   */
  remainingSeconds: number;
}

export interface TicketSla {
  firstResponse: SlaClock;
  resolution: SlaClock;
}

export interface TicketSummary {
  id: string;
  /** Número legível exibido como #123. */
  number: number;
  title: string;
  status: TicketStatus;
  priority: Priority;
  requester: UserSummary;
  assignee: UserSummary | null;
  createdAt: string;
  updatedAt: string;
  /** Presente só para AGENT/ADMIN: o SLA é compromisso interno da equipe. */
  sla?: TicketSla;
}

export interface TicketDetail extends TicketSummary {
  description: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /**
   * Transições que este usuário pode fazer agora, calculadas pela API. Pode estar
   * defasada: a rota ainda recusa com 403 ou 409, e aí o front recarrega o ticket.
   */
  allowedTransitions: TicketStatus[];
}

/** Para o cliente, a API nunca devolve comentários com `isInternal: true`. */
export interface CommentDto {
  id: string;
  ticketId: string;
  author: UserSummary & { role: Role };
  body: string;
  isInternal: boolean;
  createdAt: string;
}

/** Paginação por offset: `page` começa em 1. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** Prazos em minutos corridos. Editar vale para tickets novos e para trocas de prioridade. */
export interface SlaPolicyDto {
  priority: Priority;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  updatedAt: string;
}
