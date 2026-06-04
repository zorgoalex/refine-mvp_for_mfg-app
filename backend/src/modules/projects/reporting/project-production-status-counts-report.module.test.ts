import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ProjectsModule } from '../projects.module';
import { ProjectProductionStatusCountsReportController } from './project-production-status-counts-report.controller';
import {
  PgProjectProductionStatusCountsReportRepository,
  UnavailableProjectProductionStatusCountsReportRepository,
} from './project-production-status-counts-report.repository';
import { ProjectProductionStatusCountsReportService } from './project-production-status-counts-report.service';

describe('ProjectsModule production-status-counts report wiring', () => {
  it('registers the production-status-counts report route and providers', () => {
    const controllers = Reflect.getMetadata('controllers', ProjectsModule) ?? [];
    const providers = Reflect.getMetadata('providers', ProjectsModule) ?? [];

    expect(controllers).toContain(ProjectProductionStatusCountsReportController);
    const serviceProvider = providers.find((provider: unknown) => {
      if (!provider || typeof provider !== 'object') return false;
      return (provider as { provide?: unknown }).provide === ProjectProductionStatusCountsReportService;
    }) as { useFactory?: unknown } | undefined;
    expect(serviceProvider).toBeDefined();
    expect(String(serviceProvider?.useFactory)).toContain(PgProjectProductionStatusCountsReportRepository.name);
    expect(String(serviceProvider?.useFactory)).toContain(UnavailableProjectProductionStatusCountsReportRepository.name);
    expect(Reflect.getMetadata(PATH_METADATA, ProjectProductionStatusCountsReportController)).toBe(
      'projects/reports/production-status-counts',
    );
  });
});
