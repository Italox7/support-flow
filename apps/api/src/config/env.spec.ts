import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv, parseEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=dev',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

function captureError(run: () => unknown): Error & Record<string, unknown> {
  try {
    run();
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error('Esperava uma exceção.');
}

const CA = 'sslrootcert=certs/supabase-ca.crt';
const HOST = 'postgresql://u:p@aws-0-x.pooler.supabase.com';
const deploy = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JOBS_SECRET: 'j'.repeat(32),
  TRUST_PROXY: '2',
  DATABASE_URL: `${HOST}:6543/postgres?schema=public&sslmode=verify-full&${CA}`,
  DIRECT_URL: `${HOST}:5432/postgres?schema=public&sslmode=require`,
};

describe('loadEnv em deploy', () => {
  it('aceita a configuração esperada, com NODE_ENV=production ou RENDER=true', () => {
    expect(loadEnv(deploy).TRUST_PROXY).toBe(2);
    expect(loadEnv({ ...deploy, NODE_ENV: 'development', RENDER: 'true' }).RENDER).toBe('true');
  });

  it('não aplica as regras fora de deploy', () => {
    expect(() => loadEnv(valid)).not.toThrow();
    expect(() => loadEnv({ ...valid, RENDER: 'false' })).not.toThrow();
  });

  it.each([
    ['TRUST_PROXY', { TRUST_PROXY: '0' }],
    ['TRUST_PROXY', { TRUST_PROXY: undefined }],
    ['JOBS_SECRET', { JOBS_SECRET: undefined }],
    ['JOBS_SECRET', { JOBS_SECRET: 'curto' }],
    ['DIRECT_URL', { DIRECT_URL: undefined }],
  ])('recusa %s inválido: %j', (field, change) => {
    expect(() => loadEnv({ ...deploy, ...change })).toThrow(new RegExp(field));
  });

  it.each([
    ['sem sslmode', `${HOST}:6543/postgres?schema=public&${CA}`],
    ['sslmode fraco', `${HOST}:6543/postgres?schema=public&sslmode=require&${CA}`],
    ['sem CA', `${HOST}:6543/postgres?schema=public&sslmode=verify-full`],
    ['outra CA', `${HOST}:6543/postgres?schema=public&sslmode=verify-full&sslrootcert=x.crt`],
    ['sem schema', `${HOST}:6543/postgres?sslmode=verify-full&${CA}`],
    ['schema vazio', `${HOST}:6543/postgres?schema=&sslmode=verify-full&${CA}`],
    [
      'schema duplicado',
      `${HOST}:6543/postgres?schema=public&schema=dev&sslmode=verify-full&${CA}`,
    ],
    [
      'sslmode duplicado',
      `${HOST}:6543/postgres?schema=public&sslmode=verify-full&sslmode=disable&${CA}`,
    ],
    [
      'uselibpqcompat',
      `${HOST}:6543/postgres?schema=public&sslmode=verify-full&${CA}&uselibpqcompat=true`,
    ],
    [
      'host na query',
      `${HOST}:6543/postgres?schema=public&sslmode=verify-full&${CA}&host=evil.example.com`,
    ],
  ])('recusa DATABASE_URL %s', (_name, DATABASE_URL) => {
    expect(() => loadEnv({ ...deploy, DATABASE_URL })).toThrow(/DATABASE_URL/);
  });

  it.each([
    ['sem sslmode', `${HOST}:5432/postgres?schema=public`],
    [
      'verify-full, que o schema engine não suporta',
      `${HOST}:5432/postgres?schema=public&sslmode=verify-full`,
    ],
    ['outro schema', `${HOST}:5432/postgres?schema=dev&sslmode=require`],
    ['sem schema', `${HOST}:5432/postgres?sslmode=require`],
    [
      'outro host',
      'postgresql://u:p@outro.example.com:5432/postgres?schema=public&sslmode=require',
    ],
    ['uselibpqcompat', `${HOST}:5432/postgres?schema=public&sslmode=require&uselibpqcompat=true`],
    [
      'outro projeto',
      'postgresql://v:p@aws-0-x.pooler.supabase.com:5432/postgres?schema=public&sslmode=require',
    ],
    ['outro database', `${HOST}:5432/outro?schema=public&sslmode=require`],
  ])('recusa DIRECT_URL %s', (_name, DIRECT_URL) => {
    expect(() => loadEnv({ ...deploy, DIRECT_URL })).toThrow(/DIRECT_URL/);
  });

  it.each([
    ['DATABASE_URL', 'porta inválida', 'postgresql://u:SENHA_SECRETA@h:porta/db'],
    ['DATABASE_URL', 'barra na senha', 'postgresql://u:SENHA/SECRETA@h:6543/db'],
    ['DIRECT_URL', 'porta inválida', 'postgresql://u:SENHA_SECRETA@h:porta/db'],
    ['DIRECT_URL', 'barra na senha', 'postgresql://u:SENHA/SECRETA@h:5432/db'],
  ])('%s malformada (%s) só cita o nome da variável', (field, _name, url) => {
    const error = captureError(() => loadEnv({ ...deploy, [field]: url }));
    expect(error.message).toContain(field);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain('SECRETA');
  });

  it('uma exceção inesperada na validação não repassa o erro original', () => {
    const schema = z.string().transform((value) => {
      throw new TypeError(`Invalid URL: ${value}`);
    });
    const error = captureError(() => parseEnv(schema, 'SENHA_SECRETA' as never));
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain('SECRETA');
  });

  it('a mensagem nunca traz a senha da URL', () => {
    const DATABASE_URL = 'postgresql://u:SENHA_SECRETA@h:6543/postgres';
    expect(() => loadEnv({ ...deploy, DATABASE_URL })).not.toThrow(/SENHA_SECRETA/);
  });
});

