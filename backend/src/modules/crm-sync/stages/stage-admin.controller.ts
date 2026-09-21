import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { PermissionsGuard } from '../../../permissions/permissions.guard';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { StageAdminService, stageSettingsSchema } from './stage-admin.service';
import { stageError } from './stage-policy';
import type { StageActor } from './stage-repository';

function data<T>(schema: z.ZodType<T>, input: unknown): T {
  const p = schema.safeParse(input);
  if (!p.success)
    throw stageError(
      'VALIDATION',
      'Некорректные параметры настройки стадий',
      422
    );
  return p.data;
}
function actor(r: RequestWithCurrentUser): StageActor {
  if (!r.user || !r.requestId)
    throw stageError('AUTH_REQUIRED', 'Требуется авторизация', 401);
  return { id: r.user.id, requestId: r.requestId };
}
const jobId = (id: string) => data(z.string().uuid(), id);

@ApiTags('Bitrix24')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@RequirePermissions('bitrix24.integration.manage')
@Controller('bitrix24/order-stages')
export class StageAdminController {
  constructor(
    @Inject(StageAdminService) private readonly service: StageAdminService
  ) {}
  @Get()
  @ApiOperation({ summary: 'Read order-stage settings and cached catalogs' })
  state() {
    return this.service.state();
  }
  @Post('catalog/refresh')
  @ApiOperation({
    summary: 'Refresh Bitrix funnel and stage catalogs without changing deals',
  })
  refresh(@Req() r: RequestWithCurrentUser) {
    return this.service.refresh(actor(r));
  }
  @Post('settings/preview')
  @ApiOperation({
    summary: 'Preview versioned order-stage settings and affected enrollment',
  })
  settingsPreview(@Body() body: unknown, @Req() r: RequestWithCurrentUser) {
    return this.service.previewSettings(
      data(stageSettingsSchema, body),
      actor(r)
    );
  }
  @Post('settings/:jobId/apply')
  @ApiOperation({ summary: 'Apply reviewed order-stage settings' })
  settingsApply(@Param('jobId') id: string, @Req() r: RequestWithCurrentUser) {
    return this.service.applySettings(jobId(id), actor(r));
  }
  @Post('provision/preview')
  @ApiOperation({ summary: 'Preview creation of missing ongoing stages' })
  provisionPreview(@Body() body: unknown, @Req() r: RequestWithCurrentUser) {
    const p = data(
      z
        .object({
          statusIds: z.array(z.number().int().positive()).min(1).max(20),
        })
        .strict(),
      body
    );
    return this.service.previewProvision(p.statusIds, actor(r));
  }
  @Post('provision/:jobId/apply')
  @ApiOperation({
    summary: 'Create reviewed ongoing stages with current Bitrix admin proof',
  })
  provisionApply(@Param('jobId') id: string, @Req() r: RequestWithCurrentUser) {
    return this.service.applyProvision(jobId(id), actor(r));
  }
  @Post('reconcile/preview')
  @ApiOperation({
    summary: 'Preview a bounded page of existing order-stage differences',
  })
  reconcilePreview(@Body() body: unknown, @Req() r: RequestWithCurrentUser) {
    const p = data(
      z
        .object({
          afterId: z.number().int().nonnegative().safe().default(0),
          limit: z.number().int().min(1).max(25).default(25),
          // Legacy clients/jobs paginate ascending; the new UI sends desc explicitly.
          sort: z.enum(['asc', 'desc']).default('asc'),
          orderId: z.number().int().positive().safe().optional(),
          orderName: z.string().trim().min(1).max(200).optional(),
        })
        .strict()
        .refine((p) => p.orderId === undefined || p.orderName === undefined),
      body
    );
    return this.service.previewReconcile(p.afterId, p.limit, actor(r), {
      sort: p.sort,
      orderId: p.orderId,
      orderName: p.orderName,
    });
  }
  @Post('reconcile/:jobId/apply')
  @ApiOperation({ summary: 'Enroll only approved unchanged order-stage rows' })
  reconcileApply(
    @Param('jobId') id: string,
    @Body() body: unknown,
    @Req() r: RequestWithCurrentUser
  ) {
    const p = data(
      z
        .object({
          orderIds: z
            .array(z.string().regex(/^[1-9][0-9]*$/))
            .min(1)
            .max(25),
        })
        .strict(),
      body
    );
    return this.service.applyReconcile(jobId(id), p.orderIds, actor(r));
  }
  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Read durable stage operation results' })
  job(@Param('jobId') id: string) {
    return this.service.job(jobId(id));
  }
  @Post('orders/:orderId/retry')
  @ApiOperation({ summary: 'Retry a blocked enrolled order-stage delivery' })
  retry(@Param('orderId') id: string, @Req() r: RequestWithCurrentUser) {
    return this.service.retry(
      data(z.string().regex(/^[1-9][0-9]*$/), id),
      actor(r)
    );
  }
}
