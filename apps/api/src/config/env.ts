import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Segredo HS256 do access token. Gere com `openssl rand -base64 48`. */
  JWT_ACCESS_SECRET: z.string().min(32),
  /**
   * Quantos proxies à frente da API são confiáveis para ler o IP do cliente em
   * X-Forwarded-For (usado pelo rate limit). 0 = nenhum, o padrão local.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

export type Env = z.infer<typeof EnvSchema>;

/** Token de injeção do ambiente validado. */
export const ENV = Symbol('ENV');

/**
 * Valida variáveis de ambiente contra um schema: falha cedo, listando só os
 * nomes das variáveis inválidas (nunca os valores, que podem conter senha).
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Variáveis de ambiente inválidas ou ausentes: ${fields}`);
  }
  return result.data;
}

/** Ambiente da API, validado na subida da aplicação. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parseEnv(EnvSchema, source);
}
