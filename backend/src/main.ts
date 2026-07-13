import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/errors/api-error.filter';
import { createRequestIdMiddleware } from './common/request-id/request-id.middleware';
import { toNestGlobalPrefix } from './config/api-prefix';
import { createCorsRuntimeOptions, isOriginAllowed } from './config/cors';
import type { BackendEnv } from './config/env.validation';
import { setupSwagger } from './config/swagger';
import { assertFontAvailable } from './modules/cut/render/sheet-png';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  const config = app.get(ConfigService<BackendEnv, true>);

  // Fail-fast if the cut-render font is missing while cut jobs are enabled:
  // resvg silently drops <text> without it (plan §7 MINOR-16).
  if (config.get('BACKEND_ENABLE_CUT_JOBS', { infer: true })) {
    assertFontAvailable();
  }

  const cors = createCorsRuntimeOptions({
    CORS_ALLOWED_ORIGINS: config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
    CORS_ALLOW_CREDENTIALS: config.get('CORS_ALLOW_CREDENTIALS', { infer: true }),
  });

  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));
  app.use(createRequestIdMiddleware(config.get('REQUEST_ID_HEADER', { infer: true })));
  app.useGlobalFilters(new ApiErrorFilter());
  app.setGlobalPrefix(toNestGlobalPrefix(config.get('API_PREFIX', { infer: true })), {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      if (isOriginAllowed(origin, cors.origins)) {
        callback(null, true);
        return;
      }

      callback(new Error('CORS origin denied'), false);
    },
    credentials: cors.credentials,
    exposedHeaders: ['Content-Disposition'],
  });
  setupSwagger(app, {
    API_PREFIX: config.get('API_PREFIX', { infer: true }),
    SWAGGER_ENABLED: config.get('SWAGGER_ENABLED', { infer: true }),
    SWAGGER_PATH: config.get('SWAGGER_PATH', { infer: true }),
  });

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
