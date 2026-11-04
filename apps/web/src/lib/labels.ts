import type { Priority, Role, SlaState, TicketStatus } from '@support-flow/shared';

// Único lugar com os rótulos em português: filtros, badges e texto acessível leem daqui.

const STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: 'Aberto',
  IN_PROGRESS: 'Em andamento',
  WAITING_CUSTOMER: 'Aguardando cliente',
  RESOLVED: 'Resolvido',
  CLOSED: 'Fechado',
};

/** Para o cliente, sem SLA na tela, esse rótulo é o sinal de que a vez é dele. */
export function statusLabel(status: TicketStatus, role: Role): string {
  if (status === 'WAITING_CUSTOMER' && role === 'CUSTOMER') return 'Aguardando você';
  return STATUS_LABELS[status];
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: 'Baixa',
  MEDIUM: 'Média',
  HIGH: 'Alta',
  URGENT: 'Urgente',
};

export const SLA_LABELS: Record<SlaState, string> = {
  OK: 'No prazo',
  AT_RISK: 'Em risco',
  BREACHED: 'Violado',
  MET: 'Cumprido',
  PAUSED: 'Pausado',
  NOT_APPLICABLE: 'Não se aplica',
};

export function transitionLabel(from: TicketStatus, to: TicketStatus): string {
  switch (to) {
    case 'IN_PROGRESS':
      if (from === 'RESOLVED') return 'Reabrir ticket';
      return from === 'OPEN' ? 'Iniciar atendimento' : 'Retomar atendimento';
    case 'WAITING_CUSTOMER':
      return 'Aguardar cliente';
    case 'RESOLVED':
      return 'Marcar como resolvido';
    case 'CLOSED':
      return 'Fechar ticket';
    case 'OPEN':
      return 'Voltar para aberto';
  }
}
