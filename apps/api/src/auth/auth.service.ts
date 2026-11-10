import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthResponse, AuthUser } from '@support-flow/shared';
import { ENV, type Env } from '../config/env.js';
import { Prisma, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { LoginDto, RegisterDto } from './auth.dto.js';
import type { AccessTokenPayload } from './auth.types.js';
import { DEMO_EMAILS as DEMO_EMAIL_BY_ROLE } from './demo-emails.js';
import { LoginAttempts, LoginLockedException } from './login-attempts.js';
import { hashPassword, verifyPassword } from './password.js';
import { RefreshTokensService } from './refresh-tokens.service.js';

/** Sessão completa: o refresh token vai para o cookie, o resto para o corpo. */
export interface Session extends AuthResponse {
  refreshToken: string;
}

/**
 * Contas da demo, fora do limite por e-mail quando a demo está ligada: a senha
 * delas é pública, então o limite não protege nada e só deixaria alguém travar a
 * demo para os visitantes. A lista também é pública: isentá-la não revela nada.
 * Sai da constante, nunca do papel lido no banco.
 */
const DEMO_EMAILS: ReadonlySet<string> = new Set(Object.values(DEMO_EMAIL_BY_ROLE));

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
    private readonly attempts: LoginAttempts,
    @Inject(ENV) private readonly env: Pick<Env, 'DEMO_RESET_ENABLED'>,
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

  /**
   * A reserva da falha vem antes do banco e do argon2: bloqueado, responde 429
   * rápido e igual para e-mail existente e inexistente. Só a senha errada confirma
   * a falha; o sucesso e qualquer outro erro (fila cheia, banco) devolvem a vaga.
   */
  async login(dto: LoginDto): Promise<Session> {
    const exempt = this.env.DEMO_RESET_ENABLED && DEMO_EMAILS.has(dto.email);
    const reservation = exempt ? null : this.attempts.reserve(dto.email);
    if (reservation && !reservation.ok) throw new LoginLockedException(reservation.retryAfterSec);
    let user: User | null;
    try {
      user = await this.prisma.user.findUnique({ where: { email: dto.email } });
      const valid = await verifyPassword(user?.passwordHash ?? this.dummyHash, dto.password);
      if (!user || !valid) user = null;
    } catch (error) {
      reservation?.release();
      throw error;
    }
    if (!user) {
      reservation?.fail();
      throw new UnauthorizedException('E-mail ou senha inválidos.');
    }
    reservation?.release();
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
