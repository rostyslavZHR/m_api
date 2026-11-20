import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { DataSource } from 'typeorm';
import type { ApiEnv } from '../config/env.schema.js';
import { DbModule } from '../db/db.module.js';
import { UsersRepository } from '../users/users.repository.js';
import { AccessTokenGuard, VERIFICATION_KEYS } from './access-token.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { RefreshTokensRepository } from './refresh-tokens.repository.js';

@Module({
  imports: [DbModule],
  controllers: [AuthController],
  providers: [
    {
      provide: UsersRepository,
      useFactory: (dataSource: DataSource) => new UsersRepository(dataSource.manager),
      inject: [DataSource],
    },
    {
      provide: RefreshTokensRepository,
      useFactory: (dataSource: DataSource) => new RefreshTokensRepository(dataSource.manager),
      inject: [DataSource],
    },
    AuthService,
    // { kid: public key }: this environment's key today. A rotation adds the new key
    // here (and keeps the old one until its last token expires): see the README.
    {
      provide: VERIFICATION_KEYS,
      useFactory: (config: ConfigService<ApiEnv, true>) =>
        new Map([[config.get('JWT_KID', { infer: true }), config.get('JWT_PUBLIC_KEY', { infer: true })]]),
      inject: [ConfigService],
    },
    // Global: every route of the app requires a token unless marked @Public().
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
  // The key map, for the WebSocket gateway's own handshake check.
  exports: [VERIFICATION_KEYS],
})
export class AuthModule {}