describe('DEMO_RESET_ENABLED', () => {
  it('"false" é falso, e o padrão também', () => {
    expect(loadEnv({ ...valid, DEMO_RESET_ENABLED: 'false' }).DEMO_RESET_ENABLED).toBe(false);
    expect(loadEnv(valid).DEMO_RESET_ENABLED).toBe(false);
  });

  it('recusa valores que não sejam true ou false', () => {
    expect(() => loadEnv({ ...valid, DEMO_RESET_ENABLED: '1' })).toThrow(/DEMO_RESET_ENABLED/);
  });

  it('ligado, exige DEMO_PASSWORD com pelo menos 12 caracteres', () => {
    const on = { ...valid, DEMO_RESET_ENABLED: 'true' };
    expect(() => loadEnv(on)).toThrow(/DEMO_PASSWORD/);
    expect(() => loadEnv({ ...on, DEMO_PASSWORD: 'curta' })).toThrow(/DEMO_PASSWORD/);
    expect(loadEnv({ ...on, DEMO_PASSWORD: 'd'.repeat(12) }).DEMO_RESET_ENABLED).toBe(true);
  });
});

describe('loadEnv', () => {
  it('aplica os padrões de NODE_ENV, PORT e TRUST_PROXY', () => {
    expect(loadEnv(valid)).toMatchObject({ NODE_ENV: 'development', PORT: 3000, TRUST_PROXY: 0 });
  });

  it('converte PORT para número', () => {
    expect(loadEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejeita URL que não é Postgres', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('exige um segredo de JWT com pelo menos 32 caracteres', () => {
    expect(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: 'curto' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('não vaza o valor da variável na mensagem de erro', () => {
    const secret = 'postgresql://user:SENHA_SECRETA@/db';
    expect(() => loadEnv({ ...valid, DATABASE_URL: secret, PORT: 'abc' })).not.toThrow(
      /SENHA_SECRETA/,
    );
    expect(() => loadEnv({ ...valid, JWT_ACCESS_SECRET: 'JWT_VAZADO' })).not.toThrow(/JWT_VAZADO/);
  });
});
