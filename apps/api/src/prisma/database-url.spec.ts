import { describe, expect, it } from 'vitest';
import { parseDatabaseUrl } from './database-url.js';

describe('parseDatabaseUrl', () => {
  it('extrai o schema e o remove da connection string', () => {
    const result = parseDatabaseUrl(
      'postgresql://u:p@host:6543/postgres?schema=dev&sslmode=require',
    );
    expect(result.schema).toBe('dev');
    expect(result.connectionString).toBe('postgresql://u:p@host:6543/postgres?sslmode=require');
  });

  it('usa public quando não há schema', () => {
    expect(parseDatabaseUrl('postgresql://u:p@host/postgres').schema).toBe('public');
  });

  it('preserva caracteres codificados na senha', () => {
    const { connectionString } = parseDatabaseUrl('postgresql://u:p%40ss@host/db?schema=dev');
    expect(connectionString).toContain('p%40ss');
  });
});
