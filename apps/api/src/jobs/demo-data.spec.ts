import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Ticket } from '../generated/prisma/client.js';
import { computeSla, SLA_CLOCK } from '../sla/sla-calculator.js';
import { computeDeadlines } from '../sla/sla-deadlines.js';
import { REOPEN_WINDOW_MS } from '../tickets/ticket-state-machine.js';
import { buildDemoComments, buildDemoTickets, DEFAULT_SLA_POLICIES } from './demo-data.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const tickets = buildDemoTickets(NOW) as unknown as (Ticket & { pausedSeconds: number })[];

describe('dados da demo', () => {
  it('as políticas padrão são iguais às da migration', () => {
    const sql = readFileSync(
      new URL(
        '../../prisma/migrations/20261101000000_default_sla_policies/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const fromMigration = Object.fromEntries(
      [...sql.matchAll(/\('([A-Z]+)', (\d+), (\d+), now\(\)\)/g)].map(
        ([, priority, first, res]) => [
          priority,
          { firstResponseMinutes: Number(first), resolutionMinutes: Number(res) },
        ],
      ),
    );
    expect(fromMigration).toEqual(DEFAULT_SLA_POLICIES);
  });

  it('respeita o CHECK do SLA: relógio parado tem pausa, relógio correndo não tem', () => {
    for (const ticket of tickets) {
      expect(ticket.slaPausedAt === null).toBe(SLA_CLOCK[ticket.status] === 'RUNNING');
    }
  });

  it('prazos vêm só de computeDeadlines, com a política LOW', () => {
    for (const ticket of tickets) {
      expect(ticket.priority).toBe('LOW');
      expect(ticket).toMatchObject(computeDeadlines(ticket.createdAt, DEFAULT_SLA_POLICIES.LOW));
    }
  });

  it('nenhum relógio muda de estado nas 24 h até a próxima restauração', () => {
    const later = new Date(NOW.getTime() + DAY_MS);
    for (const ticket of tickets) {
      const snapshot = { ...ticket, pausedSeconds: 0 };
      const [before, after] = [computeSla(snapshot, NOW), computeSla(snapshot, later)];
      expect(after.firstResponse.state).toBe(before.firstResponse.state);
      expect(after.resolution.state).toBe(before.resolution.state);
      expect(ticket.firstResponseAt).not.toBeNull();
    }
  });

  it('cobre todos os status e o que o job trata na mesma execução', () => {
    expect(new Set(tickets.map((ticket) => ticket.status))).toEqual(
      new Set(Object.keys(SLA_CLOCK)),
    );
    const cutoff = NOW.getTime() - REOPEN_WINDOW_MS;
    const toClose = tickets.filter(
      (ticket) => ticket.status === 'RESOLVED' && ticket.resolvedAt!.getTime() < cutoff,
    );
    expect(toClose).toHaveLength(1);
    expect(tickets.filter((ticket) => ticket.assigneeId === null)).toHaveLength(1);
  });

  it('o ticket resolvido recente continua reabrível até a próxima restauração', () => {
    const recent = tickets.filter(
      (ticket) =>
        ticket.status === 'RESOLVED' &&
        ticket.resolvedAt!.getTime() >= NOW.getTime() - REOPEN_WINDOW_MS,
    );
    expect(recent).toHaveLength(1);
    expect(NOW.getTime() + DAY_MS - recent[0]!.resolvedAt!.getTime()).toBeLessThan(
      REOPEN_WINDOW_MS,
    );
  });

  it('comentários só apontam para tickets da demo', () => {
    const ids = new Set(tickets.map((ticket) => ticket.id));
    for (const comment of buildDemoComments(NOW)) expect(ids.has(comment.ticketId)).toBe(true);
  });
});
