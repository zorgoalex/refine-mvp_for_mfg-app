import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { GroupsModule } from '../groups.module';
import { GroupDeadlineStatusCountsReportController } from './group-deadline-status-counts-report.controller';
import {
  PgGroupDeadlineStatusCountsReportRepository,
  UnavailableGroupDeadlineStatusCountsReportRepository,
} from './group-deadline-status-counts-report.repository';
import { GroupDeadlineStatusCountsReportService } from './group-deadline-status-counts-report.service';

describe('GroupsModule deadline-status-counts report wiring', () => {
  it('registers the deadline-status-counts report route and providers', () => {
    const controllers = Reflect.getMetadata('controllers', GroupsModule) ?? [];
    const providers = Reflect.getMetadata('providers', GroupsModule) ?? [];

    expect(controllers).toContain(GroupDeadlineStatusCountsReportController);
    const serviceProvider = providers.find((provider: unknown) => {
      if (!provider || typeof provider !== 'object') return false;
      return (provider as { provide?: unknown }).provide === GroupDeadlineStatusCountsReportService;
    }) as { useFactory?: unknown } | undefined;
    expect(serviceProvider).toBeDefined();
    expect(String(serviceProvider?.useFactory)).toContain(PgGroupDeadlineStatusCountsReportRepository.name);
    expect(String(serviceProvider?.useFactory)).toContain(UnavailableGroupDeadlineStatusCountsReportRepository.name);
    expect(Reflect.getMetadata(PATH_METADATA, GroupDeadlineStatusCountsReportController)).toBe(
      'groups/reports/deadline-status-counts',
    );
  });
});
