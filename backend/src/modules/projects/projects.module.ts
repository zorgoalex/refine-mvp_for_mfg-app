import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgProjectsRepository } from './adapters/pg-projects-repository';
import { UnavailableProjectsRepository } from './adapters/unavailable-projects-repository';
import { ProjectsService } from './application/projects.service';
import { OrderProjectController } from './http/order-project.controller';
import { ProjectsController } from './http/projects.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [ProjectsController, OrderProjectController],
  providers: [
    {
      provide: ProjectsService,
      useFactory: (database: DatabaseService) =>
        new ProjectsService({
          projects: database.isConfigured ? new PgProjectsRepository(database) : new UnavailableProjectsRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class ProjectsModule {}
