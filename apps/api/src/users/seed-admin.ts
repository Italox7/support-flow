import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import type { PrismaClient } from '../generated/prisma/client.js';

export const AdminSeedEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  ADMIN_PASSWORD: z.string().min(12).max(128),
  ADMIN_NAME: z.string().trim().min(1).max(100).default('Administrador'),
});

export type AdminSeedInput = Pick<
  z.infer<typeof AdminSeedEnvSchema>,
  'ADMIN_EMAIL' | 'ADMIN_PASSWORD' | 'ADMIN_NAME'
>;

export type AdminSeedResult = 'created' | 'unchanged';

/**
 * Cria o admin se ele não existir. Idempotente: rodar de novo não troca a senha
 * de um admin existente. Se o e-mail já pertence a uma conta que não é admin
 * (alguém se cadastrou com ele antes do seed), recusa: promover essa conta daria
 * o papel de admin a quem escolheu aquela senha.
 */
export async function seedAdmin(
  prisma: Pick<PrismaClient, 'user'>,
  input: AdminSeedInput,
): Promise<AdminSeedResult> {
  const existing = await prisma.user.findUnique({ where: { email: input.ADMIN_EMAIL } });
  if (existing) {
    if (existing.role !== 'ADMIN') {
      throw new Error(
        'O e-mail do admin já pertence a uma conta que não é admin. Use outro ADMIN_EMAIL ou remova a conta.',
      );
    }
    return 'unchanged';
  }

  await prisma.user.create({
    data: {
      email: input.ADMIN_EMAIL,
      name: input.ADMIN_NAME,
      passwordHash: await hashPassword(input.ADMIN_PASSWORD),
      role: 'ADMIN',
      isAvailable: false,
    },
  });
  return 'created';
}
