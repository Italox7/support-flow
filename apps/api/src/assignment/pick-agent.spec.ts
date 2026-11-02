import { describe, expect, it } from 'vitest';
import { pickAgent, type AgentLoad } from './pick-agent.js';

const at = (iso: string) => new Date(iso);
const agent = (id: string, openTickets: number, lastAssignedAt: Date | null = null): AgentLoad => ({
  id,
  openTickets,
  lastAssignedAt,
});

describe('pickAgent', () => {
  it('sem candidatos, ninguém é escolhido', () => {
    expect(pickAgent([])).toBeNull();
  });

  it('escolhe o agente com menos tickets abertos', () => {
    expect(pickAgent([agent('a', 3), agent('b', 1), agent('c', 2)])).toBe('b');
  });

  it('a carga vence o desempate: menos tickets ganha mesmo tendo recebido agora', () => {
    const candidates = [
      agent('a', 2, at('2026-01-01T00:00:00Z')),
      agent('b', 1, at('2026-11-01T00:00:00Z')),
    ];
    expect(pickAgent(candidates)).toBe('b');
  });

  it('no empate de carga, escolhe quem recebeu ticket há mais tempo', () => {
    const candidates = [
      agent('a', 1, at('2026-11-01T10:00:00Z')),
      agent('b', 1, at('2026-11-01T09:00:00Z')),
      agent('c', 1, at('2026-11-01T11:00:00Z')),
    ];
    expect(pickAgent(candidates)).toBe('b');
  });

  it('quem nunca recebeu ticket vem antes de qualquer data', () => {
    const candidates = [agent('a', 0, at('2000-01-01T00:00:00Z')), agent('b', 0, null)];
    expect(pickAgent(candidates)).toBe('b');
  });

  it('no empate total, decide pelo id, em qualquer ordem da lista', () => {
    const same = at('2026-11-01T10:00:00Z');
    const candidates = [agent('c', 1, same), agent('a', 1, same), agent('b', 1, same)];
    expect(pickAgent(candidates)).toBe('a');
    expect(pickAgent([...candidates].reverse())).toBe('a');
    expect(pickAgent([agent('b', 0), agent('a', 0)])).toBe('a');
  });
});
