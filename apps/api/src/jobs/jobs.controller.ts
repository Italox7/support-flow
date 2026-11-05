import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators.js';
import { JobSecretGuard } from './job-secret.guard.js';
import { JobsService, type JobsRunResult } from './jobs.service.js';

/**
 * Chamado pelo workflow agendado. Respostas: 200, 401, 404, 429, 500 e 503. Aqui o
 * 503 só diz que o passo com o lock não gravou: os anteriores podem ter gravado.
 * Repetir a chamada é seguro.
 */
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Public()
  @UseGuards(JobSecretGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('run')
  @HttpCode(200)
  run(): Promise<JobsRunResult> {
    return this.jobs.run();
  }
}
