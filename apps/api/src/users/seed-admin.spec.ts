import { describe, expect, it, vi } from 'vitest';
import { verifyPassword } from '../auth/password.js';
import { AdminSeedEnvSchema, seedAdmin, type AdminSeedInput } from './seed-admin.js';

const input: AdminSeedInput = {
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'uma-senha-longa',
  ADMIN_NAME: 'Admin',
};

function fakePrisma(existing: { role: string } | null) {
  const user = {
    findUnique: vi.fn().mockResolvedValue(existing),
    create: vi.fn().mockResolvedValue({}),
  };
  return { user } as unknown as Parameters<typeof seedAdmin>[0] & { user: typeof user };
}

describe('seedAdmin', () => {
  it('cria o admin com senha em hash e fora da atribuição automática', async () => {
    const prisma = fakePrisma(null);
    await expect(seedAdmin(prisma, input)).resolves.toBe('created');

    const { data } = prisma.user.create.mock.calls[0]![0];
    expect(data).toMatchObject({ email: input.ADMIN_EMAIL, role: 'ADMIN', isAvailable: false });
    expect(data.passwordHash).not.toBe(input.ADMIN_PASSWORD);
    await expect(verifyPassword(data.passwordHash, input.ADMIN_PASSWORD)).resolves.toBe(true);
  });

  it('não muda nada se o admin já existe', async () => {
    const prisma = fakePrisma({ role: 'ADMIN' });
    await expect(seedAdmin(prisma, input)).resolves.toBe('unchanged');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('recusa promover uma conta comum que já usa o e-mail do admin', async () => {
    const prisma = fakePrisma({ role: 'CUSTOMER' });
    await expect(seedAdmin(prisma, input)).rejects.toThrow(/não é admin/);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe('AdminSeedEnvSchema', () => {
  const env = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    ADMIN_EMAIL: ' Admin@Example.COM ',
    ADMIN_PASSWORD: 'uma-senha-longa',
  };

  it('normaliza o e-mail e aplica o nome padrão', () => {
    expect(AdminSeedEnvSchema.parse(env)).toMatchObject({
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_NAME: 'Administrador',
    });
  });

  it('exige senha com pelo menos 12 caracteres', () => {
    expect(AdminSeedEnvSchema.safeParse({ ...env, ADMIN_PASSWORD: 'curta' }).success).toBe(false);
  });
});
