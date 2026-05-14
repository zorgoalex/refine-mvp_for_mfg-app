import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { RateLimitService } from '../../rate-limit/rate-limit.service';
import { PgVlmProvider } from './adapters/pg-vlm-provider';
import { UnavailableVlmProvider } from './adapters/unavailable-vlm-provider';
import { VlmService } from './application/vlm.service';
import { VlmController } from './http/vlm.controller';
import { VlmRuntimeConfigService } from './http/vlm-runtime-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [VlmController],
  providers: [
    VlmRuntimeConfigService,
    {
      provide: VlmService,
      useFactory: (
        database: DatabaseService,
        config: ConfigService<BackendEnv, true>,
        rateLimits: RateLimitService,
      ) =>
        new VlmService({
          provider:
            database.isConfigured &&
            config.get('VLM_API_URL', { infer: true }) &&
            config.get('AUTH0_M2M_DOMAIN', { infer: true }) &&
            config.get('AUTH0_M2M_CLIENT_ID', { infer: true }) &&
            config.get('AUTH0_M2M_CLIENT_SECRET', { infer: true }) &&
            config.get('AUTH0_M2M_AUDIENCE', { infer: true })
              ? new PgVlmProvider(database, {
                  vlmApiUrl: config.get('VLM_API_URL', { infer: true }) ?? '',
                  auth0Domain: config.get('AUTH0_M2M_DOMAIN', { infer: true }) ?? '',
                  auth0ClientId: config.get('AUTH0_M2M_CLIENT_ID', { infer: true }) ?? '',
                  auth0ClientSecret: config.get('AUTH0_M2M_CLIENT_SECRET', { infer: true }) ?? '',
                  auth0Audience: config.get('AUTH0_M2M_AUDIENCE', { infer: true }) ?? '',
                  healthTimeoutMs: config.get('VLM_HEALTH_TIMEOUT_MS', { infer: true }),
                  uploadTimeoutMs: config.get('VLM_UPLOAD_TIMEOUT_MS', { infer: true }),
                  analyzeTimeoutMs: config.get('VLM_ANALYZE_TIMEOUT_MS', { infer: true }),
                  analyzeDailyLimit: config.get('VLM_ANALYZE_DAILY_LIMIT', { infer: true }),
                  rateLimits,
                })
              : new UnavailableVlmProvider(),
        }),
      inject: [DatabaseService, ConfigService, RateLimitService],
    },
  ],
})
export class VlmModule {}
