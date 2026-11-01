import { randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { generateRefreshToken, hashRefreshToken, REFRESH_TOKEN_TTL_MS } from './refresh-token.js';

/**
 * Refresh tokens rotativos com detecção de reuso. Cada login abre uma família;
 * cada refresh revoga o token apresentado e emite outro na mesma família. Se um
 * token já revogado reaparece, alguém guardou uma cópia: a família inteira é
 * revogada e o usuário legítimo precisa entrar de novo.
 */
@Injectable()
export class RefreshTokensService {
  constructor(private readonly prisma: PrismaService) {}

  /** Emite um token numa família nova (login/cadastro) ou existente (rotação). */
  async issue(userId: string, familyId: string = randomUUID()): Promise<string> {
    const token = generateRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashRefreshToken(token),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });
    return token;
  }

  /** Troca um token válido por um novo. Lança 401 em qualquer falha. */
  async rotate(token: string): Promise<{ userId: string; token: string }> {
    const now = new Date();
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
    });
    if (!record) throw new UnauthorizedException();

    if (record.revokedAt) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedException();
    }
    if (record.expiresAt <= now) throw new UnauthorizedException();

    const rotated = await this.prisma.$transaction(async (tx) => {
      // Condicional em revokedAt: de duas requisições simultâneas com o mesmo
      // token, só uma consegue revogá-lo. A outra é tratada como reuso.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: record.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (count === 0) return null;

      const next = generateRefreshToken();
      await tx.refreshToken.create({
        data: {
          userId: record.userId,
          familyId: record.familyId,
          tokenHash: hashRefreshToken(next),
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
        },
      });
      return { userId: record.userId, token: next };
    });

    // Fora da transação: lançar dentro dela desfaria a revogação.
    if (!rotated) {
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedException();
    }
    return rotated;
  }

  /** Logout: revoga a família do token, se ele existir. Nunca lança. */
  async revoke(token: string): Promise<void> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
      select: { familyId: true },
    });
    if (record) await this.revokeFamily(record.familyId);
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
