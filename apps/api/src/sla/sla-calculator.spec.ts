import type { SlaState, TicketStatus } from '@support-flow/shared';
import { describe, expect, it } from 'vitest';
import {
  computeSla,
  firstResponsePatch,
  priorityChangePatch,
  SLA_RUNNING_STATUSES,
  SLA_STOPPED_STATUSES,
  slaTransitionPatch,
  type SlaSnapshot,
} from './sla-calculator.js';
import { computeDeadlines } from './sla-deadlines.js';

const MIN = 60_000;
const createdAt = new Date('2026-11-01T12:00:00.000Z');
const at = (minutes: number) => new Date(createdAt.getTime() + minutes * MIN);
const urgent = { firstResponseMinutes: 60, resolutionMinutes: 240 };
const low = { firstResponseMinutes: 1440, resolutionMinutes: 7200 };

// URGENT: 1ª resposta em risco aos 48 min e vencida aos 60; resolução em risco
// aos 192 e vencida aos 240.
function ticket(overrides: Partial<SlaSnapshot> = {}): SlaSnapshot {
  return {
    status: 'OPEN',
    createdAt,
    firstResponseAt: null,
    slaPausedAt: null,
    pausedSeconds: 0,
    ...computeDeadlines(createdAt, urgent),
    ...overrides,
  };
}

const running = (status: TicketStatus, minute: number) =>
  computeSla(ticket({ status }), at(minute));
// Relógio parado: `now` bem depois de tudo, para provar que a referência é a pausa.
const stopped = (
  status: TicketStatus,
  pausedMinute: number,
  overrides: Partial<SlaSnapshot> = {},
) => computeSla(ticket({ status, slaPausedAt: at(pausedMinute), ...overrides }), at(10_000));

describe('SLA_CLOCK', () => {
  it('corre só em OPEN e IN_PROGRESS', () => {
    expect(SLA_RUNNING_STATUSES).toEqual(['OPEN', 'IN_PROGRESS']);
    expect(SLA_STOPPED_STATUSES).toEqual(['WAITING_CUSTOMER', 'RESOLVED', 'CLOSED']);
  });
});

describe('computeSla — 1ª resposta sem resposta', () => {
  // minuto da referência → estado, por status
  const table: [TicketStatus, number, SlaState][] = [
    ['OPEN', 0, 'OK'],
    ['OPEN', 47, 'OK'],
    ['OPEN', 48, 'AT_RISK'],
    ['OPEN', 60, 'AT_RISK'],
    ['OPEN', 61, 'BREACHED'],
    ['IN_PROGRESS', 47, 'OK'],
    ['IN_PROGRESS', 48, 'AT_RISK'],
    ['IN_PROGRESS', 61, 'BREACHED'],
    ['WAITING_CUSTOMER', 47, 'PAUSED'],
    ['WAITING_CUSTOMER', 55, 'PAUSED'],
    ['WAITING_CUSTOMER', 60, 'PAUSED'],
    ['WAITING_CUSTOMER', 61, 'BREACHED'],
    ['RESOLVED', 47, 'NOT_APPLICABLE'],
    ['RESOLVED', 55, 'NOT_APPLICABLE'],
    ['RESOLVED', 61, 'BREACHED'],
    ['CLOSED', 55, 'NOT_APPLICABLE'],
    ['CLOSED', 61, 'BREACHED'],
  ];

  it.each(table)('%s no minuto %i → %s', (status, minute, state) => {
    const sla = SLA_RUNNING_STATUSES.includes(status)
      ? running(status, minute)
      : stopped(status, minute);
    expect(sla.firstResponse.state).toBe(state);
  });
});

describe('computeSla — 1ª resposta dada', () => {
  it.each(SLA_RUNNING_STATUSES.concat(SLA_STOPPED_STATUSES))(
    '%s: MET até o prazo e BREACHED depois, qualquer que seja o agora',
    (status) => {
      const base = { status, slaPausedAt: SLA_RUNNING_STATUSES.includes(status) ? null : at(500) };
      const met = computeSla(ticket({ ...base, firstResponseAt: at(60) }), at(10_000));
      const late = computeSla(ticket({ ...base, firstResponseAt: at(61) }), at(10_000));
      expect(met.firstResponse).toEqual({ state: 'MET', dueAt: at(60), remainingSeconds: 0 });
      expect(late.firstResponse).toEqual({
        state: 'BREACHED',
        dueAt: at(60),
        remainingSeconds: -60,
      });
    },
  );
});

