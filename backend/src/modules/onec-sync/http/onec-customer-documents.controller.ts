import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { OnecPermissionsGuard } from '../../onec-agent/http/onec-permissions.guard';
import { OnecCustomerDocumentsReadService, type CustomerOrdersQuery } from '../application/onec-customer-documents-read.service';

function documentId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(404, 'ONEC_DOCUMENT_NOT_FOUND', 'Документ 1С не найден');
  return id;
}

/** Заказы покупателей 1С и связи документов (план 2026-10-02-onec-customer-documents-plan.md §6): только чтение, onec.view. */
@ApiTags('1C integration')
@Controller('onec')
@UseGuards(OnecPermissionsGuard)
export class OnecCustomerDocumentsController {
  constructor(@Inject(OnecCustomerDocumentsReadService) private readonly read: OnecCustomerDocumentsReadService) {}

  @ApiOperation({ summary: '1C customer orders with paid/shipped totals (links resolved at read time)' })
  @Get('customer-orders')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  list(@Query() query: CustomerOrdersQuery) {
    return this.read.listOrders(query ?? {});
  }

  @ApiOperation({ summary: '1C customer order: header, delivery, lines, linked receipts/refunds and shipments' })
  @Get('customer-orders/:documentId')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  get(@Param('documentId') id: string) {
    return this.read.getOrder(documentId(id));
  }

  @ApiOperation({ summary: 'Links of a 1C document: referenced orders and settlement documents, documents settled by it' })
  @Get('documents/:documentId/links')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions('onec.view')
  links(@Param('documentId') id: string) {
    return this.read.getDocumentLinks(documentId(id));
  }
}
