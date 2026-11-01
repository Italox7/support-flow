import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=dev',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

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
