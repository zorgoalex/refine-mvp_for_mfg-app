import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ProjectsModule } from '../projects.module';
import { ProjectDeadlineStatusCountsReportController } from './project-deadline-status-counts-report.controller';
import {
  PgProjectDeadlineStatusCountsReportRepository,
  UnavailableProjectDeadlineStatusCountsReportRepository,
} from './project-deadline-status-counts-report.repository';
import { ProjectDeadlineStatusCountsReportService } from './project-deadline-status-counts-report.service';

describe('ProjectsModule deadline-status-counts report wiring', () => {
  it('registers the deadline-status-counts report route and providers', () => {
    const controllers = Reflect.getMetadata('controllers', ProjectsModule) ?? [];
    const providers = Reflect.getMetadata('providers', ProjectsModule) ?? [];

    expect(controllers).toContain(ProjectDeadlineStatusCountsReportController);
    const serviceProvider = providers.find((provider: unknown) => {
      if (!provider || typeof provider !== 'object') return false;
      return (provider as { provide?: unknown }).provide === ProjectDeadlineStatusCountsReportService;
    }) as { useFactory?: unknown } | undefined;
    expect(serviceProvider).toBeDefined();
    expect(String(serviceProvider?.useFactory)).toContain(PgProjectDeadlineStatusCountsReportRepository.name);
    expect(String(serviceProvider?.useFactory)).toContain(UnavailableProjectDeadlineStatusCountsReportRepository.name);
    expect(Reflect.getMetadata(PATH_METADATA, ProjectDeadlineStatusCountsReportController)).toBe(
      'projects/reports/deadline-status-counts',
    );
  });
});
