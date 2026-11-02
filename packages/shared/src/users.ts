import type { UserSummary } from './tickets.js';

/** Disponibilidade do agente: só quem está disponível recebe tickets novos. */
export interface Availability {
  isAvailable: boolean;
}

/** Agente na visão do admin, com a carga que a atribuição automática usa. */
export interface AgentSummary extends UserSummary {
  email: string;
  isAvailable: boolean;
  /** Tickets atribuídos a ele em OPEN, IN_PROGRESS ou WAITING_CUSTOMER. */
  openTickets: number;
}
