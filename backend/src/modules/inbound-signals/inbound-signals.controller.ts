import { Body, Controller, Get, Headers, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import { RequirePermissions } from '../../permissions/require-permissions.decorator';
import { InboundSignalsService } from './inbound-signals.service';

@ApiTags('Inbound signals')
@ApiBearerAuth()
@Controller('')
export class InboundSignalsController {
  constructor(@Inject(InboundSignalsService) private readonly service: InboundSignalsService) {}
  @Get('inbound-signals') @RequirePermissions('message_signals.view')
  @ApiOperation({ operationId: 'listInboundSignals', summary: 'List scoped inbound signals' })
  list(@Query() query: Record<string, unknown>, @Req() req: RequestWithCurrentUser) { return this.service.list(query,user(req)); }
  @Get('inbound-signals/order-options') @RequirePermissions('message_signals.resolve')
  @ApiOperation({ operationId: 'inboundSignalOrderOptions', summary: 'Search visible orders for resolution' })
  orders(@Query('q') q: string|undefined,@Req() req: RequestWithCurrentUser) { return this.service.orderOptions(typeof q === 'string' ? q : '',user(req)); }
  @Get('inbound-signals/:id') @RequirePermissions('message_signals.view')
  @ApiOperation({ operationId: 'getInboundSignal', summary: 'Get scoped signal evidence' })
  detail(@Param('id') id: string,@Req() req: RequestWithCurrentUser) { return this.service.detail(validId(id),user(req)); }
  @Post('inbound-signals/:id/resolve-preview') @RequirePermissions('message_signals.resolve')
  @ApiOperation({ operationId: 'previewInboundSignalResolution', summary: 'Preview resolution without changing business state' })
  preview(@Param('id') id: string,@Body() body: unknown,@Req() req: RequestWithCurrentUser) { return this.service.previewResolve(validId(id),body,user(req)); }
  @Post('inbound-signals/:id/:action') @RequirePermissions('message_signals.resolve')
  @ApiOperation({ operationId: 'commandInboundSignal', summary: 'Resolve, dismiss or retry a signal idempotently' })
  command(@Param('id') id: string,@Param('action') action: string,@Body() body: unknown,@Headers('idempotency-key') key: string|undefined,@Req() req: RequestWithCurrentUser) {
    if (action !== 'resolve' && action !== 'dismiss' && action !== 'retry') throw new ApiError(404,'NOT_FOUND','Действие не найдено');
    return this.service.command(validId(id),action,body,key,user(req),requestId(req));
  }
  @Get('message-processing/configuration') @RequirePermissions('message_signals.manage_config')
  @ApiOperation({ operationId: 'getMessageProcessingConfiguration', summary: 'Get sources, signals, rules and templates' })
  configuration(@Req() req: RequestWithCurrentUser) { return this.service.getConfiguration(user(req)); }
  @Put('message-processing/configuration') @RequirePermissions('message_signals.manage_config')
  @ApiOperation({ operationId: 'saveMessageProcessingConfiguration', summary: 'Save versioned configuration atomically' })
  save(@Body() body: unknown,@Req() req: RequestWithCurrentUser) { return this.service.saveConfiguration(body,user(req),requestId(req)); }
  @Post('message-processing/test') @RequirePermissions('message_signals.manage_config')
  @ApiOperation({ operationId: 'testMessageProcessingTemplate', summary: 'Test keywords and templates without creating events' })
  test(@Body() body: unknown,@Req() req: RequestWithCurrentUser) { return this.service.testTemplate(body,user(req)); }
}
function user(req: RequestWithCurrentUser) {
  if (!req.user) throw new ApiError(401,'AUTH_REQUIRED','Требуется вход');
  return req.user;
}
function requestId(req: RequestWithCurrentUser) {
  if (!req.requestId) throw new ApiError(500,'REQUEST_ID_MISSING','Не удалось определить запрос');
  return req.requestId;
}
function validId(id: string) {
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new ApiError(422,'SIGNAL_INPUT_INVALID','Некорректный номер сигнала');
  return id;
}
