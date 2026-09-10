import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({ imports: [DatabaseModule], controllers: [CatalogController], providers: [
  { provide: CatalogService, useFactory: (database: DatabaseService) => new CatalogService(database), inject: [DatabaseService] },
] })
export class CatalogModule {}
