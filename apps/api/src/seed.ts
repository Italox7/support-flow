import 'dotenv/config';
import { parseEnv } from './config/env.js';
import { PrismaService } from './prisma/prisma.service.js';
import { AdminSeedEnvSchema, seedAdmin } from './users/seed-admin.js';

// Uso: `npm run db:seed -w @support-flow/api`, com ADMIN_EMAIL e ADMIN_PASSWORD no ambiente.
const env = parseEnv(AdminSeedEnvSchema);
const prisma = new PrismaService(env);

try {
  const result = await seedAdmin(prisma, env);
  console.log(result === 'created' ? 'Admin criado.' : 'Admin já existia; nada mudou.');
} finally {
  await prisma.$disconnect();
}
