import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { MdfShadowComparisonService } from './application/mdf-shadow-comparison.service';
import { MdfJobScheduler } from './application/mdf-job-scheduler';
import { MdfJobRunner } from './application/mdf-job-runner';
import { executeMdfAcceptedJob } from './application/mdf-accepted-job';
import { PermissionsModule } from '../../permissions/permissions.module';
import { PermissionsService } from '../../permissions/permissions.service';
import { MdfPublishedBoardController } from './http/mdf-published-board.controller';
import { MdfPublishedBoardService } from './application/mdf-published-board.service';

@Module({ imports: [DatabaseModule,PermissionsModule], controllers: [MdfPublishedBoardController],
  providers: [{ provide: MdfShadowComparisonService,
  useFactory: (db: DatabaseService) => new MdfShadowComparisonService(db), inject: [DatabaseService] },
  { provide: MdfJobScheduler, useFactory: (db: DatabaseService) => new MdfJobScheduler(new MdfJobRunner(db,executeMdfAcceptedJob)),
    inject: [DatabaseService] },
  { provide: MdfPublishedBoardService,useFactory: (db: DatabaseService,permissions: PermissionsService) =>
    new MdfPublishedBoardService(db,permissions),inject: [DatabaseService,PermissionsService] }] })
export class MdfBoardModule {}
