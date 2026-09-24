import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import { RequirePermissions } from '../../permissions/require-permissions.decorator';
import { DailyDigestService } from './daily-digest.service';
import { parseDailyDigestRetryInput, parseDailyDigestRunInput, parseDailyDigestSettingsInput } from './daily-digest.dto';
import { WhatsAppPermissionsGuard } from './whatsapp-permissions.guard';

const READ_GATES = ['whatsapp.manage','calendar.view','orders.view','orders.view_financials'] as const;
const COMMAND_GATES = ['whatsapp.manage','calendar.view','orders.view','orders.view_financials'] as const;

@ApiTags('WhatsApp')
@ApiBearerAuth('bearerAuth')
@Controller('whatsapp/daily-digest')
@UseGuards(WhatsAppPermissionsGuard)
export class DailyDigestController {
  constructor(@Inject(DailyDigestService) private readonly service: DailyDigestService) {}

  @ApiOperation({summary:'Get daily WhatsApp digest settings and runtime availability'})
  @Get('settings') @RequirePermissions(READ_GATES)
  settings() { return this.service.settings(); }

  @ApiOperation({summary:'Update daily WhatsApp digest settings'})
  @Put('settings') @RequirePermissions(COMMAND_GATES)
  updateSettings(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.updateSettings(parseDailyDigestSettingsInput(body), user(request), requestId(request));
  }

  @ApiOperation({summary:'Render a private in-memory preview of today’s production orders'})
  @Post('preview') @HttpCode(200) @RequirePermissions(READ_GATES)
  async preview(@Res({passthrough:true}) response: Response) {
    response.setHeader('Cache-Control','private, no-store');
    return this.service.preview();
  }

  @ApiOperation({summary:'Queue a confirmed manual daily digest'})
  @Post('runs') @HttpCode(202) @RequirePermissions(COMMAND_GATES)
  createRun(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.createManual(parseDailyDigestRunInput(body),user(request),requestId(request)).then(run=>({run:run.run}));
  }

  @ApiOperation({summary:'List the latest safe daily digest run history'})
  @Get('runs') @RequirePermissions(READ_GATES)
  runs() { return this.service.listRuns(); }

  @ApiOperation({summary:'Get one daily digest run and per-page delivery state'})
  @Get('runs/:id') @RequirePermissions(READ_GATES)
  run(@Param('id') id: string) { return this.service.run(uuid(id)); }

  @ApiOperation({summary:'Read one unexpired private PNG page'})
  @Get('runs/:id/pages/:index/image') @RequirePermissions(READ_GATES)
  async image(@Param('id') id: string, @Param('index') index: string, @Res() response: Response) {
    const image = await this.service.image(uuid(id),positiveId(index));
    response.type('image/png').setHeader('Cache-Control','private, no-store').send(image.bytes);
  }

  @ApiOperation({summary:'Queue an explicitly confirmed retry of a completed or uncertain digest'})
  @Post('runs/:id/retry') @HttpCode(202) @RequirePermissions(COMMAND_GATES)
  retry(@Param('id') id: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.retry(uuid(id),parseDailyDigestRetryInput(body),user(request),requestId(request)).then(run=>({run:run.run}));
  }
}

function user(request: RequestWithCurrentUser) {
  if (!request.user) throw new ApiError(401,'AUTH_REQUIRED','Authentication required');
  return request.user;
}
function requestId(request: RequestWithCurrentUser) {
  if (!request.requestId) throw new ApiError(500,'INTERNAL_ERROR','Missing request id');
  return request.requestId;
}
function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(422,'VALIDATION_ERROR','Некорректный идентификатор запуска');
  return value;
}
function positiveId(value: string) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id > 500) throw new ApiError(422,'VALIDATION_ERROR','Некорректный номер страницы');
  return id;
}
