import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ENV, type Env } from '../config/env.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RefreshTokensService } from './refresh-tokens.service.js';
import { RolesGuard } from './roles.guard.js';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_ACCESS_SECRET,
        signOptions: { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL_SECONDS },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
    // Limite global, por rota e por IP; /auth aperta o seu no controller.
    // Armazenamento em memória: suficiente para uma única instância no Render.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    RefreshTokensService,
    // A ordem importa: o rate limit vem antes de qualquer trabalho, e o
    // RolesGuard lê o usuário que o JwtAuthGuard anexa. Com `useExisting`, os
    // testes conseguem trocar o ThrottlerGuard por overrideGuard.
    ThrottlerGuard,
    { provide: APP_GUARD, useExisting: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
