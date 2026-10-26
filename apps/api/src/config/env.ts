import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type Env = z.infer<typeof EnvSchema>;

/** Token de injeção do ambiente validado. */
export const ENV = Symbol('ENV');

/**
 * Valida as variáveis na subida da aplicação: falha cedo, listando só os nomes
 * das variáveis inválidas (nunca os valores, que podem conter senha).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Variáveis de ambiente inválidas ou ausentes: ${fields}`);
  }
  return result.data;
}
