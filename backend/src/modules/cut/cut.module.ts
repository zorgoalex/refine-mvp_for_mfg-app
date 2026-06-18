import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { FreecutClient } from './adapters/freecut-client';
import { PgCutRepository } from './adapters/pg-cut-repository';
import { UnavailableCutRepository } from './adapters/unavailable-cut-repository';
import { CutService } from './application/cut.service';
import { CutConfigAdminService } from './application/cut-config-admin.service';
import { CutPdfCache } from './application/cut-pdf-cache';
import { PgCutConfigAdminRepository } from './adapters/pg-cut-config-admin-repository';
import { UnavailableCutConfigAdminRepository } from './adapters/unavailable-cut-config-admin-repository';
import { CutRuntimeConfigService } from './http/cut-runtime-config.service';
import { CutController } from './http/cut.controller';
import { CutConfigController } from './http/cut-config.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [CutController, CutConfigController],
  providers: [
    CutRuntimeConfigService,
    CutPdfCache,
    {
      provide: CutService,
      useFactory: (database: DatabaseService, runtimeConfig: CutRuntimeConfigService) => {
        if (!database.isConfigured) {
          return new CutService({ cut: new UnavailableCutRepository() });
        }
        const freecut = new FreecutClient({
          baseUrl: runtimeConfig.getFreecutBaseUrl() ?? '',
          timeoutMs: runtimeConfig.getFreecutTimeoutMs(),
        });
        return new CutService({ cut: new PgCutRepository(database, freecut) });
      },
      inject: [DatabaseService, CutRuntimeConfigService],
    },
    {
      provide: CutConfigAdminService,
      useFactory: (database: DatabaseService) => {
        if (!database.isConfigured) {
          return new CutConfigAdminService({ config: new UnavailableCutConfigAdminRepository() });
        }
        return new CutConfigAdminService({ config: new PgCutConfigAdminRepository(database) });
      },
      inject: [DatabaseService],
    },
  ],
})
export class CutModule {}
