import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { GroupsModule } from '../groups.module';
import { GroupProductionStatusCountsReportController } from './group-production-status-counts-report.controller';
import {
  PgGroupProductionStatusCountsReportRepository,
  UnavailableGroupProductionStatusCountsReportRepository,
} from './group-production-status-counts-report.repository';
import { GroupProductionStatusCountsReportService } from './group-production-status-counts-report.service';

describe('GroupsModule production-status-counts report wiring', () => {
  it('registers the production-status-counts report route and providers', () => {
    const controllers = Reflect.getMetadata('controllers', GroupsModule) ?? [];
    const providers = Reflect.getMetadata('providers', GroupsModule) ?? [];

    expect(controllers).toContain(GroupProductionStatusCountsReportController);
    const serviceProvider = providers.find((provider: unknown) => {
      if (!provider || typeof provider !== 'object') return false;
      return (provider as { provide?: unknown }).provide === GroupProductionStatusCountsReportService;
    }) as { useFactory?: unknown } | undefined;
    expect(serviceProvider).toBeDefined();
    expect(String(serviceProvider?.useFactory)).toContain(PgGroupProductionStatusCountsReportRepository.name);
    expect(String(serviceProvider?.useFactory)).toContain(UnavailableGroupProductionStatusCountsReportRepository.name);
    expect(Reflect.getMetadata(PATH_METADATA, GroupProductionStatusCountsReportController)).toBe(
      'groups/reports/production-status-counts',
    );
  });
});
