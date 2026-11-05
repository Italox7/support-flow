import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ENV, type Env } from '../config/env.js';

export const JOB_SECRET_HEADER = 'x-job-secret';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Autentica o agendador. Sem segredo configurado (desenvolvimento), a rota não
 * existe para ninguém. O hash iguala os tamanhos, como `timingSafeEqual` exige, e
 * não revela o tamanho do segredo. O 401 não diz o que estava errado.
 */
@Injectable()
export class JobSecretGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Pick<Env, 'JOBS_SECRET'>) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.env.JOBS_SECRET;
    if (!secret) throw new NotFoundException();
    const sent = context.switchToHttp().getRequest<Request>().headers[JOB_SECRET_HEADER];
    if (typeof sent !== 'string' || !timingSafeEqual(sha256(sent), sha256(secret))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
