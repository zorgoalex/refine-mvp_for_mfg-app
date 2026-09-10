import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { CadClient } from './cad-client';
import { CadController } from './cad.controller';
import { CadService } from './cad.service';

@Module({ imports: [DatabaseModule], controllers: [CadController], providers: [{
  provide: CadService, inject: [DatabaseService, ConfigService],
  useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) => new CadService(database,
    new CadClient(config.get('CAD_SERVICE_BASE_URL', { infer: true }) ?? '', config.get('CAD_ERP_API_TOKEN', { infer: true }) ?? ''),
    config.get('BACKEND_ENABLE_CAD', { infer: true }), config.get('BACKEND_CAD_EDITOR_V2', { infer: true })),
}] })
export class CadModule {}
