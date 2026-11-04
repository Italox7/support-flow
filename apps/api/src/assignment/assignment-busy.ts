import {
  Catch,
  ServiceUnavailableException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ASSIGNMENT_BUSY_CODE } from '@support-flow/shared';
import type { Response } from 'express';

/**
 * Sem o lock da atribuição a tempo. O lock é a primeira instrução da transação,
 * então nada foi gravado: repetir é seguro, e o `Retry-After` com o `code` dizem
 * isso ao front. Outros 503 (o do health check, o de um proxy) não trazem o `code`.
 */
export class AssignmentBusyException extends ServiceUnavailableException {
  constructor() {
    super({
      statusCode: 503,
      message: 'O sistema está ocupado. Tente de novo em instantes.',
      error: 'Service Unavailable',
      code: ASSIGNMENT_BUSY_CODE,
    });
  }
}

/** A exceção do Nest não define cabeçalho: só este filtro escreve o `Retry-After`. */
@Catch(AssignmentBusyException)
export class AssignmentBusyFilter implements ExceptionFilter {
  catch(exception: AssignmentBusyException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', '1')
      .status(exception.getStatus())
      .json(exception.getResponse());
  }
}
