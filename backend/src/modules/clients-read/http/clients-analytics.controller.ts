import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ClientsAnalyticsService } from '../application/clients-analytics.service';
import {
  CLIENTS_DASHBOARD_MAX_DAYS,
  type ClientAnalyticsCardDto,
  type ClientsDashboardDto,
  type ClientsDashboardQuery,
} from '../application/clients-analytics.types';

const DAY_MS = 86_400_000;
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'not a calendar date');

const dashboardSchema = z.object({
  dateFrom: calendarDate,
  dateTo: calendarDate,
  personType: z.enum(['individual', 'legal']).optional(),
}).strict().superRefine((value, context) => {
  const days = (Date.parse(`${value.dateTo}T00:00:00Z`) - Date.parse(`${value.dateFrom}T00:00:00Z`)) / DAY_MS + 1;
  if (days < 1) context.addIssue({ code: 'custom', path: ['dateTo'], message: 'dateTo is before dateFrom' });
  if (days > CLIENTS_DASHBOARD_MAX_DAYS) context.addIssue({ code: 'custom', path: ['dateTo'], message: 'period is too long' });
});

/** «+Клиенты (аналитика)»: the dashboard and the card of one client. Read-only; rights are checked in the service. */
@ApiTags('Client Phones')
@ApiBearerAuth('bearerAuth')
@Controller('clients-analytics')
export class ClientsAnalyticsController {
  constructor(@Inject(ClientsAnalyticsService) private readonly analytics: ClientsAnalyticsService) {}

  @ApiOperation({ operationId: 'getClientsAnalyticsDashboard', summary: 'Clients dashboard: new and buying clients, orders by day, segments, top and sleeping clients' })
  @Get('dashboard')
  dashboard(@Req() request: RequestWithCurrentUser, @Query() query: unknown): Promise<ClientsDashboardDto> {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const parsed = dashboardSchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректные параметры дашборда клиентов', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.') || issue.code),
      });
    }
    return this.analytics.dashboard(request.user, parsed.data as ClientsDashboardQuery, request.requestId ?? randomUUID());
  }

  @ApiOperation({ operationId: 'getClientAnalyticsCard', summary: 'Analytics card of one client: totals, months, orders, payments' })
  @Get('clients/:clientId')
  card(@Req() request: RequestWithCurrentUser, @Param('clientId') value: string): Promise<ClientAnalyticsCardDto> {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const clientId = /^\d{1,15}$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(clientId) || clientId <= 0) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Клиент не найден');
    return this.analytics.card(request.user, clientId, request.requestId ?? randomUUID());
  }
}
