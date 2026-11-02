import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { EnvModule } from './config/env.module.js';
import { HealthController } from './health/health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { TicketsModule } from './tickets/tickets.module.js';

@Module({
  imports: [EnvModule, PrismaModule, AuthModule, TicketsModule],
  controllers: [HealthController],
})
export class AppModule {}
