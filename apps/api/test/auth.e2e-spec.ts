import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD_HASH_BUSY_CODE } from '@support-flow/shared';
import { DEMO_EMAILS } from '../src/auth/demo-emails.js';
import { LOGIN_FAILURE_LIMIT } from '../src/auth/login-attempts.js';
import { hashPassword } from '../src/auth/password.js';
import { REFRESH_COOKIE } from '../src/auth/refresh-token.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createApp, fillPasswordGate, resetDatabase, TEST_DATABASE_URL } from './e2e-setup.js';

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

  describe('fila do argon2 cheia', () => {
    it('cadastro leva 503 com o code, sem gravar usuário nem refresh token', async () => {
      const release = fillPasswordGate();
      try {
        const res = await http().post('/api/auth/register').send(customer).expect(503);
        expect(res.headers['retry-after']).toBe('2');
        expect(res.body.code).toBe(PASSWORD_HASH_BUSY_CODE);
      } finally {
        await release();
      }
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.refreshToken.count()).toBe(0);
    });

    it('login leva 503 e a tentativa não conta para o limite por e-mail', async () => {
      // E-mail só deste teste: o LoginAttempts vive no app, que é um só para o arquivo,
      // e o resetDatabase não o zera. Com o e-mail compartilhado, as falhas de outros
      // testes somariam aqui, e as 10 deste travariam o login dos testes seguintes.
      const own = { ...customer, email: 'fila-cheia@example.com' };
      await http().post('/api/auth/register').send(own).expect(201);
      const wrong = { email: own.email, password: 'senha-errada' };
      const release = fillPasswordGate();
      try {
        for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
          const res = await http().post('/api/auth/login').send(wrong).expect(503);
          expect(res.body.code).toBe(PASSWORD_HASH_BUSY_CODE);
        }
      } finally {
        await release();
      }
      for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
        await http().post('/api/auth/login').send(wrong).expect(401);
      }
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

describe.skipIf(!TEST_DATABASE_URL)('limite de falhas de login por e-mail (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let ip = 0;
  // Um IP novo por requisição: o limite por e-mail não depende do X-Forwarded-For.
  const login = (email: string, password = 'senha-errada') =>
    request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', `203.0.113.${(ip = (ip % 250) + 1)}`)
      .send({ email, password });

  beforeAll(async () => {
    app = await createApp({ throttle: true, env: { TRUST_PROXY: 1 } });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it(`a ${LOGIN_FAILURE_LIMIT + 1}ª falha leva 429, igual para e-mail existente e inexistente`, async () => {
    await prisma.user.create({
      data: {
        email: 'existe@example.com',
        name: 'Existe',
        role: 'CUSTOMER',
        passwordHash: await hashPassword('senha-certa'),
      },
    });
    const locked: request.Response[] = [];
    for (const email of ['existe@example.com', 'ninguem@example.com']) {
      for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) await login(email).expect(401);
      locked.push(await login(email).expect(429));
    }
    const [existing, unknown] = locked;
    expect(existing!.body).toEqual(unknown!.body);
    for (const res of locked) expect(Number(res.headers['retry-after'])).toBeGreaterThan(60);

    // Bloqueado, nem a senha certa entra.
    await login('existe@example.com', 'senha-certa').expect(429);
  });

  it('logins certos não acumulam', async () => {
    await prisma.user.create({
      data: {
        email: 'certo@example.com',
        name: 'Certo',
        role: 'CUSTOMER',
        passwordHash: await hashPassword('senha-certa'),
      },
    });
    for (let i = 0; i < LOGIN_FAILURE_LIMIT + 2; i++) {
      await login('certo@example.com', 'senha-certa').expect(200);
    }
    await login('certo@example.com').expect(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('contas da demo no limite por e-mail (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ throttle: false, env: { DEMO_RESET_ENABLED: true } });
    const prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    await prisma.user.create({
      data: {
        email: DEMO_EMAILS.customer,
        name: 'Cliente Demo',
        role: 'CUSTOMER',
        passwordHash: await hashPassword('senha-da-demo'),
      },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('com a demo ligada, a conta demo não trava; outro e-mail trava', async () => {
    const login = (email: string, password = 'senha-errada') =>
      request(app.getHttpServer()).post('/api/auth/login').send({ email, password });

    for (let i = 0; i < LOGIN_FAILURE_LIMIT + 2; i++) await login(DEMO_EMAILS.customer).expect(401);
    await login(DEMO_EMAILS.customer, 'senha-da-demo').expect(200);

    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) await login('outro@example.com').expect(401);
    await login('outro@example.com').expect(429);
  });
});
