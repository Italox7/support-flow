import { Inject, Injectable } from '@nestjs/common';
import { AssignmentService } from '../assignment/assignment.service.js';
import { hashPassword } from '../auth/password.js';
import { ENV, type Env } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { singleParam } from '../prisma/database-url.js';
import {
  buildDemoComments,
  buildDemoTickets,
  DEFAULT_SLA_POLICIES,
  DEMO_ACCOUNTS,
} from './demo-data.js';

type DemoEnv = Pick<Env, 'DEMO_RESET_ENABLED' | 'DEMO_PASSWORD' | 'RENDER' | 'DATABASE_URL'>;

/**
 * Apaga tudo e recria a demo. Três travas, porque um engano aqui apaga dados:
 * a flag, `RENDER=true` e o schema `public` lido da URL crua. `parseDatabaseUrl`
 * trata schema ausente como public, o que aqui não serve como prova.
 * Só usa a API de modelos: as escritas ficam presas ao schema do adapter.
 */
@Injectable()
export class DemoResetService {
  constructor(
    private readonly assignment: AssignmentService,
    @Inject(ENV) private readonly env: DemoEnv,
  ) {}

  /** Retorna `false`, sem tocar no banco, se qualquer trava não passar. */
  async restore(): Promise<boolean> {
    const { DEMO_RESET_ENABLED, DEMO_PASSWORD, RENDER, DATABASE_URL } = this.env;
    if (
      !DEMO_RESET_ENABLED ||
      !DEMO_PASSWORD ||
      RENDER !== 'true' ||
      singleParam(new URL(DATABASE_URL), 'schema') !== 'public'
    ) {
      return false;
    }

    // Antes da transação: o argon2 não pode segurar o lock nem uma conexão.
    const users: Prisma.UserCreateManyInput[] = [];
    for (const account of DEMO_ACCOUNTS) {
      users.push({
        ...account,
        passwordHash: await hashPassword(DEMO_PASSWORD),
        isAvailable: account.role === 'AGENT',
      });
    }

    await this.assignment.inLock(async (tx) => {
      const now = new Date();
      await tx.refreshToken.deleteMany();
      await tx.comment.deleteMany();
      await tx.ticket.deleteMany();
      await tx.user.deleteMany();
      await tx.user.createMany({ data: users });
      for (const [priority, minutes] of Object.entries(DEFAULT_SLA_POLICIES)) {
        const key = priority as keyof typeof DEFAULT_SLA_POLICIES;
        await tx.slaPolicy.upsert({
          where: { priority: key },
          create: { priority: key, ...minutes },
          update: minutes,
        });
      }
      await tx.ticket.createMany({ data: buildDemoTickets(now) });
      await tx.comment.createMany({ data: buildDemoComments(now) });
    });
    return true;
  }
}
