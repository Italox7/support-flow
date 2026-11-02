import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { OPEN_STATUSES } from '@support-flow/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { pickAgent, type AgentLoad } from './pick-agent.js';

// Atribuição automática por menor carga. Este módulo não importa tickets/ nem
// users/: eles é que dependem dele (regra no eslint.config.js).

type Db = Prisma.TransactionClient;

declare const locked: unique symbol;
/**
 * Transação que já segura o lock da atribuição. Só `inLock` cria uma: passar
 * `this.prisma` ou uma transação comum não compila, e um advisory lock pego
 * fora de transação seria liberado na hora, sem proteger nada.
 */
export type LockedTx = Db & { readonly [locked]: true };

/** Chave arbitrária: nenhum outro código usa advisory lock neste banco. */
export const ASSIGNMENT_LOCK_KEY = 7_340_001;

/**
 * Espera máxima pelo lock. Quem espera ocupa uma conexão do pool: sem esse
 * limite, uma rajada de criações esgotaria o pool e pararia a API inteira
 * (health check incluído). Melhor um 503 rápido.
 */
const LOCK_TIMEOUT = '2s';

/**
 * Toda criação de ticket entra nesta fila. `maxWait` é a espera por uma conexão
 * do pool; `timeout` cobre a transação inteira, inclusive a espera pelo lock.
 */
const LOCKED_TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 };

/** Órfãos atribuídos por varredura. O que passar disso espera a próxima. */
const ORPHAN_BATCH_SIZE = 100;

export const openTicketsWhere = {
  status: { in: [...OPEN_STATUSES] },
} satisfies Prisma.TicketWhereInput;

const agentSelect = {
  id: true,
  name: true,
  email: true,
  isAvailable: true,
  lastAssignedAt: true,
  _count: { select: { assignedTickets: { where: openTicketsWhere } } },
} satisfies Prisma.UserSelect;

export interface AgentWithLoad extends AgentLoad {
  name: string;
  email: string;
  isAvailable: boolean;
}

@Injectable()
export class AssignmentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Abre uma transação cuja primeira instrução é o lock: duas criações
   * simultâneas não leem a mesma carga, e ninguém segura lock de linha
   * enquanto espera na fila. É liberado no commit ou no rollback.
   */
  inLock<T>(fn: (tx: LockedTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // `true`: vale só para esta transação, inclusive atrás do pooler.
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`;
      try {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ASSIGNMENT_LOCK_KEY}::bigint)`;
      } catch {
        throw new ServiceUnavailableException(
          'O sistema está ocupado. Tente de novo em instantes.',
        );
      }
      return fn(tx as LockedTx);
    }, LOCKED_TX_OPTIONS);
  }

  /** Agentes com a carga atual. A leitura sozinha não precisa do lock. */
  async agents(db: Db, where: Prisma.UserWhereInput = {}): Promise<AgentWithLoad[]> {
    const rows = await db.user.findMany({
      where: { ...where, role: 'AGENT' },
      select: agentSelect,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ _count, ...agent }) => ({ ...agent, openTickets: _count.assignedTickets }));
  }

  async isAgent(db: Db, id: string): Promise<boolean> {
    return (await db.user.count({ where: { id, role: 'AGENT' } })) === 1;
  }

  /** Responsável para um ticket novo, ou `null` se nenhum agente está disponível. */
  async assignNew(tx: LockedTx, now: Date): Promise<string | null> {
    const agentId = pickAgent(await this.agents(tx, { isAvailable: true }));
    if (agentId) await tx.user.update({ where: { id: agentId }, data: { lastAssignedAt: now } });
    return agentId;
  }

  /**
   * Distribui os tickets abertos sem responsável, os de prazo mais curto
   * primeiro, com a carga atualizada a cada ticket. Retorna quantos atribuiu.
   */
  async assignOrphans(tx: LockedTx, now: Date): Promise<number> {
    const orphans = await tx.ticket.findMany({
      where: { assigneeId: null, ...openTicketsWhere },
      select: { id: true },
      orderBy: [{ resolutionDueAt: 'asc' }, { id: 'asc' }],
      take: ORPHAN_BATCH_SIZE,
    });
    if (orphans.length === 0) return 0;

    const candidates = await this.agents(tx, { isAvailable: true });
    const receivers = new Set<string>();
    let assigned = 0;
    for (const orphan of orphans) {
      const agentId = pickAgent(candidates);
      const agent = candidates.find((candidate) => candidate.id === agentId);
      if (!agent) break;
      // Transições não pegam o lock: um ticket resolvido enquanto isso fica de fora.
      const { count } = await tx.ticket.updateMany({
        where: { id: orphan.id, assigneeId: null, ...openTicketsWhere },
        data: { assigneeId: agent.id },
      });
      if (count === 0) continue;
      agent.openTickets += 1;
      agent.lastAssignedAt = now;
      receivers.add(agent.id);
      assigned += 1;
    }
    if (receivers.size > 0) {
      await tx.user.updateMany({
        where: { id: { in: [...receivers] } },
        data: { lastAssignedAt: now },
      });
    }
    return assigned;
  }

  /**
   * Ficar disponível já distribui os órfãos; ficar indisponível não tira os
   * tickets de ninguém. Retorna `false` se o id não é de um agente.
   */
  async setAvailability(
    tx: LockedTx,
    agentId: string,
    isAvailable: boolean,
    now: Date,
  ): Promise<boolean> {
    const { count } = await tx.user.updateMany({
      where: { id: agentId, role: 'AGENT' },
      data: { isAvailable },
    });
    if (count === 0) return false;
    if (isAvailable) await this.assignOrphans(tx, now);
    return true;
  }
}
