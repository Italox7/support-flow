// Espelham os enums do schema Prisma (apps/api/prisma/schema.prisma).
// Objetos `as const` em vez de `enum` do TS: funcionam igual no Node e no Vite
// e os valores são as mesmas strings que o Postgres guarda.

export const Role = {
  CUSTOMER: 'CUSTOMER',
  AGENT: 'AGENT',
  ADMIN: 'ADMIN',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const TicketStatus = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  WAITING_CUSTOMER: 'WAITING_CUSTOMER',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const Priority = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  URGENT: 'URGENT',
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

/** Estado de um relógio de SLA (1ª resposta ou resolução) calculado na leitura. */
export const SlaState = {
  OK: 'OK',
  AT_RISK: 'AT_RISK',
  BREACHED: 'BREACHED',
  MET: 'MET',
  PAUSED: 'PAUSED',
} as const;
export type SlaState = (typeof SlaState)[keyof typeof SlaState];
