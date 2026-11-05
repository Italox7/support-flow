import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * `/health/live` é o health check do Render: sem banco, para uma queda do Supabase
 * não derrubar a instância em ciclo, e sem rate limit, para não levar 429 quando o
 * proxy concentra IPs. `/health` confere o banco e é o que o cron espera.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  @SkipThrottle()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get()
  async check(): Promise<{ status: 'ok'; database: 'up' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    }
    return { status: 'ok', database: 'up' };
  }
}
