import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';

describe('password', () => {
  it('gera hash argon2id que só confere com a senha certa', async () => {
    const hash = await hashPassword('senha-correta');
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, 'senha-correta')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'senha-errada')).resolves.toBe(false);
  });

  it('trata hash malformado como senha errada', async () => {
    await expect(verifyPassword('nao-e-um-hash', 'qualquer')).resolves.toBe(false);
  });
});

describe('refresh token', () => {
  it('gera tokens únicos de 256 bits', () => {
    const a = generateRefreshToken();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(generateRefreshToken()).not.toBe(a);
  });

  it('hash é determinístico e não contém o token', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toContain(token);
  });
});
