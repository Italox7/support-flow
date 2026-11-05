import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { EnvModule } from './config/env.module.js';
import { HealthController } from './health/health.controller.js';
import { JobsModule } from './jobs/jobs.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SlaModule } from './sla/sla.module.js';
import { TicketsModule } from './tickets/tickets.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [EnvModule, PrismaModule, AuthModule, TicketsModule, UsersModule, SlaModule, JobsModule],
  controllers: [HealthController],
})
export class AppModule {}
