import type { SlaState, TicketStatus } from '@support-flow/shared';
import { computeDeadlines, type SlaDeadlines, type SlaPolicyMinutes } from './sla-deadlines.js';

// Regras do relógio de SLA, sem banco. Quem grava é o TicketsService: cada
// função devolve o que escrever (`data`) e o que ainda precisa ser igual ao que
// foi lido para a escrita valer (`guard`), como no resto das escritas do ticket.

export type SlaClockMode = 'RUNNING' | 'PAUSED' | 'STOPPED';

/**
 * Em que status o relógio corre. Exaustivo de propósito: um status novo não
 * compila sem decidir o que o SLA faz nele. Não é o OPEN_STATUSES da atribuição.
 */
export const SLA_CLOCK = {
  OPEN: 'RUNNING',
  IN_PROGRESS: 'RUNNING',
  WAITING_CUSTOMER: 'PAUSED',
  RESOLVED: 'PAUSED',
  CLOSED: 'STOPPED',
} as const satisfies Record<TicketStatus, SlaClockMode>;

export const SLA_RUNNING_STATUSES = statusesWhere('RUNNING');
/** Relógio parado: o instante de referência é `slaPausedAt`, nunca agora. */
export const SLA_STOPPED_STATUSES = [...statusesWhere('PAUSED'), ...statusesWhere('STOPPED')];

function statusesWhere(mode: SlaClockMode): TicketStatus[] {
  return (Object.keys(SLA_CLOCK) as TicketStatus[]).filter((status) => SLA_CLOCK[status] === mode);
}

/** Campos do ticket que o SLA lê. `slaPausedAt` existe sempre que o relógio não corre. */
export interface SlaSnapshot extends SlaDeadlines {
  status: TicketStatus;
  createdAt: Date;
  firstResponseAt: Date | null;
  slaPausedAt: Date | null;
  pausedSeconds: number;
}

export interface SlaClockResult {
  state: SlaState;
  dueAt: Date;
  remainingSeconds: number;
}

export interface SlaResult {
  firstResponse: SlaClockResult;
  resolution: SlaClockResult;
}

/**
 * Estado dos dois relógios no instante `now`. Usa só os prazos gravados, não a
 * política: editar a política não muda o estado dos tickets que já existem.
 * Precedência: MET > BREACHED > PAUSED/NOT_APPLICABLE > AT_RISK > OK.
 */
export function computeSla(ticket: SlaSnapshot, now: Date): SlaResult {
  const running = SLA_CLOCK[ticket.status] === 'RUNNING';
  const resolved = ticket.status === 'RESOLVED' || ticket.status === 'CLOSED';
  // Onde o relógio está: agora, se corre; senão, onde parou.
  const clockAt = running ? now : (ticket.slaPausedAt ?? now);

  const firstResponse: SlaClockResult =
    ticket.firstResponseAt !== null
      ? done(ticket.firstResponseDueAt, ticket.firstResponseAt)
      : open(
          ticket.firstResponseDueAt,
          ticket.firstResponseRiskAt,
          clockAt,
          running,
          resolved ? 'NOT_APPLICABLE' : 'PAUSED',
        );
  const resolution: SlaClockResult = resolved
    ? done(ticket.resolutionDueAt, clockAt)
    : open(ticket.resolutionDueAt, ticket.resolutionRiskAt, clockAt, running, 'PAUSED');
  return { firstResponse, resolution };
}

function done(dueAt: Date, at: Date): SlaClockResult {
  return clock(at <= dueAt ? 'MET' : 'BREACHED', dueAt, at);
}

function open(
  dueAt: Date,
  riskAt: Date,
  at: Date,
  running: boolean,
  stoppedState: SlaState,
): SlaClockResult {
  if (at > dueAt) return clock('BREACHED', dueAt, at);
  if (!running) return clock(stoppedState, dueAt, at);
  return clock(at >= riskAt ? 'AT_RISK' : 'OK', dueAt, at);
}

function clock(state: SlaState, dueAt: Date, at: Date): SlaClockResult {
  return { state, dueAt, remainingSeconds: Math.floor((dueAt.getTime() - at.getTime()) / 1000) };
}

