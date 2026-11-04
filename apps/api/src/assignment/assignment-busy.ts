import {
  Catch,
  ServiceUnavailableException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Sem o lock da atribuição a tempo. O lock é a primeira instrução da transação,
 * então nada foi gravado: repetir é seguro, e o `Retry-After` diz isso ao front.
 * Outros 503 (o do health check, o de um proxy) não trazem o cabeçalho.
 */
export class AssignmentBusyException extends ServiceUnavailableException {
  constructor() {
    super('O sistema está ocupado. Tente de novo em instantes.');
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
