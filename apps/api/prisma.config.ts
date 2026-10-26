import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// A CLI (migrate, studio) usa a conexão direta: migrations não passam pelo pooler.
// `prisma generate` não precisa de banco, então a URL é opcional aqui; o CI gera o
// client sem nenhuma variável definida.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
