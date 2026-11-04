import type { SlaClock, SlaState, TicketSla } from '@support-flow/shared';
import { SLA_LABELS } from './labels';

// O front não recalcula os 80%: o estado vem da API. Daqui só sai a contagem entre
// uma resposta e outra e, ao passar de zero, o Violado que a API diria.

const RANK: Record<SlaState, number> = {
  BREACHED: 0,
  AT_RISK: 1,
  OK: 2,
  PAUSED: 3,
  MET: 4,
  NOT_APPLICABLE: 5,
};

export const isCounting = (state: SlaState) => state === 'OK' || state === 'AT_RISK';

/** O relógio da fila. Num ticket já concluído, vale o veredito da resolução. */
export function mostUrgent(sla: TicketSla): SlaClock {
  const { firstResponse, resolution } = sla;
  const byRank = RANK[firstResponse.state] - RANK[resolution.state];
  const first =
    byRank < 0 || (byRank === 0 && firstResponse.remainingSeconds < resolution.remainingSeconds);
  const urgent = first ? firstResponse : resolution;
  return urgent.state === 'MET' || urgent.state === 'NOT_APPLICABLE' ? resolution : urgent;
}

export function secondsLeft(clock: SlaClock, receivedAt: number, now: number): number {
  return clock.remainingSeconds - Math.floor(Math.max(0, now - receivedAt) / 1000);
}

export function liveState(clock: SlaClock, receivedAt: number, now: number): SlaState {
  return isCounting(clock.state) && secondsLeft(clock, receivedAt, now) < 0
    ? 'BREACHED'
    : clock.state;
}

/** Minutos até 1 h e segundos só no último minuto. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`;
  const restHours = hours % 24;
  const days = Math.floor(hours / 24);
  return restHours ? `${days} d ${restHours} h` : `${days} d`;
}

/** Texto para leitor de tela: estático, do instante da resposta, sem anunciar cada segundo. */
export function describeClock(name: string, clock: SlaClock): string {
  const label = SLA_LABELS[clock.state];
  switch (clock.state) {
    case 'OK':
    case 'AT_RISK':
      return `${name}: ${label}, vence em ${formatDuration(clock.remainingSeconds)}.`;
    case 'PAUSED':
      return `${name}: ${label}, aguardando cliente.`;
    case 'NOT_APPLICABLE':
      return `${name}: ${label}, resolvido antes do prazo de 1ª resposta.`;
    case 'BREACHED':
    case 'MET':
      return `${name}: ${label}.`;
  }
}

export function describeSla(sla: TicketSla): string {
  return `${describeClock('Primeira resposta', sla.firstResponse)} ${describeClock('Resolução', sla.resolution)}`;
}
