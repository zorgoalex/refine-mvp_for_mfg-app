import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { WhatsAppPermissionsGuard } from '../whatsapp-permissions.guard';
import { parseSupplierRequestId, parseSupplierSendCommand } from './order-send.dto';
import { SUPPLIER_SEND_PERMISSIONS } from './order-send.types';
import { SupplierSendService } from './supplier-send.service';

/** A supplier request to WhatsApp from the procurement screen (the queue of the order card sends). */
@ApiTags('WhatsApp')
@ApiBearerAuth('bearerAuth')
@Controller('procurement/supplier-requests')
@UseGuards(WhatsAppPermissionsGuard)
export class SupplierSendController {
  constructor(@Inject(SupplierSendService) private readonly service: SupplierSendService) {}

  @ApiOperation({ operationId: 'supplierRequestWhatsappMenu', summary: 'Recipient of a supplier request in WhatsApp: the supplier and his phones as masks' })
  @Get(':supplierRequestId/whatsapp-menu') @RequirePermissions(SUPPLIER_SEND_PERMISSIONS)
  menu(@Param('supplierRequestId') supplierRequestId: string, @Req() request: RequestWithCurrentUser) {
    return this.service.menu(parseSupplierRequestId(supplierRequestId), user(request));
  }

  @ApiOperation({ operationId: 'sendSupplierRequestToWhatsapp', summary: 'Queue the text of a supplier request for the supplier phone (idempotent)' })
  @Post(':supplierRequestId/whatsapp-sends') @HttpCode(202) @RequirePermissions(SUPPLIER_SEND_PERMISSIONS)
  send(@Param('supplierRequestId') supplierRequestId: string, @Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    if (!request.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
    return this.service.send(parseSupplierSendCommand(parseSupplierRequestId(supplierRequestId), body), user(request), request.requestId);
  }
}

function user(request: RequestWithCurrentUser) {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}
