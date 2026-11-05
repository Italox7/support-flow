import { z } from 'zod';
import { hasOnlyParams, singleParam } from '../prisma/database-url.js';

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

/** Só 'true' ou 'false': `z.coerce.boolean` transformaria "false" em true. */
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/** A CA pública versionada, relativa ao cwd `apps/api` de `npm start`. */
export const SUPABASE_CA_PATH = 'certs/supabase-ca.crt';

const BaseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: postgresUrl,
  /** Só a CLI do Prisma usa; aqui ela é exigida em deploy, junto da DATABASE_URL. */
  DIRECT_URL: postgresUrl.optional(),
  /** Segredo HS256 do access token. Gere com `openssl rand -base64 48`. */
  JWT_ACCESS_SECRET: z.string().min(32),
  /**
   * Quantos proxies à frente da API são confiáveis para ler o IP do cliente em
   * X-Forwarded-For (usado pelo rate limit). 0 = nenhum, o padrão local.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** O Render define `RENDER=true`. Isso não prova que é a demo: ver DemoResetService. */
  RENDER: z.string().optional(),
  /** Autentica `POST /api/jobs/run`. Sem ele, a rota responde 404. */
  JOBS_SECRET: z.string().min(32).optional(),
  DEMO_RESET_ENABLED: flag,
  /** Senha pública das contas de demonstração, exclusiva da demo. */
  DEMO_PASSWORD: z.string().min(12).max(128).optional(),
  /** Loga só a quantidade de entradas do X-Forwarded-For, para medir TRUST_PROXY. */
  LOG_XFF_COUNT: flag,
});

const EnvSchema = BaseEnvSchema.superRefine((env, ctx) => {
  const invalid = (field: keyof typeof env) =>
    ctx.addIssue({ code: 'custom', path: [field], message: 'inválida para este ambiente' });

  if (env.DEMO_RESET_ENABLED && !env.DEMO_PASSWORD) invalid('DEMO_PASSWORD');

  if (env.NODE_ENV !== 'production' && env.RENDER !== 'true') return;
  // O zod roda este refine mesmo com `z.url` reprovado, e o TypeError de `new URL`
  // traz a URL inteira, senha incluída. A issue do campo já foi registrada.
  if (!URL.canParse(env.DATABASE_URL) || (env.DIRECT_URL && !URL.canParse(env.DIRECT_URL))) return;
  if (env.TRUST_PROXY < 1) invalid('TRUST_PROXY');
  if (!env.JOBS_SECRET) invalid('JOBS_SECRET');
  for (const field of deployUrlProblems(env)) invalid(field);
});

/**
 * O que a conexão precisa em deploy, lendo os parâmetros crus da URL: ausente,
 * duplicado ou desconhecido é recusado. A lista fechada barra `uselibpqcompat`,
 * que muda o sentido de `sslmode`, e `host`, que troca o destino da conexão.
 * `DATABASE_URL` verifica o certificado e o nome do servidor; `DIRECT_URL` fica em
 * `require` porque o schema engine do Prisma não suporta `verify-full`.
 */
function deployUrlProblems(env: {
  DATABASE_URL: string;
  DIRECT_URL?: string | undefined;
}): ('DATABASE_URL' | 'DIRECT_URL')[] {
  const problems = new Set<'DATABASE_URL' | 'DIRECT_URL'>();
  const app = new URL(env.DATABASE_URL);
  const appSchema = singleParam(app, 'schema');
  if (
    !hasOnlyParams(app, ['schema', 'sslmode', 'sslrootcert']) ||
    !appSchema ||
    singleParam(app, 'sslmode') !== 'verify-full' ||
    singleParam(app, 'sslrootcert') !== SUPABASE_CA_PATH
  ) {
    problems.add('DATABASE_URL');
  }

  if (!env.DIRECT_URL) return [...problems, 'DIRECT_URL'];
  const cli = new URL(env.DIRECT_URL);
  if (
    !hasOnlyParams(cli, ['schema', 'sslmode']) ||
    singleParam(cli, 'sslmode') !== 'require' ||
    singleParam(cli, 'schema') !== appSchema ||
    cli.hostname.toLowerCase() !== app.hostname.toLowerCase() ||
    // O pooler regional é compartilhado: o projeto vem do usuário `postgres.<ref>`.
    cli.username !== app.username ||
    cli.pathname !== app.pathname
  ) {
    problems.add('DIRECT_URL');
  }
  return [...problems];
}

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
  let result: z.ZodSafeParseResult<z.infer<T>>;
  try {
    result = schema.safeParse(source);
  } catch {
    // Só uma exceção inesperada num refine chega aqui, e ela pode citar um valor.
    throw new Error('Falha ao validar as variáveis de ambiente.');
  }
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(
      ', ',
    );
    throw new Error(`Variáveis de ambiente inválidas ou ausentes: ${fields}`);
  }
  return result.data;
}

/** Ambiente da API, validado na subida da aplicação. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parseEnv(EnvSchema, source);
}
