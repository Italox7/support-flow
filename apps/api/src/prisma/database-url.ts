export interface PgConnection {
  connectionString: string;
  schema: string;
}

/**
 * O driver `pg` não entende o parâmetro `?schema=` das URLs do Prisma: ele é
 * removido da connection string e repassado ao adapter, que qualifica as queries
 * com o schema. Assim a mesma DATABASE_URL serve à CLI e à aplicação.
 */
export function parseDatabaseUrl(databaseUrl: string): PgConnection {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') || 'public';
  url.searchParams.delete('schema');
  return { connectionString: url.toString(), schema };
}

/** O valor do parâmetro, ou `null` se estiver ausente, vazio ou duplicado. Nunca assume padrão. */
export function singleParam(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] ? values[0] : null;
}

export function hasOnlyParams(url: URL, allowed: readonly string[]): boolean {
  return [...url.searchParams.keys()].every((name) => allowed.includes(name));
}
