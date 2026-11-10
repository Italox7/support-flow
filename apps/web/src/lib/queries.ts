import type { AuthUser } from '@support-flow/shared';

/** O id do usuário na chave é a segunda proteção, além de limpar o cache ao trocar de sessão. */
export const keys = {
  tickets: (user: AuthUser, params: string) => ['u', user.id, 'tickets', params] as const,
  ticket: (user: AuthUser, id: string) => ['u', user.id, 'ticket', id] as const,
  comments: (user: AuthUser, id: string) => ['u', user.id, 'comments', id] as const,
  /** Mutações que gravam o ticket inteiro no cache: uma pendente trava as outras. */
  ticketWrite: (user: AuthUser, id: string) => ['u', user.id, 'ticket-write', id] as const,
  availability: (user: AuthUser) => ['u', user.id, 'availability'] as const,
  agents: (user: AuthUser) => ['u', user.id, 'agents'] as const,
  slaPolicies: (user: AuthUser) => ['u', user.id, 'sla-policies'] as const,
};

export const REFETCH_MS = 60_000;
