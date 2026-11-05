import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// A CLI (migrate, studio) usa o session pooler (porta 5432), que tem IPv4 e aceita
// o que as migrations precisam; a aplicação usa o transaction pooler (6543).
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
