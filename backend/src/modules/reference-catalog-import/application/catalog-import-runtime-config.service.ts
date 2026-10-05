import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';
@Injectable()
export class CatalogImportRuntimeConfigService {
  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService<BackendEnv, true>
  ) {}
  enabled(): boolean {
    return this.config.get('BACKEND_FILM_CATALOG_IMPORT_ENABLED', {
      infer: true,
    });
  }
}
