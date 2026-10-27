import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PaymentsAnalyticsService } from '../application/payments-analytics.service';
import {
  PAYMENTS_ANALYTICS_MAX_DAYS,
  PAYMENTS_DASHBOARD_MAX_DAYS,
  type PaymentsAnalyticsSummaryDto,
  type PaymentsAnalyticsSummaryQuery,
  type PaymentsDashboardDto,
  type PaymentsDashboardQuery,
} from '../application/payments-analytics.types';

const DAY_MS = 86_400_000;
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'not a calendar date');
const text = z.string().trim().min(1).max(200);
const money = z.coerce.number().finite().min(-1e12).max(1e12);

function checkPeriod(value: { dateFrom: string; dateTo: string }, maxDays: number, context: z.RefinementCtx): void {
  const days = (Date.parse(`${value.dateTo}T00:00:00Z`) - Date.parse(`${value.dateFrom}T00:00:00Z`)) / DAY_MS + 1;
  if (days < 1) context.addIssue({ code: 'custom', path: ['dateTo'], message: 'dateTo is before dateFrom' });
  if (days > maxDays) context.addIssue({ code: 'custom', path: ['dateTo'], message: 'period is too long' });
}

const summarySchema = z.object({
  dateFrom: calendarDate,
  dateTo: calendarDate,
  orderName: text.optional(),
  clientName: text.optional(),
  notes: text.optional(),
  typePaidName: text.optional(),
  orderStatusName: text.optional(),
  paymentStatusName: text.optional(),
  productionStatusName: text.optional(),
  orderDateFrom: calendarDate.optional(),
  orderDateTo: calendarDate.optional(),
  amountMin: money.optional(),
  amountMax: money.optional(),
  orderAmountMin: money.optional(),
  orderAmountMax: money.optional(),
  totalPaymentsMin: money.optional(),
  totalPaymentsMax: money.optional(),
  orderBalanceMin: money.optional(),
  orderBalanceMax: money.optional(),
}).strict().superRefine((value, context) => checkPeriod(value, PAYMENTS_ANALYTICS_MAX_DAYS, context));

const dashboardSchema = z.object({ dateFrom: calendarDate, dateTo: calendarDate })
  .strict()
  .superRefine((value, context) => checkPeriod(value, PAYMENTS_DASHBOARD_MAX_DAYS, context));

/**
 * «+Платежи (аналитика)»: totals of a period by payment type and by day. Read-only; the rights
 * (`finance.analytics.view` + unrestricted payment visibility) are checked in the service.
 */
@ApiTags('Payments')
@ApiBearerAuth('bearerAuth')
@Controller('payments-analytics')
export class PaymentsAnalyticsController {
  constructor(@Inject(PaymentsAnalyticsService) private readonly analytics: PaymentsAnalyticsService) {}

  @ApiOperation({ operationId: 'getPaymentsAnalyticsSummary', summary: 'Payments of a period: total, by payment type, by day' })
  @Get('summary')
  summary(@Req() request: RequestWithCurrentUser, @Query() query: unknown): Promise<PaymentsAnalyticsSummaryDto> {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const parsed = summarySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректные параметры аналитики платежей', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.') || issue.code),
      });
    }
    return this.analytics.summary(request.user, parsed.data as PaymentsAnalyticsSummaryQuery, request.requestId ?? randomUUID());
  }

  @ApiOperation({ operationId: 'getPaymentsAnalyticsDashboard', summary: 'Payments dashboard: by day, by type, refunds, receivables by age, top debtors' })
  @Get('dashboard')
  dashboard(@Req() request: RequestWithCurrentUser, @Query() query: unknown): Promise<PaymentsDashboardDto> {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const parsed = dashboardSchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Некорректный период дашборда платежей', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.') || issue.code),
      });
    }
    return this.analytics.dashboard(request.user, parsed.data as PaymentsDashboardQuery, request.requestId ?? randomUUID());
  }
}
