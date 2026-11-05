import type { Priority, TicketStatus } from '@support-flow/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { computeDeadlines, type SlaPolicyMinutes } from '../sla/sla-deadlines.js';

// Dados fictícios da demo pública. Os IDs são fixos para um access token emitido
// antes da restauração continuar apontando para uma conta que existe.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEMO_ADMIN_ID = '00000000-0000-4000-8000-00000000a001';
export const DEMO_AGENT_ID = '00000000-0000-4000-8000-00000000a002';
export const DEMO_CUSTOMER_ID = '00000000-0000-4000-8000-00000000a003';

export const DEMO_ACCOUNTS = [
  { id: DEMO_ADMIN_ID, email: 'admin@demo.example.com', name: 'Admin Demo', role: 'ADMIN' },
  { id: DEMO_AGENT_ID, email: 'agente@demo.example.com', name: 'Agente Demo', role: 'AGENT' },
  {
    id: DEMO_CUSTOMER_ID,
    email: 'cliente@demo.example.com',
    name: 'Cliente Demo',
    role: 'CUSTOMER',
  },
] as const;

/** Espelha a migration `default_sla_policies`; um teste compara os dois. */
export const DEFAULT_SLA_POLICIES = {
  URGENT: { firstResponseMinutes: 60, resolutionMinutes: 240 },
  HIGH: { firstResponseMinutes: 240, resolutionMinutes: 1440 },
  MEDIUM: { firstResponseMinutes: 480, resolutionMinutes: 2880 },
  LOW: { firstResponseMinutes: 1440, resolutionMinutes: 7200 },
} as const satisfies Record<Priority, SlaPolicyMinutes>;

const IDS = {
  open: '00000000-0000-4000-8000-00000000b001',
  inProgress: '00000000-0000-4000-8000-00000000b002',
  waiting: '00000000-0000-4000-8000-00000000b003',
  resolved: '00000000-0000-4000-8000-00000000b004',
  resolvedExpired: '00000000-0000-4000-8000-00000000b005',
  closed: '00000000-0000-4000-8000-00000000b006',
  orphan: '00000000-0000-4000-8000-00000000b007',
} as const;

interface DemoTicket {
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
  assigned: boolean;
  /** Há quanto tempo foi aberto. */
  age: number;
  /** Há quanto tempo foi resolvido e pausou o relógio, ou entrou em espera. */
  pausedAgo?: number;
  closedAgo?: number;
}

// Prioridade LOW e 1ª resposta já dada: nenhum relógio muda de estado antes da
// restauração seguinte, 24 h depois, então a demo não envelhece ao longo do dia.
const DEMO_TICKETS: DemoTicket[] = [
  {
    id: IDS.open,
    title: 'Não recebo o e-mail de confirmação',
    description: 'Fiz o pedido e o e-mail de confirmação não chegou. Conferi o spam.',
    status: 'OPEN',
    assigned: true,
    age: 2 * HOUR_MS,
  },
  {
    id: IDS.inProgress,
    title: 'Erro ao gerar o relatório mensal',
    description: 'O relatório de outubro para em 90% e mostra uma tela de erro.',
    status: 'IN_PROGRESS',
    assigned: true,
    age: 3 * HOUR_MS,
  },
  {
    id: IDS.waiting,
    title: 'Dúvida sobre o limite de usuários',
    description: 'Quantos usuários posso cadastrar no plano atual?',
    status: 'WAITING_CUSTOMER',
    assigned: true,
    age: 4 * HOUR_MS,
    pausedAgo: HOUR_MS,
  },
  {
    id: IDS.resolved,
    title: 'Fatura com valor duplicado',
    description: 'A fatura deste mês veio com a mesma cobrança duas vezes.',
    status: 'RESOLVED',
    assigned: true,
    age: 2 * DAY_MS,
    pausedAgo: DAY_MS,
  },
  // Resolvido há mais de 7 dias: a própria execução do job o fecha, logo depois.
  {
    id: IDS.resolvedExpired,
    title: 'Troca do e-mail da conta',
    description: 'Preciso trocar o e-mail de acesso da minha conta.',
    status: 'RESOLVED',
    assigned: true,
    age: 9 * DAY_MS,
    pausedAgo: 8 * DAY_MS,
  },
  {
    id: IDS.closed,
    title: 'Página de login fora do ar',
    description: 'A página de login mostrou erro por alguns minutos hoje de manhã.',
    status: 'CLOSED',
    assigned: true,
    age: 20 * DAY_MS,
    pausedAgo: 19 * DAY_MS,
    closedAgo: 12 * DAY_MS,
  },
  // Sem responsável: a própria execução do job o atribui ao agente disponível.
  {
    id: IDS.orphan,
    title: 'Como exportar meus dados?',
    description: 'Gostaria de exportar o histórico dos meus chamados.',
    status: 'OPEN',
    assigned: false,
    age: HOUR_MS,
  },
];

export function buildDemoTickets(now: Date): Prisma.TicketCreateManyInput[] {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  return DEMO_TICKETS.map((ticket) => {
    const createdAt = ago(ticket.age);
    const pausedAt = ticket.pausedAgo === undefined ? null : ago(ticket.pausedAgo);
    const finished = ticket.status === 'RESOLVED' || ticket.status === 'CLOSED';
    return {
      id: ticket.id,
      title: ticket.title,
      description: ticket.description,
      status: ticket.status,
      priority: 'LOW' as const,
      requesterId: DEMO_CUSTOMER_ID,
      assigneeId: ticket.assigned ? DEMO_AGENT_ID : null,
      createdAt,
      firstResponseAt: new Date(createdAt.getTime() + 30 * 60 * 1000),
      slaPausedAt: pausedAt,
      resolvedAt: finished ? pausedAt : null,
      closedAt: ticket.closedAgo === undefined ? null : ago(ticket.closedAgo),
      ...computeDeadlines(createdAt, DEFAULT_SLA_POLICIES.LOW),
    };
  });
}

export function buildDemoComments(now: Date): Prisma.CommentCreateManyInput[] {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  return [
    {
      ticketId: IDS.inProgress,
      authorId: DEMO_AGENT_ID,
      body: 'Consegui reproduzir o erro. Estou verificando com a equipe.',
      createdAt: ago(2 * HOUR_MS),
    },
    {
      ticketId: IDS.inProgress,
      authorId: DEMO_AGENT_ID,
      body: 'Nota interna: parece ser o mesmo problema da semana passada.',
      isInternal: true,
      createdAt: ago(2 * HOUR_MS - 60_000),
    },
    {
      ticketId: IDS.waiting,
      authorId: DEMO_AGENT_ID,
      body: 'Qual é o plano da sua conta? Assim confirmo o limite certo.',
      createdAt: ago(HOUR_MS),
    },
    {
      ticketId: IDS.resolved,
      authorId: DEMO_AGENT_ID,
      body: 'A cobrança duplicada foi estornada. Pode reabrir se precisar.',
      createdAt: ago(DAY_MS),
    },
  ];
}
