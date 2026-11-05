import { existsSync } from 'node:fs';
import { loadEnv, SUPABASE_CA_PATH } from './config/env.js';

// Guarda do build no Render, antes do migrate: uma URL errada não pode chegar ao
// schema engine. Sem dotenv, de propósito: só vale o ambiente do deploy. Aplica as
// regras de produção em qualquer máquina e nunca imprime valores.
try {
  loadEnv({ ...process.env, NODE_ENV: 'production' });
  // O build roda da raiz do repositório, e o cwd da aplicação é apps/api: o
  // caminho parte deste arquivo, em apps/api/dist.
  if (!existsSync(new URL(`../${SUPABASE_CA_PATH}`, import.meta.url))) {
    throw new Error('CA do Supabase ausente em apps/api/certs.');
  }
  console.log('Ambiente de deploy válido.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Falha ao validar o ambiente de deploy.');
  process.exit(1);
}
