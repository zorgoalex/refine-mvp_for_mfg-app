import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { WhatsAppPermissionsGuard } from '../whatsapp-permissions.guard';
import { parseOrderId, parseOrderSendCommand, parseOrderSendSettings, parseQueueQuery, parseSendId } from './order-send.dto';
import { OrderSendService } from './order-send.service';
import { ORDER_SEND_PERMISSIONS, ORDER_SEND_SETTINGS_PERMISSIONS } from './order-send.types';

@ApiTags('WhatsApp')
@ApiBearerAuth('bearerAuth')
@Controller()
@UseGuards(WhatsAppPermissionsGuard)
export class OrderSendController {
  constructor(@Inject(OrderSendService) private readonly service: OrderSendService) {}

  @ApiOperation({ summary: 'Settings of sending an order to WhatsApp from the order card' })
  @Get('whatsapp/order-send/settings') @RequirePermissions(ORDER_SEND_SETTINGS_PERMISSIONS)
  settings() { return this.service.settings(); }

  @ApiOperation({ summary: 'Update the order card send settings (version compare-and-swap)' })
  @Put('whatsapp/order-send/settings') @RequirePermissions(ORDER_SEND_SETTINGS_PERMISSIONS)
  updateSettings(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.updateSettings(parseOrderSendSettings(body), user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Order card menu: recipients and forms available to the current user (no group ids)' })
  @Get('whatsapp/order-send/menu') @RequirePermissions(ORDER_SEND_PERMISSIONS)
  menu(@Req() request: RequestWithCurrentUser) { return this.service.menu(user(request)); }

  @ApiOperation({ summary: 'The order card send queue (waiting sends with the estimated time) or the finished ones of 7 days' })
  @Get('whatsapp/order-send/queue') @RequirePermissions(ORDER_SEND_SETTINGS_PERMISSIONS)
  queue(@Query('history') history: unknown, @Query('page') page: unknown) {
    return this.service.queue(parseQueueQuery(history, page));
  }

  /** The author cancels his own waiting send, a WhatsApp manager any; checked per send (no permission gate here). */
  @ApiOperation({ summary: 'Cancel a waiting order card send (its author or a WhatsApp manager)' })
  @Post('whatsapp/order-send/sends/:sendId/cancel') @HttpCode(200)
  cancel(@Param('sendId') sendId: string, @Req() request: RequestWithCurrentUser) {
    return this.service.cancel(parseSendId(sendId), user(request), requestId(request));
  }

  @ApiOperation({ summary: 'Latest WhatsApp sends of one order' })
  @Get('orders/:orderId/whatsapp-sends') @RequirePermissions(ORDER_SEND_PERMISSIONS)
  list(@Param('orderId') orderId: string, @Req() request: RequestWithCurrentUser) {
    return this.service.listForOrder(parseOrderId(orderId), user(request));
  }

  @ApiOperation({ summary: 'Phones of the order client a form can be sent to (masked, the primary first)' })
  @Get('orders/:orderId/whatsapp-sends/client-contacts') @RequirePermissions(ORDER_SEND_PERMISSIONS)
  clientContacts(@Param('orderId') orderId: string, @Req() request: RequestWithCurrentUser) {
    return this.service.clientContacts(parseOrderId(orderId), user(request));
  }

  @ApiOperation({ summary: 'Queue an order form for the client or a configured chat (idempotent)' })
  @Post('orders/:orderId/whatsapp-sends') @HttpCode(202) @RequirePermissions(ORDER_SEND_PERMISSIONS)
  send(@Param('orderId') orderId: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    return this.service.send(parseOrderId(orderId), parseOrderSendCommand(body), user(request), requestId(request));
  }
}

function user(request: RequestWithCurrentUser) {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

function requestId(request: RequestWithCurrentUser) {
  if (!request.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  return request.requestId;
}
