import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { REFRESH_COOKIE } from '../src/auth/refresh-token.js';
import { ENV, loadEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Só roda contra um banco descartável, apontado explicitamente: o beforeEach
// apaga as tabelas, então nunca usamos a DATABASE_URL do .env por engano.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// E recusa qualquer host que não seja local (Supabase incluído): melhor falhar
// a suíte do que apagar os dados de um banco remoto.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
if (TEST_DATABASE_URL && !LOCAL_HOSTS.has(new URL(TEST_DATABASE_URL).hostname)) {
  throw new Error('TEST_DATABASE_URL precisa apontar para um Postgres local e descartável.');
}

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused@localhost/unused',
  JWT_ACCESS_SECRET: 'e2e-'.padEnd(48, 'x'),
});

async function createApp(options: { throttle: boolean }): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env);
  if (!options.throttle) {
    builder = builder.overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true });
  }
  const app = (await builder.compile()).createNestApplication<NestExpressApplication>();
  configureApp(app, env);
  await app.init();
  return app;
}

async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.refreshToken.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.user.deleteMany();
}

/** Valor do cookie de refresh (`refresh_token=<valor>`) num Set-Cookie. */
function refreshCookie(res: request.Response): string {
  const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = header.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  if (!cookie) throw new Error('Resposta sem cookie de refresh');
  return cookie.split(';')[0]!;
}

const customer = { email: 'Cliente@Example.com', password: 'senha-do-cliente', name: 'Cliente' };

describe.skipIf(!TEST_DATABASE_URL)('auth (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp({ throttle: false });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  describe('POST /api/auth/register', () => {
    it('cria um CUSTOMER, devolve o access token e grava o refresh no cookie', async () => {
      const res = await http().post('/api/auth/register').send(customer).expect(201);

      expect(res.body).toEqual({
        accessToken: expect.any(String),
        user: {
          id: expect.any(String),
          email: 'cliente@example.com',
          name: 'Cliente',
          role: 'CUSTOMER',
        },
      });
      const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';');
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/Secure/);
      expect(setCookie).toMatch(/SameSite=Lax/);
      expect(setCookie).toMatch(/Path=\/api\/auth/);
      expect(res.headers['cache-control']).toBe('no-store');

      const stored = await prisma.refreshToken.findFirstOrThrow();
      expect(refreshCookie(res)).not.toContain(stored.tokenHash);
    });

    it('recusa e-mail já cadastrado, sem diferenciar maiúsculas', async () => {
      await http().post('/api/auth/register').send(customer).expect(201);
      await http()
        .post('/api/auth/register')
        .send({ ...customer, email: 'CLIENTE@example.com' })
        .expect(409);
    });

    it('não aceita escolher o papel pelo corpo da requisição', async () => {
      await http()
        .post('/api/auth/register')
        .send({ ...customer, role: 'ADMIN' })
        .expect(400);
      expect(await prisma.user.count()).toBe(0);
    });

    it.each([
      ['e-mail inválido', { email: 'nao-e-email' }],
      ['senha curta', { password: 'curta' }],
      ['senha longa demais', { password: 'x'.repeat(129) }],
      ['nome vazio', { name: '   ' }],
    ])('retorna 400 com %s', async (_case, override) => {
      await http()
        .post('/api/auth/register')
        .send({ ...customer, ...override })
        .expect(400);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await http().post('/api/auth/register').send(customer).expect(201);
    });

    it('entra com e-mail em qualquer caixa', async () => {
      const res = await http()
        .post('/api/auth/login')
        .send({ email: 'CLIENTE@EXAMPLE.COM', password: customer.password })
        .expect(200);
      expect(res.body.user.email).toBe('cliente@example.com');
      expect(refreshCookie(res)).toBeTruthy();
    });

    it('dá a mesma resposta para senha errada e e-mail inexistente', async () => {
      const wrong = await http()
        .post('/api/auth/login')
        .send({ email: customer.email, password: 'senha-errada' })
        .expect(401);
      const unknown = await http()
        .post('/api/auth/login')
        .send({ email: 'ninguem@example.com', password: 'senha-errada' })
        .expect(401);
      expect(wrong.body).toEqual(unknown.body);
    });
  });

  describe('GET /api/auth/me', () => {
    it('devolve o usuário do access token', async () => {
      const { body } = await http().post('/api/auth/register').send(customer).expect(201);
      const res = await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
      expect(res.body).toEqual(body.user);
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('exige autenticação', async () => {
      await http().get('/api/auth/me').expect(401);
      await http().get('/api/auth/me').set('Authorization', 'Bearer invalido').expect(401);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('rotaciona: emite access token e cookie novos', async () => {
      const registered = await http().post('/api/auth/register').send(customer).expect(201);
      const first = refreshCookie(registered);

      const res = await http().post('/api/auth/refresh').set('Cookie', first).expect(200);
      expect(res.body.user.email).toBe('cliente@example.com');
      expect(refreshCookie(res)).not.toBe(first);

      await http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
    });

    it('reuso de um token já rotacionado revoga a família inteira', async () => {
      const registered = await http().post('/api/auth/register').send(customer).expect(201);
      const stolen = refreshCookie(registered);
      const rotated = await http().post('/api/auth/refresh').set('Cookie', stolen).expect(200);
      const current = refreshCookie(rotated);

      // O atacante usa a cópia antiga: 401 e a família cai...
      await http().post('/api/auth/refresh').set('Cookie', stolen).expect(401);
      // ...inclusive o token mais novo, que estava com o usuário legítimo.
      await http().post('/api/auth/refresh').set('Cookie', current).expect(401);

      expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
    });

    it('reuso não afeta outras sessões do mesmo usuário', async () => {
      const registered = await http().post('/api/auth/register').send(customer).expect(201);
      const otherDevice = await http()
        .post('/api/auth/login')
        .send({ email: customer.email, password: customer.password })
        .expect(200);

      const stolen = refreshCookie(registered);
      await http().post('/api/auth/refresh').set('Cookie', stolen).expect(200);
      await http().post('/api/auth/refresh').set('Cookie', stolen).expect(401);

      await http().post('/api/auth/refresh').set('Cookie', refreshCookie(otherDevice)).expect(200);
    });

    it('recusa token expirado', async () => {
      const registered = await http().post('/api/auth/register').send(customer).expect(201);
      await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      await http().post('/api/auth/refresh').set('Cookie', refreshCookie(registered)).expect(401);
    });

    it('recusa sem cookie ou com token desconhecido, e limpa o cookie', async () => {
      await http().post('/api/auth/refresh').expect(401);
      const res = await http()
        .post('/api/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=desconhecido`)
        .expect(401);
      expect(String(res.headers['set-cookie'])).toMatch(/refresh_token=;/);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revoga a sessão e limpa o cookie', async () => {
      const registered = await http().post('/api/auth/register').send(customer).expect(201);
      const cookie = refreshCookie(registered);

      const res = await http().post('/api/auth/logout').set('Cookie', cookie).expect(204);
      expect(String(res.headers['set-cookie'])).toMatch(/refresh_token=;/);

      await http().post('/api/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it('funciona sem cookie', async () => {
      await http().post('/api/auth/logout').expect(204);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('auth rate limit (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ throttle: true });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('bloqueia a 6ª tentativa de login no mesmo minuto', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'ninguem@example.com', password: 'senha-errada' });

    for (let i = 0; i < 5; i++) await attempt().expect(401);
    await attempt().expect(429);
  });
});
