import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthResponse, AuthUser } from '@support-flow/shared';
import { Prisma, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { LoginDto, RegisterDto } from './auth.dto.js';
import type { AccessTokenPayload } from './auth.types.js';
import { hashPassword, verifyPassword } from './password.js';
import { RefreshTokensService } from './refresh-tokens.service.js';

/** Sessão completa: o refresh token vai para o cookie, o resto para o corpo. */
export interface Session extends AuthResponse {
  refreshToken: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  /**
   * Hash verificado quando o e-mail não existe, para que "e-mail inexistente" e
   * "senha errada" levem o mesmo tempo e não revelem quem tem conta.
   */
  private dummyHash = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly refreshTokens: RefreshTokensService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await hashPassword('senha-que-nenhum-usuario-tem');
  }

  /** Cadastro público: sempre cria CUSTOMER. Agentes e admin nascem por outros caminhos. */
  async register(dto: RegisterDto): Promise<Session> {
    const passwordHash = await hashPassword(dto.password);
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: { email: dto.email, name: dto.name, passwordHash, role: 'CUSTOMER' },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Este e-mail já está cadastrado.');
      }
      throw error;
    }
    return this.startSession(user);
  }

  async login(dto: LoginDto): Promise<Session> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const valid = await verifyPassword(user?.passwordHash ?? this.dummyHash, dto.password);
    if (!user || !valid) throw new UnauthorizedException('E-mail ou senha inválidos.');
    return this.startSession(user);
  }

  async refresh(refreshToken: string): Promise<Session> {
    const { userId, token } = await this.refreshTokens.rotate(refreshToken);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return this.buildSession(user, token);
  }

  logout(refreshToken: string): Promise<void> {
    return this.refreshTokens.revoke(refreshToken);
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return toAuthUser(user);
  }

  private async startSession(user: User): Promise<Session> {
    return this.buildSession(user, await this.refreshTokens.issue(user.id));
  }

  private async buildSession(user: User, refreshToken: string): Promise<Session> {
    const payload: AccessTokenPayload = { sub: user.id, role: user.role };
    const accessToken = await this.jwt.signAsync(payload);
    return { accessToken, refreshToken, user: toAuthUser(user) };
  }
}

function toAuthUser(user: User): AuthUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
