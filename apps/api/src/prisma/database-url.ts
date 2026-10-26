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
