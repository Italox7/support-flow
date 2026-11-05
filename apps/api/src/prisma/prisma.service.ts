import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV, type Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { parseDatabaseUrl } from './database-url.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: Pick<Env, 'DATABASE_URL'>) {
    const { connectionString, schema } = parseDatabaseUrl(env.DATABASE_URL);
    // Pool pequeno: o plano gratuito do pooler e os 512 MB do Render são o limite.
    // Sem conexão em 4 s, o erro chega antes do `maxWait` das transações.
    const pool = { connectionString, max: 5, connectionTimeoutMillis: 4_000 };
    super({ adapter: new PrismaPg(pool, { schema }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
