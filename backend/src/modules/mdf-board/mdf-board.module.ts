import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { MdfShadowComparisonService } from './application/mdf-shadow-comparison.service';

@Module({ imports: [DatabaseModule], providers: [{ provide: MdfShadowComparisonService,
  useFactory: (db: DatabaseService) => new MdfShadowComparisonService(db), inject: [DatabaseService] }] })
export class MdfBoardModule {}
