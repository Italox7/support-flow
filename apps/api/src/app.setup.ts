import { Logger, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { AssignmentBusyFilter } from './assignment/assignment-busy.js';
import type { Env } from './config/env.js';

/** Configuração comum a main.ts e aos testes E2E, para testarmos o app como ele roda. */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  if (env.LOG_XFF_COUNT) app.use(logForwardedForCount);
  app.use(noStore);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AssignmentBusyFilter());
}

/**
 * Toda resposta da API carrega dados de um usuário (ou o erro dele): nenhum cache,
 * do navegador ou de proxy, pode guardá-la. Sem isto, valeria o Cache-Control
 * padrão da Vercel no rewrite de /api. Vem antes das rotas, então cobre também
 * 401, 404 e as respostas dos filtros de erro.
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

const xffLogger = new Logger('TrustProxy');

/** Mede o TRUST_PROXY no deploy: registra só a contagem, nunca os IPs. */
export function logForwardedForCount(req: Request, _res: Response, next: NextFunction): void {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  xffLogger.log(`X-Forwarded-For com ${value ? value.split(',').length : 0} entrada(s)`);
  next();
}
