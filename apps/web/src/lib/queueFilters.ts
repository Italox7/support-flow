import { Priority, TicketStatus } from '@support-flow/shared';

/** O que a URL da fila aceita. Valor fora da lista é ignorado, sem virar 400 na tela. */
export const QUEUE_FILTERS = {
  status: Object.values(TicketStatus) as string[],
  priority: Object.values(Priority) as string[],
  sla: ['AT_RISK', 'BREACHED'],
  assigneeId: ['me', 'none'],
};

export type QueueFilter = keyof typeof QUEUE_FILTERS;
const NAMES = Object.keys(QUEUE_FILTERS) as QueueFilter[];

export interface QueueQuery {
  filters: Partial<Record<QueueFilter, string>>;
  page: number;
}

const MAX_PAGE = 10_000;

export function readPage(params: URLSearchParams): number {
  const raw = params.get('page') ?? '';
  if (!/^\d+$/.test(raw)) return 1;
  const page = Number(raw);
  return page >= 1 && page <= MAX_PAGE ? page : 1;
}

export function readQueueQuery(params: URLSearchParams): QueueQuery {
  const filters: QueueQuery['filters'] = {};
  for (const name of NAMES) {
    const value = params.get(name);
    if (value && QUEUE_FILTERS[name].includes(value)) filters[name] = value;
  }
  return { filters, page: readPage(params) };
}

/** Parâmetros da chamada à API, já sem nada que não tenha passado pela lista. */
export function toApiParams({ filters, page }: QueueQuery): string {
  const params = new URLSearchParams(filters);
  params.set('page', String(page));
  return params.toString();
}
