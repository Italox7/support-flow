import argon2 from 'argon2';

/**
 * argon2id com o mínimo recomendado pela OWASP (19 MiB, 2 iterações). Os
 * parâmetros padrão da lib (64 MiB) pesam demais na instância gratuita do Render
 * quando vários logins chegam juntos. Os parâmetros ficam gravados no próprio
 * hash, então aumentá-los depois não invalida as senhas existentes.
 */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

/** Nunca lança por hash malformado: trata como senha errada. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
