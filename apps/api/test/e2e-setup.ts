import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { ENV, loadEnv } from '../src/config/env.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

// Base comum dos testes E2E.

// Só roda contra um banco descartável, apontado explicitamente: o beforeEach
// apaga as tabelas, então nunca usamos a DATABASE_URL do .env por engano.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// E recusa qualquer host que não seja local (Supabase incluído): melhor falhar
// a suíte do que apagar os dados de um banco remoto.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
if (TEST_DATABASE_URL && !isLocalDatabaseUrl(TEST_DATABASE_URL)) {
  throw new Error('TEST_DATABASE_URL precisa apontar para um Postgres local e descartável.');
}

function isLocalDatabaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // O TypeError do URL traz a string inteira, senha incluída: não repassamos.
    throw new Error('TEST_DATABASE_URL não é uma URL válida.');
  }
  // O driver pg troca o host pelo parâmetro ?host=, o que escaparia da checagem.
  return LOCAL_HOSTS.has(url.hostname) && !url.searchParams.has('host');
}

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused@localhost/unused',
  JWT_ACCESS_SECRET: 'e2e-'.padEnd(48, 'x'),
});

export async function createApp(options: { throttle: boolean }): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env);
  if (!options.throttle) {
    // overrideProvider, não overrideGuard: o ThrottlerGuard global é um provider
    // (APP_GUARD com useExisting), e overrideGuard só troca os de @UseGuards.
    builder = builder.overrideProvider(ThrottlerGuard).useValue({ canActivate: () => true });
  }
  const app = (await builder.compile()).createNestApplication<NestExpressApplication>();
  configureApp(app, env);
  await app.init();
  return app;
}

/** Apaga os dados dos testes. As políticas de SLA vêm da migration e ficam. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.refreshToken.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.user.deleteMany();
}
