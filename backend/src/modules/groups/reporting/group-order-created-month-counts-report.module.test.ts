import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { GroupsModule } from '../groups.module';
import { GroupOrderCreatedMonthCountsReportController } from './group-order-created-month-counts-report.controller';
import {
  PgGroupOrderCreatedMonthCountsReportRepository,
  UnavailableGroupOrderCreatedMonthCountsReportRepository,
} from './group-order-created-month-counts-report.repository';
import { GroupOrderCreatedMonthCountsReportService } from './group-order-created-month-counts-report.service';

describe('GroupsModule order-created-month-counts report wiring', () => {
  it('registers the order-created-month-counts route and providers', () => {
    const controllers = Reflect.getMetadata('controllers', GroupsModule) ?? [];
    const providers = Reflect.getMetadata('providers', GroupsModule) ?? [];

    expect(controllers).toContain(GroupOrderCreatedMonthCountsReportController);
    const serviceProvider = providers.find((provider: unknown) => {
      if (!provider || typeof provider !== 'object') return false;
      return (provider as { provide?: unknown }).provide === GroupOrderCreatedMonthCountsReportService;
    }) as { useFactory?: unknown } | undefined;

    expect(serviceProvider).toBeDefined();
    expect(String(serviceProvider?.useFactory)).toContain(PgGroupOrderCreatedMonthCountsReportRepository.name);
    expect(String(serviceProvider?.useFactory)).toContain(UnavailableGroupOrderCreatedMonthCountsReportRepository.name);
    expect(Reflect.getMetadata(PATH_METADATA, GroupOrderCreatedMonthCountsReportController)).toBe(
      'groups/reports/order-created-month-counts',
    );
  });
});
