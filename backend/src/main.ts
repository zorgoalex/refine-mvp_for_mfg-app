import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/errors/api-error.filter';
import { createRequestIdMiddleware } from './common/request-id/request-id.middleware';
import { createCorsRuntimeOptions, isOriginAllowed } from './config/cors';
import type { BackendEnv } from './config/env.validation';
import { setupSwagger } from './config/swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<BackendEnv, true>);
  const cors = createCorsRuntimeOptions({
    CORS_ALLOWED_ORIGINS: config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
    CORS_ALLOW_CREDENTIALS: config.get('CORS_ALLOW_CREDENTIALS', { infer: true }),
  });

  app.use(createRequestIdMiddleware(config.get('REQUEST_ID_HEADER', { infer: true })));
  app.useGlobalFilters(new ApiErrorFilter());
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
  });
  setupSwagger(app, {
    SWAGGER_ENABLED: config.get('SWAGGER_ENABLED', { infer: true }),
    SWAGGER_PATH: config.get('SWAGGER_PATH', { infer: true }),
  });

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