describe('computeSla — resolução', () => {
  const table: [TicketStatus, number, SlaState][] = [
    ['OPEN', 191, 'OK'],
    ['OPEN', 192, 'AT_RISK'],
    ['OPEN', 240, 'AT_RISK'],
    ['OPEN', 241, 'BREACHED'],
    ['IN_PROGRESS', 192, 'AT_RISK'],
    ['IN_PROGRESS', 241, 'BREACHED'],
    ['WAITING_CUSTOMER', 191, 'PAUSED'],
    ['WAITING_CUSTOMER', 200, 'PAUSED'],
    ['WAITING_CUSTOMER', 241, 'BREACHED'],
    ['RESOLVED', 200, 'MET'],
    ['RESOLVED', 240, 'MET'],
    ['RESOLVED', 241, 'BREACHED'],
    ['CLOSED', 240, 'MET'],
    ['CLOSED', 241, 'BREACHED'],
  ];

  it.each(table)('%s no minuto %i → %s', (status, minute, state) => {
    const sla = SLA_RUNNING_STATUSES.includes(status)
      ? running(status, minute)
      : stopped(status, minute);
    expect(sla.resolution.state).toBe(state);
  });

  it('resolvido depois de esperar o cliente: vale onde o relógio parou, não o resolvedAt', () => {
    // Pausou aos 200 (WAITING_CUSTOMER) e só foi resolvido aos 300: cumpriu.
    expect(stopped('RESOLVED', 200).resolution.state).toBe('MET');
  });
});

describe('computeSla — remainingSeconds', () => {
  it('conta do agora com o relógio correndo e congela na pausa', () => {
    expect(running('IN_PROGRESS', 230).resolution.remainingSeconds).toBe(600);
    expect(stopped('WAITING_CUSTOMER', 230).resolution.remainingSeconds).toBe(600);
    expect(running('IN_PROGRESS', 250).resolution.remainingSeconds).toBe(-600);
  });
});

describe('slaTransitionPatch', () => {
  const now = at(100);

  it('pausa ao sair de um status em que o relógio corre', () => {
    expect(slaTransitionPatch('IN_PROGRESS', 'WAITING_CUSTOMER', ticket(), now)).toEqual({
      data: { slaPausedAt: now },
      guard: {},
    });
    expect(slaTransitionPatch('IN_PROGRESS', 'RESOLVED', ticket(), now).data).toEqual({
      slaPausedAt: now,
    });
  });

  it.each([
    ['WAITING_CUSTOMER', 'RESOLVED'],
    ['RESOLVED', 'CLOSED'],
    ['OPEN', 'IN_PROGRESS'],
  ] as const)('%s → %s não mexe no relógio', (from, to) => {
    expect(slaTransitionPatch(from, to, ticket({ slaPausedAt: at(50) }), now)).toEqual({
      data: {},
      guard: {},
    });
  });

  it('retoma somando o tempo parado (s inteiros) à pausa e aos prazos, sob guarda', () => {
    const paused = ticket({
      status: 'WAITING_CUSTOMER',
      slaPausedAt: new Date(at(40).getTime() - 999),
      pausedSeconds: 120,
    });
    const { data, guard } = slaTransitionPatch('WAITING_CUSTOMER', 'IN_PROGRESS', paused, now);
    const seconds = 60 * 60; // 60 min e 999 ms parados → 3600 s
    const push = (date: Date) => new Date(date.getTime() + seconds * 1000);
    expect(data).toEqual({
      slaPausedAt: null,
      pausedSeconds: 120 + seconds,
      firstResponseDueAt: push(paused.firstResponseDueAt),
      firstResponseRiskAt: push(paused.firstResponseRiskAt),
      resolutionDueAt: push(paused.resolutionDueAt),
      resolutionRiskAt: push(paused.resolutionRiskAt),
    });
    expect(guard).toEqual({
      firstResponseAt: null,
      firstResponseDueAt: paused.firstResponseDueAt,
      resolutionDueAt: paused.resolutionDueAt,
    });
  });

  it('a 1ª resposta já dada não é empurrada na retomada', () => {
    const answered = ticket({ status: 'RESOLVED', slaPausedAt: at(40), firstResponseAt: at(10) });
    const { data, guard } = slaTransitionPatch('RESOLVED', 'IN_PROGRESS', answered, now);
    expect(data).not.toHaveProperty('firstResponseDueAt');
    expect(data).not.toHaveProperty('firstResponseRiskAt');
    expect(guard).toEqual({ resolutionDueAt: answered.resolutionDueAt });
  });

  it('mantém o invariante: prazos gravados = computeDeadlines(createdAt, política, pausedSeconds)', () => {
    let state = ticket();
    // Três pausas de durações quebradas, com status alternando.
    const cycles: [number, number][] = [
      [10, 25.5],
      [30, 31.01],
      [90, 200.7],
    ];
    for (const [pauseAt, resumeAt] of cycles) {
      const pause = slaTransitionPatch('IN_PROGRESS', 'WAITING_CUSTOMER', state, at(pauseAt));
      state = { ...state, ...pause.data, status: 'WAITING_CUSTOMER' } as SlaSnapshot;
      const resume = slaTransitionPatch('WAITING_CUSTOMER', 'IN_PROGRESS', state, at(resumeAt));
      state = { ...state, ...resume.data, status: 'IN_PROGRESS' } as SlaSnapshot;
    }
    expect(state.slaPausedAt).toBeNull();
    expect(state.pausedSeconds).toBeGreaterThan(0);
    expect(computeDeadlines(createdAt, urgent, state.pausedSeconds)).toEqual({
      firstResponseDueAt: state.firstResponseDueAt,
      firstResponseRiskAt: state.firstResponseRiskAt,
      resolutionDueAt: state.resolutionDueAt,
      resolutionRiskAt: state.resolutionRiskAt,
    });
  });
});

