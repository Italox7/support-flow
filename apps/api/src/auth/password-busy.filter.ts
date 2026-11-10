import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { PASSWORD_HASH_BUSY_CODE } from '@support-flow/shared';
import type { Response } from 'express';
import { PasswordHashBusyError } from './password.js';

export const PASSWORD_HASH_BUSY_BODY = {
  statusCode: 503,
  message: 'O servidor está ocupado. Tente de novo em instantes.',
  error: 'Service Unavailable',
  code: PASSWORD_HASH_BUSY_CODE,
} as const;

const logger = new Logger('PasswordHashBusy');

/** Fila do hash cheia: nada foi gravado. O front mostra o aviso e não repete sozinho. */
@Catch(PasswordHashBusyError)
export class PasswordHashBusyFilter implements ExceptionFilter {
  catch(_error: PasswordHashBusyError, host: ArgumentsHost): void {
    logger.warn({ event: 'password_hash_busy' });
    host
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', '2')
      .status(503)
      .json(PASSWORD_HASH_BUSY_BODY);
  }
}
