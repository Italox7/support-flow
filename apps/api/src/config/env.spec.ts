import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=dev' };

describe('loadEnv', () => {
  it('aplica os padrões de NODE_ENV e PORT', () => {
    expect(loadEnv(valid)).toMatchObject({ NODE_ENV: 'development', PORT: 3000 });
  });

  it('converte PORT para número', () => {
    expect(loadEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejeita URL que não é Postgres', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it('não vaza o valor da variável na mensagem de erro', () => {
    const secret = 'postgresql://user:SENHA_SECRETA@/db';
    expect(() => loadEnv({ DATABASE_URL: secret, PORT: 'abc' })).not.toThrow(/SENHA_SECRETA/);
  });
});
