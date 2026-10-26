import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV, type Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { parseDatabaseUrl } from './database-url.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    const { connectionString, schema } = parseDatabaseUrl(env.DATABASE_URL);
    super({ adapter: new PrismaPg({ connectionString }, { schema }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