export interface SlaFieldsPatch {
  firstResponseAt?: Date;
  firstResponseDueAt?: Date;
  firstResponseRiskAt?: Date;
  resolutionDueAt?: Date;
  resolutionRiskAt?: Date;
  slaPausedAt?: Date | null;
  pausedSeconds?: number;
}

export interface SlaGuard {
  firstResponseAt?: null;
  firstResponseDueAt?: Date;
  resolutionDueAt?: Date;
  slaPausedAt?: Date | null;
}

export interface SlaWrite {
  data: SlaFieldsPatch;
  guard: SlaGuard;
}

/**
 * Pausa e retomada numa mudança de status. Na retomada, o tempo parado (em
 * segundos inteiros, o mesmo Δ em todos os campos) entra em `pausedSeconds` e
 * empurra os prazos, menos o da 1ª resposta já dada, que fica congelado.
 */
export function slaTransitionPatch(
  from: TicketStatus,
  to: TicketStatus,
  ticket: SlaSnapshot,
  now: Date,
): SlaWrite {
  const wasRunning = SLA_CLOCK[from] === 'RUNNING';
  const runs = SLA_CLOCK[to] === 'RUNNING';
  if (wasRunning && !runs) return { data: { slaPausedAt: now }, guard: {} };
  // Retomar sem slaPausedAt não acontece: o CHECK tickets_sla_paused_check exige a
  // pausa em todo status parado. A checagem só estreita o tipo; não "conserte".
  if (wasRunning || !runs || !ticket.slaPausedAt) return { data: {}, guard: {} };

  const seconds = Math.max(0, Math.floor((now.getTime() - ticket.slaPausedAt.getTime()) / 1000));
  const push = (date: Date) => new Date(date.getTime() + seconds * 1000);
  const data: SlaFieldsPatch = {
    slaPausedAt: null,
    pausedSeconds: ticket.pausedSeconds + seconds,
    resolutionDueAt: push(ticket.resolutionDueAt),
    resolutionRiskAt: push(ticket.resolutionRiskAt),
  };
  // Os prazos são gravados como valores absolutos: só valem se ninguém (um
  // PATCH de prioridade, a 1ª resposta) os mudou depois da leitura.
  const guard: SlaGuard = { resolutionDueAt: ticket.resolutionDueAt };
  if (ticket.firstResponseAt === null) {
    data.firstResponseDueAt = push(ticket.firstResponseDueAt);
    data.firstResponseRiskAt = push(ticket.firstResponseRiskAt);
    Object.assign(guard, { firstResponseAt: null, firstResponseDueAt: ticket.firstResponseDueAt });
  }
  return { data, guard };
}

/**
 * 1ª resposta registrada agora. Com o ticket pausado, o prazo dela recebe a
 * parte da pausa já decorrida: o "cumpriu?" é medido onde o relógio parou, e
 * daqui em diante o prazo fica congelado.
 */
export function firstResponsePatch(ticket: SlaSnapshot, now: Date): SlaWrite {
  if (!ticket.slaPausedAt) {
    return { data: { firstResponseAt: now }, guard: { firstResponseAt: null, slaPausedAt: null } };
  }
  const elapsed = Math.max(0, now.getTime() - ticket.slaPausedAt.getTime());
  return {
    data: {
      firstResponseAt: now,
      firstResponseDueAt: new Date(ticket.firstResponseDueAt.getTime() + elapsed),
      firstResponseRiskAt: new Date(ticket.firstResponseRiskAt.getTime() + elapsed),
    },
    guard: {
      firstResponseAt: null,
      slaPausedAt: ticket.slaPausedAt,
      firstResponseDueAt: ticket.firstResponseDueAt,
    },
  };
}

/**
 * Prazos da prioridade nova, a partir da abertura e somando as pausas já
 * encerradas (a que estiver em andamento entra na retomada). O prazo da 1ª
 * resposta já dada não muda.
 */
export function priorityChangePatch(ticket: SlaSnapshot, policy: SlaPolicyMinutes): SlaWrite {
  const deadlines = computeDeadlines(ticket.createdAt, policy, ticket.pausedSeconds);
  if (ticket.firstResponseAt !== null) {
    const { resolutionDueAt, resolutionRiskAt } = deadlines;
    return { data: { resolutionDueAt, resolutionRiskAt }, guard: {} };
  }
  return { data: deadlines, guard: { firstResponseAt: null } };
}
