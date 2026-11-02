import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { RedisConnections } from './redis-connections';

/**
 * `@Global` з тієї ж причини, що DbModule: Redis потрібен кешу каталогу,
 * сесіям і ліміту, і перекладати модуль в `imports` кожного — шум.
 *
 * Фабрика асинхронна: пароль читається з файла (#11) до створення клієнтів.
 */
@Global()
@Module({
  providers: [
    {
      provide: RedisConnections,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => RedisConnections.fromConfig(config),
    },
  ],
  exports: [RedisConnections],
})
export class RedisModule {}
