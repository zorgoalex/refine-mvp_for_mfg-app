import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ProjectsModule } from '../projects.module';
import { ProjectOrderCreatedMonthCountsReportController } from './project-order-created-month-counts-report.controller';
import {
  PgProjectOrderCreatedMonthCountsReportRepository,
  UnavailableProjectOrderCreatedMonthCountsReportRepository,
} from './project-order-created-month-counts-report.repository';
import { ProjectOrderCreatedMonthCountsReportService } from './project-order-created-month-counts-report.service';

describe('ProjectsModule order-created-month-counts report wiring', () => {
  it('registers the order-created-month-counts route and providers', () => {
    const controllers = Reflect.getMetadata('controllers', ProjectsModule) ?? [];
    const providers = Reflect.getMetadata('providers', ProjectsModule) ?? [];

    expect(controllers).toContain(ProjectOrderCreatedMonthCountsReportController);
    const serviceProvider = providers.find((provider: unknown) => {
      if (!provider || typeof provider !== 'object') return false;
      return (provider as { provide?: unknown }).provide === ProjectOrderCreatedMonthCountsReportService;
    }) as { useFactory?: unknown } | undefined;

    expect(serviceProvider).toBeDefined();
    expect(String(serviceProvider?.useFactory)).toContain(PgProjectOrderCreatedMonthCountsReportRepository.name);
    expect(String(serviceProvider?.useFactory)).toContain(UnavailableProjectOrderCreatedMonthCountsReportRepository.name);
    expect(Reflect.getMetadata(PATH_METADATA, ProjectOrderCreatedMonthCountsReportController)).toBe(
      'projects/reports/order-created-month-counts',
    );
  });
});
