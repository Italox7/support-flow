import { TicketStatus } from '@support-flow/shared';
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  commentEffects,
  REOPEN_WINDOW_MS,
  transitionPatch,
  type Actor,
  type TransitionContext,
} from './ticket-state-machine.js';

const now = new Date('2026-11-10T12:00:00.000Z');
const STATUSES = Object.values(TicketStatus);

/** Atores com o vínculo que importa para a regra: dono do ticket, responsável. */
const ACTORS: Record<string, { actor: Actor; isRequester: boolean; isAssignee: boolean }> = {
  'cliente dono': { actor: 'CUSTOMER', isRequester: true, isAssignee: false },
  'outro cliente': { actor: 'CUSTOMER', isRequester: false, isAssignee: false },
  'agente responsável': { actor: 'AGENT', isRequester: false, isAssignee: true },
  'outro agente': { actor: 'AGENT', isRequester: false, isAssignee: false },
  admin: { actor: 'ADMIN', isRequester: false, isAssignee: false },
  sistema: { actor: 'SYSTEM', isRequester: false, isAssignee: false },
};

/** A tabela do plano: transição existente → quem pode fazê-la. */
const ALLOWED: Record<string, string[]> = {
  'OPEN→IN_PROGRESS': ['agente responsável', 'admin', 'sistema'],
  'IN_PROGRESS→WAITING_CUSTOMER': ['agente responsável', 'outro agente', 'admin'],
  'IN_PROGRESS→RESOLVED': ['cliente dono', 'agente responsável', 'outro agente', 'admin'],
  'WAITING_CUSTOMER→IN_PROGRESS': ['agente responsável', 'outro agente', 'admin', 'sistema'],
  'WAITING_CUSTOMER→RESOLVED': ['cliente dono', 'agente responsável', 'outro agente', 'admin'],
  'RESOLVED→IN_PROGRESS': ['cliente dono'],
  'RESOLVED→CLOSED': ['sistema'],
};

const cases = STATUSES.flatMap((from) =>
  STATUSES.flatMap((to) => Object.keys(ACTORS).map((who) => [from, to, who] as const)),
);

describe('canTransition', () => {
  it.each(cases)('%s → %s por %s', (from, to, who) => {
    const { actor, ...links } = ACTORS[who]!;
    const ctx: TransitionContext = { ...links, resolvedAt: now, now };
    const allowed = ALLOWED[`${from}→${to}`];

    const expected = !allowed
      ? { ok: false, reason: 'INVALID_TRANSITION' }
      : allowed.includes(who)
        ? { ok: true }
        : { ok: false, reason: 'NOT_ALLOWED' };
    expect(canTransition(from, to, actor, ctx)).toEqual(expected);
  });

  describe('reabertura pelo cliente', () => {
    const owner = { isRequester: true, isAssignee: false, now };
    const reopen = (resolvedAt: Date | null) =>
      canTransition('RESOLVED', 'IN_PROGRESS', 'CUSTOMER', { ...owner, resolvedAt });

    it('aceita no limite de 7 dias', () => {
      expect(reopen(new Date(now.getTime() - REOPEN_WINDOW_MS))).toEqual({ ok: true });
    });

    it('recusa depois de 7 dias', () => {
      expect(reopen(new Date(now.getTime() - REOPEN_WINDOW_MS - 1))).toEqual({
        ok: false,
        reason: 'REOPEN_WINDOW_EXPIRED',
      });
    });

    it('recusa sem data de resolução', () => {
      expect(reopen(null)).toEqual({ ok: false, reason: 'REOPEN_WINDOW_EXPIRED' });
    });
  });
});

describe('transitionPatch', () => {
  it('grava resolvedAt ao resolver', () => {
    expect(transitionPatch('IN_PROGRESS', 'RESOLVED', now)).toEqual({ resolvedAt: now });
  });

  it('limpa resolvedAt ao reabrir', () => {
    expect(transitionPatch('RESOLVED', 'IN_PROGRESS', now)).toEqual({ resolvedAt: null });
  });

  it('grava closedAt ao fechar', () => {
    expect(transitionPatch('RESOLVED', 'CLOSED', now)).toEqual({ closedAt: now });
  });

  it('não grava nada nas demais', () => {
    expect(transitionPatch('OPEN', 'IN_PROGRESS', now)).toEqual({});
  });
});

describe('commentEffects', () => {
  const agent = { id: 'agente', role: 'AGENT' as const };
  const customer = { id: 'cliente', role: 'CUSTOMER' as const };
  const ticket = (overrides: Partial<Parameters<typeof commentEffects>[0]> = {}) => ({
    status: 'IN_PROGRESS' as TicketStatus,
    assigneeId: 'agente',
    firstResponseAt: null,
    ...overrides,
  });

  it('1ª resposta pública de qualquer agente marca a 1ª resposta', () => {
    expect(commentEffects(ticket({ assigneeId: null }), agent, false)).toEqual({
      setFirstResponseAt: true,
    });
  });

  it('não remarca a 1ª resposta', () => {
    expect(commentEffects(ticket({ firstResponseAt: now }), agent, false)).toEqual({
      setFirstResponseAt: false,
    });
  });

  it('resposta do agente responsável tira o ticket de OPEN', () => {
    expect(commentEffects(ticket({ status: 'OPEN' }), agent, false)).toEqual({
      setFirstResponseAt: true,
      statusTo: 'IN_PROGRESS',
    });
  });

  it('resposta de outro agente não muda o status de OPEN', () => {
    expect(commentEffects(ticket({ status: 'OPEN', assigneeId: 'outro' }), agent, false)).toEqual({
      setFirstResponseAt: true,
    });
  });

  it('nota interna não tem efeito', () => {
    expect(commentEffects(ticket({ status: 'OPEN' }), agent, true)).toEqual({
      setFirstResponseAt: false,
    });
  });

  it('comentário do cliente devolve WAITING_CUSTOMER para IN_PROGRESS', () => {
    expect(commentEffects(ticket({ status: 'WAITING_CUSTOMER' }), customer, false)).toEqual({
      setFirstResponseAt: false,
      statusTo: 'IN_PROGRESS',
    });
  });

  it('comentário do cliente em RESOLVED não reabre', () => {
    expect(commentEffects(ticket({ status: 'RESOLVED' }), customer, false)).toEqual({
      setFirstResponseAt: false,
    });
  });
});
