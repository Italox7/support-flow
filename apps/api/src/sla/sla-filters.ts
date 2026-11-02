import type { Prisma } from '../generated/prisma/client.js';
import { SLA_RUNNING_STATUSES, SLA_STOPPED_STATUSES } from './sla-calculator.js';

/** Estados que a fila filtra: um ticket entra se qualquer um dos dois relógios estiver nele. */
export const SLA_FILTERS = ['AT_RISK', 'BREACHED'] as const;
export type SlaFilter = (typeof SLA_FILTERS)[number];

// Espelho em SQL do computeSla: qualquer mudança lá muda aqui, e o E2E
// sla.e2e-spec.ts compara os dois ticket a ticket. `now` vem da aplicação, como
// no cálculo, não do relógio do banco.

const running = { status: { in: SLA_RUNNING_STATUSES } } satisfies Prisma.TicketWhereInput;
const stopped = { status: { in: SLA_STOPPED_STATUSES } } satisfies Prisma.TicketWhereInput;

export function slaWhere(
  filters: readonly SlaFilter[],
  now: Date,
  fields: Prisma.TicketFieldRefs,
): Prisma.TicketWhereInput {
  return { OR: filters.flatMap((filter) => CLAUSES[filter](now, fields)) };
}

const CLAUSES: Record<
  SlaFilter,
  (now: Date, fields: Prisma.TicketFieldRefs) => Prisma.TicketWhereInput[]
> = {
  AT_RISK: (now) => [
    {
      ...running,
      firstResponseAt: null,
      firstResponseRiskAt: { lte: now },
      firstResponseDueAt: { gte: now },
    },
    { ...running, resolutionRiskAt: { lte: now }, resolutionDueAt: { gte: now } },
  ],
  // Relógio parado vale onde parou (`slaPausedAt`); resposta dada, onde foi dada.
  BREACHED: (now, fields) => [
    { firstResponseAt: { gt: fields.firstResponseDueAt } },
    { ...running, firstResponseAt: null, firstResponseDueAt: { lt: now } },
    { ...stopped, firstResponseAt: null, slaPausedAt: { gt: fields.firstResponseDueAt } },
    { ...running, resolutionDueAt: { lt: now } },
    { ...stopped, slaPausedAt: { gt: fields.resolutionDueAt } },
  ],
};
