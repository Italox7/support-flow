import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthResponse, AuthUser } from '@support-flow/shared';
import type { Request, Response } from 'express';
import { CurrentUser, Public } from './auth.decorators.js';
import { LoginDto, RegisterDto } from './auth.dto.js';
import { AuthService, type Session } from './auth.service.js';
import type { RequestUser } from './auth.types.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-token.js';

/** /auth fica abaixo do limite global (ThrottlerGuard global, em AuthModule). */
const AUTH_THROTTLE = { default: { limit: 30, ttl: 60_000 } };
/** Limite mais apertado para as rotas que verificam senha (força bruta). */
const CREDENTIALS_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@Controller('auth')
@Throttle(AUTH_THROTTLE)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(CREDENTIALS_THROTTLE)
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return send(res, await this.auth.register(dto));
  }

  @Public()
  @Throttle(CREDENTIALS_THROTTLE)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return send(res, await this.auth.login(dto));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const token = readRefreshCookie(req);
    try {
      if (!token) throw new UnauthorizedException();
      return send(res, await this.auth.refresh(token));
    } catch (error) {
      clearRefreshCookie(res);
      throw error;
    }
  }

  /** Público de propósito: com o access token expirado, o usuário ainda precisa conseguir sair. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = readRefreshCookie(req);
    if (token) await this.auth.logout(token);
    clearRefreshCookie(res);
  }

  @Get('me')
  me(@CurrentUser() user: RequestUser): Promise<AuthUser> {
    return this.auth.me(user.id);
  }
}

/** Nenhum cache (navegador ou proxy) pode guardar uma resposta que carrega token. */
function send(res: Response, { refreshToken, ...body }: Session): AuthResponse {
  res.setHeader('Cache-Control', 'no-store');
  setRefreshCookie(res, refreshToken);
  return body;
}
