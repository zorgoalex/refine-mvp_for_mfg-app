import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ProjectsModule } from '../projects.module';
import { ProjectOrderRelationCountsReportController } from './project-order-relation-counts-report.controller';
import {
  PgProjectOrderRelationCountsReportRepository,
  UnavailableProjectOrderRelationCountsReportRepository,
} from './project-order-relation-counts-report.repository';
import { ProjectOrderRelationCountsReportService } from './project-order-relation-counts-report.service';

describe('ProjectsModule relation-counts report wiring', () => {
  it('registers the order relation-counts report route and providers', () => {
    const controllers = Reflect.getMetadata('controllers', ProjectsModule) ?? [];
    const providers = Reflect.getMetadata('providers', ProjectsModule) ?? [];

    expect(controllers).toContain(ProjectOrderRelationCountsReportController);
    const serviceProvider = providers.find((provider: unknown) => {
      if (!provider || typeof provider !== 'object') return false;
      return (provider as { provide?: unknown }).provide === ProjectOrderRelationCountsReportService;
    }) as { useFactory?: unknown } | undefined;
    expect(serviceProvider).toBeDefined();
    expect(String(serviceProvider?.useFactory)).toContain(PgProjectOrderRelationCountsReportRepository.name);
    expect(String(serviceProvider?.useFactory)).toContain(UnavailableProjectOrderRelationCountsReportRepository.name);
    expect(Reflect.getMetadata(PATH_METADATA, ProjectOrderRelationCountsReportController)).toBe(
      'projects/reports/order-relation-counts',
    );
  });
});
