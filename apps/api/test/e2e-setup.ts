import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Role } from '@support-flow/shared';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { AccessTokenPayload } from '../src/auth/auth.types.js';
import { PASSWORD_GATE_LIMITS, passwordGate } from '../src/auth/password.js';
import { GlobalRegisterLimitGuard, UserRateLimitGuard } from '../src/auth/rate-limit.guards.js';
import { ENV, loadEnv, type Env } from '../src/config/env.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SLA_RUNNING_STATUSES } from '../src/sla/sla-calculator.js';

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

/** Valores já validados: `RENDER=true` não passaria nas regras de deploy com URL local. */
export type EnvOverrides = Partial<Env>;

/** `rateLimitGuards` liga os limites de @UseGuards; por padrão, segue `throttle`. */
export async function createApp(options: {
  throttle: boolean;
  rateLimitGuards?: boolean;
  env?: EnvOverrides;
}): Promise<NestExpressApplication> {
  const appEnv = { ...env, ...options.env };
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(appEnv);
  if (!(options.rateLimitGuards ?? options.throttle)) {
    builder = builder
      .overrideGuard(UserRateLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(GlobalRegisterLimitGuard)
      .useValue({ canActivate: () => true });
  }
  if (!options.throttle) {
    // overrideProvider, não overrideGuard: o ThrottlerGuard global é um provider
    // (APP_GUARD com useExisting), e overrideGuard só troca os de @UseGuards.
    builder = builder.overrideProvider(ThrottlerGuard).useValue({ canActivate: () => true });
  }
  const app = (await builder.compile()).createNestApplication<NestExpressApplication>();
  configureApp(app, appEnv);
  await app.init();
  return app;
}

export interface Actor {
  id: string;
  token: string;
}

/** Usuário criado direto no banco, com o token assinado como o login faria. */
export async function createActor(
  app: NestExpressApplication,
  role: Role,
  name: string,
  data: Partial<Prisma.UserCreateInput> = {},
): Promise<Actor> {
  const user = await app.get(PrismaService).user.create({
    data: { email: `${name}@example.com`, name, role, passwordHash: 'sem-login', ...data },
  });
  const payload: AccessTokenPayload = { sub: user.id, role };
  return { id: user.id, token: await app.get(JwtService).signAsync(payload) };
}

/** Apaga os dados dos testes. As políticas de SLA vêm da migration e ficam. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.refreshToken.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * Status gravado direto no banco, sem passar pelas regras, mas respeitando o
 * CHECK do SLA: relógio parado tem `slaPausedAt`, relógio correndo não tem.
 * Só entende `status` como string; `{ set: ... }` passa direto e o CHECK acusa.
 */
export function withSlaClock(data: Prisma.TicketUpdateInput): Prisma.TicketUpdateInput {
  if (typeof data.status !== 'string' || data.slaPausedAt !== undefined) return data;
  const running = SLA_RUNNING_STATUSES.includes(data.status);
  return { ...data, slaPausedAt: running ? null : new Date() };
}

/**
 * Ocupa todas as vagas e a fila do argon2 (o app roda neste mesmo processo), para
 * a próxima chamada levar o 503. Quem fica na fila desiste em `maxWaitMs`; depois
 * disso a requisição do teste entra na fila e leva o 503 pelo timeout, também
 * válido, só mais lento. Devolve a função que libera tudo.
 */
export function fillPasswordGate(): () => Promise<void> {
  let open!: () => void;
  const blocker = new Promise<void>((resolve) => (open = resolve));
  const { permits, maxQueue } = PASSWORD_GATE_LIMITS;
  const held = Array.from({ length: permits + maxQueue }, () =>
    passwordGate.run(() => blocker).catch(() => undefined),
  );
  return async () => {
    open();
    await Promise.all(held);
  };
}
