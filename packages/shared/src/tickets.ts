import type { Priority, Role, TicketStatus } from './enums.js';

// Respostas da API de tickets. Datas chegam como string ISO 8601 (é o que o
// JSON carrega); quem precisar de Date converte no cliente.

export interface UserSummary {
  id: string;
  name: string;
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
}

export interface TicketDetail extends TicketSummary {
  description: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
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
