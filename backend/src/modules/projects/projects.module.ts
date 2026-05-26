import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgProjectRepository, UnavailableProjectRepository } from './project.repository';
import { ProjectsController } from './projects.controller';
import { ProjectsRuntimeConfigService } from './projects-runtime-config.service';
import { ProjectsService } from './projects.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ProjectsController],
  providers: [
    ProjectsRuntimeConfigService,
    {
      provide: ProjectsService,
      useFactory: (database: DatabaseService) =>
        new ProjectsService({
          projects: database.isConfigured
            ? new PgProjectRepository(database)
            : new UnavailableProjectRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class ProjectsModule {}
