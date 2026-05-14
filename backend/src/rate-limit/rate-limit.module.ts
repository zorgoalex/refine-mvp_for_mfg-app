import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../config/env.validation';
import { MemoryRateLimitStore } from './memory-rate-limit.store';
import { RATE_LIMIT_STORE, RateLimitService } from './rate-limit.service';
import { RedisRateLimitStore } from './redis-rate-limit.store';

@Global()
@Module({
  providers: [
    {
      provide: RATE_LIMIT_STORE,
      useFactory: (config: ConfigService<BackendEnv, true>) => {
        if (config.get('BACKEND_RATE_LIMIT_STORE', { infer: true }) === 'redis') {
          return new RedisRateLimitStore({
            url:
              config.get('RATE_LIMIT_REDIS_URL', { infer: true }) ??
              config.get('REDIS_URL', { infer: true }) ??
              '',
          });
        }

        return new MemoryRateLimitStore();
      },
      inject: [ConfigService],
    },
    RateLimitService,
  ],
  exports: [RateLimitService],
})
export class RateLimitModule {}