describe('firstResponsePatch', () => {
  it('com o relógio correndo, só grava a resposta, se ninguém pausou no meio', () => {
    expect(firstResponsePatch(ticket({ status: 'IN_PROGRESS' }), at(30))).toEqual({
      data: { firstResponseAt: at(30) },
      guard: { firstResponseAt: null, slaPausedAt: null },
    });
  });

  it('com o ticket pausado, mede onde o relógio parou e congela o prazo', () => {
    // Pausou aos 50 (faltavam 10 min); a resposta chega aos 120, ainda pausado.
    const paused = ticket({ status: 'WAITING_CUSTOMER', slaPausedAt: at(50) });
    const { data, guard } = firstResponsePatch(paused, at(120));
    expect(data).toEqual({
      firstResponseAt: at(120),
      firstResponseDueAt: at(130),
      firstResponseRiskAt: at(118),
    });
    expect(guard).toEqual({
      firstResponseAt: null,
      slaPausedAt: at(50),
      firstResponseDueAt: at(60),
    });
    const answered = { ...paused, ...data } as SlaSnapshot;
    expect(computeSla(answered, at(10_000)).firstResponse.state).toBe('MET');
  });

  it('pausado depois do prazo, a resposta continua atrasada', () => {
    const paused = ticket({ status: 'WAITING_CUSTOMER', slaPausedAt: at(70) });
    const answered = { ...paused, ...firstResponsePatch(paused, at(120)).data } as SlaSnapshot;
    expect(computeSla(answered, at(10_000)).firstResponse.state).toBe('BREACHED');
  });
});

describe('priorityChangePatch', () => {
  it('recalcula os dois prazos a partir da abertura, somando as pausas encerradas', () => {
    const paused = ticket({ pausedSeconds: 600, status: 'WAITING_CUSTOMER', slaPausedAt: at(90) });
    expect(priorityChangePatch(paused, low)).toEqual({
      data: computeDeadlines(createdAt, low, 600),
      guard: { firstResponseAt: null },
    });
  });

  it('não mexe na 1ª resposta já dada', () => {
    const answered = ticket({ firstResponseAt: at(5), pausedSeconds: 600 });
    const { resolutionDueAt, resolutionRiskAt } = computeDeadlines(createdAt, low, 600);
    expect(priorityChangePatch(answered, low)).toEqual({
      data: { resolutionDueAt, resolutionRiskAt },
      guard: {},
    });
  });
});
