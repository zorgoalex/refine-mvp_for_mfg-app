import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { GroupsModule } from '../groups.module';
import { GroupOrderRelationCountsReportController } from './group-order-relation-counts-report.controller';
import {
  PgGroupOrderRelationCountsReportRepository,
  UnavailableGroupOrderRelationCountsReportRepository,
} from './group-order-relation-counts-report.repository';
import { GroupOrderRelationCountsReportService } from './group-order-relation-counts-report.service';

describe('GroupsModule relation-counts report wiring', () => {
  it('registers the order relation-counts report route and providers', () => {
    const controllers = Reflect.getMetadata('controllers', GroupsModule) ?? [];
    const providers = Reflect.getMetadata('providers', GroupsModule) ?? [];

    expect(controllers).toContain(GroupOrderRelationCountsReportController);
    const serviceProvider = providers.find((provider: unknown) => {
      if (!provider || typeof provider !== 'object') return false;
      return (provider as { provide?: unknown }).provide === GroupOrderRelationCountsReportService;
    }) as { useFactory?: unknown } | undefined;
    expect(serviceProvider).toBeDefined();
    expect(String(serviceProvider?.useFactory)).toContain(PgGroupOrderRelationCountsReportRepository.name);
    expect(String(serviceProvider?.useFactory)).toContain(UnavailableGroupOrderRelationCountsReportRepository.name);
    expect(Reflect.getMetadata(PATH_METADATA, GroupOrderRelationCountsReportController)).toBe(
      'groups/reports/order-relation-counts',
    );
  });
});
