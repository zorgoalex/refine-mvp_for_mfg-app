import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

export interface SwaggerEnv {
  API_PREFIX: string;
  SWAGGER_ENABLED: boolean;
  SWAGGER_PATH: string;
}

export function setupSwagger(app: INestApplication, env: SwaggerEnv): void {
  if (!env.SWAGGER_ENABLED) {
    return;
  }

  const config = new DocumentBuilder()
    .setTitle('ERP Backend API')
    .setDescription('Stage-1 ERP backend API contract')
    .setVersion('0.1.0')
    .addServer(env.API_PREFIX, 'Current versioned API')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(env.SWAGGER_PATH.replace(/^\//, ''), app, document);
}
