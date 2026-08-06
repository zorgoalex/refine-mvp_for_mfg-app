import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { CurrentUser } from '../../../permissions/current-user';
import { ROLE_POLICIES, type Scope } from '../../../permissions/policies/role-policies';
import { allowsScope } from '../../../permissions/policies/scope';
import { OrderQueryService } from '../application/order-query.service';
import {
  ORDER_LIST_SORT_FIELDS,
  type OrderListQuery,
  type OrderListSortBy,
  type SortOrder,
} from '../application/order-query.types';
import { OrderTransactionService } from '../application/order-transaction.service';
import {
  OrderDetailTransferService,
  type OrderTransferTargetsResponseDto,
  type TransferOrderDetailsDto,
  type TransferOrderDetailsResponseDto,
} from '../application/order-detail-transfer.service';
import type {
  DeleteOrderResponseDto,
  OrderAuditListResponseDto,
  OrderDto,
  OrderListResponseDto,
  OrderResponseDto,
  RestoreOrderResponseDto,
} from '../dto/order.dto';
import type { OrderFormDataResponseDto } from '../dto/order-form-data.dto';
import type { SaveOrderDto } from '../dto/save-order.dto';
import { OrdersRuntimeConfigService } from './orders-runtime-config.service';

export interface SaveOrderResponseDto {
  order: OrderDto;
}

const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;

const nullableStringSwaggerSchema = { type: 'string', nullable: true } as const;
const nullableIntegerSwaggerSchema = { type: 'integer', nullable: true } as const;
const nullableNumberSwaggerSchema = { type: 'number', nullable: true } as const;
const dateOnlySwaggerSchema = { type: 'string', format: 'date' } as const;

const orderPaginationSwaggerSchema = {
  type: 'object',
  required: ['page', 'pageSize', 'total', 'totalPages'],
  properties: {
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    total: { type: 'integer' },
    totalPages: { type: 'integer' },
  },
} as const;

// Exported for generated-swagger-document testing only (orders-openapi-contract.test.ts).
export const saveOrderHeaderSwaggerSchema = {
  type: 'object',
  required: ['orderName', 'clientId', 'orderDate', 'orderStatusId'],
  properties: {
    orderId: { type: 'integer' },
    projectId: nullableIntegerSwaggerSchema,
    orderName: { type: 'string' },
    clientId: { type: 'integer' },
    orderDate: dateOnlySwaggerSchema,
    priority: { type: 'integer' },
    managerId: nullableIntegerSwaggerSchema,
    orderStatusId: { type: 'integer' },
    paymentStatusId: nullableIntegerSwaggerSchema,
    productionStatusId: nullableIntegerSwaggerSchema,
    productionStatusFromDetailsEnabled: { type: 'boolean', default: true },
    plannedCompletionDate: { ...dateOnlySwaggerSchema, nullable: true },
    completionDate: { ...dateOnlySwaggerSchema, nullable: true },
    issueDate: { ...dateOnlySwaggerSchema, nullable: true },
    paymentDate: { ...dateOnlySwaggerSchema, nullable: true },
    discount: nullableNumberSwaggerSchema,
    surcharge: nullableNumberSwaggerSchema,
    linkCuttingFile: nullableStringSwaggerSchema,
    linkCuttingImageFile: nullableStringSwaggerSchema,
    linkCadFile: nullableStringSwaggerSchema,
    linkPdfFile: nullableStringSwaggerSchema,
    notes: nullableStringSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
    // Variant B: header materialId is always null/absent (sunset); sheet_material_type_id is authoritative.
    materialId: { ...nullableIntegerSwaggerSchema, description: 'Variant B: always null for order headers; deprecated. Use sheetMaterialTypeId.' },
    sheetMaterialTypeId: { ...nullableIntegerSwaggerSchema, description: 'Variant B: authoritative sheet material reference for the order header. materialId is deprecated and always null.' },
    millingTypeId: nullableIntegerSwaggerSchema,
    edgeTypeId: nullableIntegerSwaggerSchema,
    filmId: nullableIntegerSwaggerSchema,
  },
} as const;

// Exported for generated-swagger-document testing only (orders-openapi-contract.test.ts).
export const saveOrderDetailSwaggerSchema = {
  type: 'object',
  // Variant B: sheetMaterialTypeId is required (authoritative material ref); materialId must be null/absent.
  required: ['height', 'width', 'quantity', 'sheetMaterialTypeId', 'millingTypeId', 'edgeTypeId'],
  properties: {
    id: { type: 'integer' },
    clientKey: { type: 'string' },
    detailNumber: { type: 'integer' },
    detailName: nullableStringSwaggerSchema,
    height: { type: 'number' },
    width: { type: 'number' },
    quantity: { type: 'integer' },
    materialId: { ...nullableIntegerSwaggerSchema, description: 'Variant B: must be null/absent; sheet_material_type_id is authoritative. Sending a non-null value is rejected with 422.' },
    sheetMaterialTypeId: { ...nullableIntegerSwaggerSchema, description: 'Variant B: required for sheet details; authoritative reference to sheet_material_types. materialId must be null/absent.' },
    millingTypeId: { type: 'integer' },
    edgeTypeId: { type: 'integer' },
    filmId: nullableIntegerSwaggerSchema,
    area: nullableNumberSwaggerSchema,
    millingCostPerSqm: nullableNumberSwaggerSchema,
    detailCost: nullableNumberSwaggerSchema,
    priority: { type: 'integer' },
    productionStatusId: nullableIntegerSwaggerSchema,
    jointOrderId: nullableIntegerSwaggerSchema,
    note: nullableStringSwaggerSchema,
    basisProject: nullableStringSwaggerSchema,
    basisProduct: nullableStringSwaggerSchema,
    basisData: nullableStringSwaggerSchema,
    basisDesignation: nullableStringSwaggerSchema,
    doweling: { type: 'boolean', description: 'Detail requires doweling (Присадка). Defaults to false.' },
    linkCuttingFile: nullableStringSwaggerSchema,
    linkCuttingImageFile: nullableStringSwaggerSchema,
    linkCadFile: nullableStringSwaggerSchema,
    linkPdfFile: nullableStringSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
  },
} as const;

const saveOrderPaymentSwaggerSchema = {
  type: 'object',
  required: ['typePaidId', 'amount', 'paymentDate'],
  properties: {
    id: { type: 'integer' },
    clientKey: { type: 'string' },
    typePaidId: { type: 'integer' },
    amount: { type: 'number' },
    paymentDate: dateOnlySwaggerSchema,
    notes: nullableStringSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
  },
} as const;

const saveOrderWorkshopSwaggerSchema = {
  type: 'object',
  required: ['workshopId', 'productionStatusId'],
  properties: {
    id: { type: 'integer' },
    clientKey: { type: 'string' },
    workshopId: { type: 'integer' },
    productionStatusId: { type: 'integer' },
    receivedDate: { ...dateOnlySwaggerSchema, nullable: true },
    startedDate: { ...dateOnlySwaggerSchema, nullable: true },
    completedDate: { ...dateOnlySwaggerSchema, nullable: true },
    plannedCompletionDate: { ...dateOnlySwaggerSchema, nullable: true },
    sequenceOrder: nullableIntegerSwaggerSchema,
    responsibleEmployeeId: nullableIntegerSwaggerSchema,
    notes: nullableStringSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
  },
} as const;

const saveOrderRequirementSwaggerSchema = {
  type: 'object',
  required: ['resourceType', 'requiredQuantity', 'unitId', 'requirementStatusId'],
  properties: {
    id: { type: 'integer' },
    clientKey: { type: 'string' },
    resourceType: { type: 'string' },
    materialId: nullableIntegerSwaggerSchema,
    filmId: nullableIntegerSwaggerSchema,
    edgeTypeId: nullableIntegerSwaggerSchema,
    requiredQuantity: { type: 'number' },
    unitId: { type: 'integer' },
    wastePercentage: nullableNumberSwaggerSchema,
    finalQuantity: nullableNumberSwaggerSchema,
    requirementStatusId: { type: 'integer' },
    supplierId: nullableIntegerSwaggerSchema,
    purchasePrice: nullableNumberSwaggerSchema,
    requisitionId: nullableIntegerSwaggerSchema,
    warehouseId: nullableIntegerSwaggerSchema,
    reservedAt: { type: 'string', format: 'date-time', nullable: true },
    consumedAt: { type: 'string', format: 'date-time', nullable: true },
    notes: nullableStringSwaggerSchema,
    calculationDetails: nullableStringSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
  },
} as const;

const saveOrderDowelingLinkSwaggerSchema = {
  type: 'object',
  required: ['dowelingOrderId'],
  properties: {
    id: { type: 'integer' },
    clientKey: { type: 'string' },
    dowelingOrderId: { type: 'integer' },
    designEngineerId: nullableIntegerSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
  },
} as const;

const orderDetailCutJobRefSwaggerSchema = {
  type: 'object',
  required: ['cutJobId', 'resultNo', 'cutNumber', 'name', 'paramProfileId', 'profileName', 'profileIsActive'],
  properties: {
    cutJobId: { type: 'integer' },
    resultNo: { type: 'integer' },
    cutNumber: { type: 'string' },
    name: { type: 'string' },
    paramProfileId: nullableIntegerSwaggerSchema,
    profileName: nullableStringSwaggerSchema,
    profileIsActive: { type: 'boolean', nullable: true },
  },
} as const;

const orderDetailBazisCutSetRefSwaggerSchema = {
  type: 'object',
  required: ['bazisCutSetId', 'name'],
  properties: {
    bazisCutSetId: { type: 'integer' },
    name: { type: 'string' },
  },
} as const;

// Exported for generated-swagger-document testing only (orders-openapi-contract.test.ts).
export const orderDetailResponseSwaggerSchema = {
  type: 'object',
  required: [
    'id',
    'orderId',
    'detailNumber',
    'detailName',
    'height',
    'width',
    'quantity',
    // Variant B: materialId is nullable (NULL post-034); NOT in required.
    'sheetMaterialTypeId',
    'millingTypeId',
    'edgeTypeId',
    'filmId',
    'area',
    'millingCostPerSqm',
    'detailCost',
    'priority',
    'productionStatusId',
    'jointOrderId',
    'note',
    'basisProject',
    'bazisProjectId',
    'basisProduct',
    'basisData',
    'basisDesignation',
    'doweling',
    'linkCuttingFile',
    'linkCuttingImageFile',
    'linkCadFile',
    'linkPdfFile',
    'refKey1c',
    'bazisCutSets',
  ],
  properties: {
    id: { type: 'integer' },
    orderId: { type: 'integer' },
    clientKey: { type: 'string' },
    detailNumber: { type: 'integer' },
    detailName: nullableStringSwaggerSchema,
    height: { type: 'number' },
    width: { type: 'number' },
    quantity: { type: 'integer' },
    // Variant B: materialId is NULL post-034 (nullable, NOT in required).
    materialId: { ...nullableIntegerSwaggerSchema, description: 'Variant B: always null post-migration 034; sheet_material_type_id is authoritative.' },
    sheetMaterialTypeId: { type: 'integer', description: 'Variant B: required; authoritative sheet material type reference.' },
    millingTypeId: { type: 'integer' },
    edgeTypeId: { type: 'integer' },
    filmId: nullableIntegerSwaggerSchema,
    area: { type: 'number' },
    millingCostPerSqm: nullableNumberSwaggerSchema,
    detailCost: { type: 'number' },
    priority: { type: 'integer' },
    productionStatusId: nullableIntegerSwaggerSchema,
    jointOrderId: nullableIntegerSwaggerSchema,
    note: nullableStringSwaggerSchema,
    basisProject: nullableStringSwaggerSchema,
    bazisProjectId: nullableIntegerSwaggerSchema,
    basisProduct: nullableStringSwaggerSchema,
    basisData: nullableStringSwaggerSchema,
    basisDesignation: nullableStringSwaggerSchema,
    doweling: { type: 'boolean' },
    linkCuttingFile: nullableStringSwaggerSchema,
    linkCuttingImageFile: nullableStringSwaggerSchema,
    linkCadFile: nullableStringSwaggerSchema,
    linkPdfFile: nullableStringSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
    cutJob: { ...orderDetailCutJobRefSwaggerSchema, nullable: true },
    bathCutJob: { ...orderDetailCutJobRefSwaggerSchema, nullable: true },
    bazisCutSets: { type: 'array', items: orderDetailBazisCutSetRefSwaggerSchema },
  },
} as const;

const orderPaymentResponseSwaggerSchema = {
  type: 'object',
  required: ['id', 'orderId', 'typePaidId', 'amount', 'paymentDate', 'notes', 'refKey1c'],
  properties: {
    id: { type: 'integer' },
    orderId: { type: 'integer' },
    clientKey: { type: 'string' },
    typePaidId: { type: 'integer' },
    amount: { type: 'number' },
    paymentDate: dateOnlySwaggerSchema,
    notes: nullableStringSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
  },
} as const;

const orderWorkshopResponseSwaggerSchema = {
  type: 'object',
  required: [
    'id',
    'orderId',
    'workshopId',
    'productionStatusId',
    'receivedDate',
    'startedDate',
    'completedDate',
    'plannedCompletionDate',
    'sequenceOrder',
    'responsibleEmployeeId',
    'notes',
    'refKey1c',
  ],
  properties: {
    id: { type: 'integer' },
    orderId: { type: 'integer' },
    clientKey: { type: 'string' },
    workshopId: { type: 'integer' },
    productionStatusId: { type: 'integer' },
    receivedDate: { ...dateOnlySwaggerSchema, nullable: true },
    startedDate: { ...dateOnlySwaggerSchema, nullable: true },
    completedDate: { ...dateOnlySwaggerSchema, nullable: true },
    plannedCompletionDate: { ...dateOnlySwaggerSchema, nullable: true },
    sequenceOrder: nullableIntegerSwaggerSchema,
    responsibleEmployeeId: nullableIntegerSwaggerSchema,
    notes: nullableStringSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
  },
} as const;

const orderRequirementResponseSwaggerSchema = {
  type: 'object',
  required: [
    'id',
    'orderId',
    'resourceType',
    'materialId',
    'filmId',
    'edgeTypeId',
    'requiredQuantity',
    'unitId',
    'wastePercentage',
    'finalQuantity',
    'requirementStatusId',
    'supplierId',
    'purchasePrice',
    'requisitionId',
    'warehouseId',
    'reservedAt',
    'consumedAt',
    'notes',
    'calculationDetails',
    'refKey1c',
  ],
  properties: {
    id: { type: 'integer' },
    orderId: { type: 'integer' },
    clientKey: { type: 'string' },
    resourceType: { type: 'string' },
    materialId: nullableIntegerSwaggerSchema,
    filmId: nullableIntegerSwaggerSchema,
    edgeTypeId: nullableIntegerSwaggerSchema,
    requiredQuantity: { type: 'number' },
    unitId: { type: 'integer' },
    wastePercentage: nullableNumberSwaggerSchema,
    finalQuantity: nullableNumberSwaggerSchema,
    requirementStatusId: { type: 'integer' },
    supplierId: nullableIntegerSwaggerSchema,
    purchasePrice: nullableNumberSwaggerSchema,
    requisitionId: nullableIntegerSwaggerSchema,
    warehouseId: nullableIntegerSwaggerSchema,
    reservedAt: { type: 'string', format: 'date-time', nullable: true },
    consumedAt: { type: 'string', format: 'date-time', nullable: true },
    notes: nullableStringSwaggerSchema,
    calculationDetails: nullableStringSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
  },
} as const;

const orderDowelingLinkResponseSwaggerSchema = {
  type: 'object',
  required: ['id', 'orderId', 'dowelingOrderId', 'designEngineerId', 'refKey1c', 'dowelingOrder'],
  properties: {
    id: { type: 'integer' },
    orderId: { type: 'integer' },
    clientKey: { type: 'string' },
    dowelingOrderId: { type: 'integer' },
    designEngineerId: nullableIntegerSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
    dowelingOrder: {
      type: 'object',
      nullable: true,
      required: ['id', 'name', 'designEngineerId'],
      properties: {
        id: { type: 'integer' },
        name: nullableStringSwaggerSchema,
        designEngineerId: nullableIntegerSwaggerSchema,
      },
    },
  },
} as const;

const orderGroupSummarySwaggerSchema = {
  type: 'object',
  required: ['id', 'code', 'name', 'relationType', 'isPrimary', 'validFrom'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    name: { type: 'string' },
    relationType: { type: 'string', enum: ['main', 'secondary', 'reporting', 'billing', 'derived'] },
    isPrimary: { type: 'boolean' },
    validFrom: { type: 'string', format: 'date-time' },
  },
} as const;

// Exported for generated-swagger-document testing only (orders-openapi-contract.test.ts).
export const orderHeaderResponseSwaggerSchema = {
  type: 'object',
  required: [
    'orderId',
    'orderName',
    'clientId',
    'clientName',
    'orderDate',
    'priority',
    'managerId',
    'orderStatusId',
    'orderStatusName',
    'paymentStatusId',
    'paymentStatusName',
    'productionStatusId',
    'productionStatusName',
    'productionStatusFromDetailsEnabled',
    'plannedCompletionDate',
    'completionDate',
    'issueDate',
    'paymentDate',
    'discount',
    'surcharge',
    'totalAmount',
    'finalAmount',
    'paidAmount',
    'partsCount',
    'totalArea',
    'linkCuttingFile',
    'linkCuttingImageFile',
    'linkCadFile',
    'linkPdfFile',
    'notes',
    'refKey1c',
    'createdAt',
    'updatedAt',
    'createdBy',
    'editedBy',
    'version',
  ],
  properties: {
    orderId: { type: 'integer' },
    orderName: { type: 'string' },
    clientId: { type: 'integer' },
    clientName: nullableStringSwaggerSchema,
    orderDate: dateOnlySwaggerSchema,
    priority: { type: 'integer' },
    managerId: nullableIntegerSwaggerSchema,
    orderStatusId: { type: 'integer' },
    orderStatusName: { type: 'string' },
    paymentStatusId: { type: 'integer' },
    paymentStatusName: { type: 'string' },
    productionStatusId: nullableIntegerSwaggerSchema,
    productionStatusName: nullableStringSwaggerSchema,
    productionStatusFromDetailsEnabled: { type: 'boolean' },
    plannedCompletionDate: { ...dateOnlySwaggerSchema, nullable: true },
    completionDate: { ...dateOnlySwaggerSchema, nullable: true },
    issueDate: { ...dateOnlySwaggerSchema, nullable: true },
    paymentDate: { ...dateOnlySwaggerSchema, nullable: true },
    discount: { type: 'number' },
    surcharge: { type: 'number' },
    totalAmount: { type: 'number' },
    finalAmount: { type: 'number' },
    paidAmount: { type: 'number' },
    partsCount: { type: 'integer' },
    totalArea: { type: 'number' },
    linkCuttingFile: nullableStringSwaggerSchema,
    linkCuttingImageFile: nullableStringSwaggerSchema,
    linkCadFile: nullableStringSwaggerSchema,
    linkPdfFile: nullableStringSwaggerSchema,
    notes: nullableStringSwaggerSchema,
    refKey1c: nullableStringSwaggerSchema,
    materialId: nullableIntegerSwaggerSchema,
    sheetMaterialTypeId: nullableIntegerSwaggerSchema,
    millingTypeId: nullableIntegerSwaggerSchema,
    edgeTypeId: nullableIntegerSwaggerSchema,
    filmId: nullableIntegerSwaggerSchema,
    deleteFlag: { type: 'boolean' },
    deletedAt: { type: 'string', format: 'date-time', nullable: true },
    deletedByName: nullableStringSwaggerSchema,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    createdBy: nullableIntegerSwaggerSchema,
    editedBy: nullableIntegerSwaggerSchema,
    version: { type: 'integer' },
  },
} as const;

const saveOrderRequestSwaggerSchema = {
  type: 'object',
  required: ['header', 'details', 'payments', 'workshops', 'requirements', 'dowelingLinks', 'deleted'],
  properties: {
    header: saveOrderHeaderSwaggerSchema,
    details: { type: 'array', items: saveOrderDetailSwaggerSchema },
    payments: { type: 'array', items: saveOrderPaymentSwaggerSchema },
    workshops: { type: 'array', items: saveOrderWorkshopSwaggerSchema },
    requirements: { type: 'array', items: saveOrderRequirementSwaggerSchema },
    dowelingLinks: { type: 'array', items: saveOrderDowelingLinkSwaggerSchema },
    deleted: {
      type: 'object',
      properties: {
        detailIds: { type: 'array', items: { type: 'integer' } },
        paymentIds: { type: 'array', items: { type: 'integer' } },
        workshopIds: { type: 'array', items: { type: 'integer' } },
        requirementIds: { type: 'array', items: { type: 'integer' } },
        dowelingLinkIds: { type: 'array', items: { type: 'integer' } },
      },
    },
    version: { type: 'integer' },
    idempotencyKey: { type: 'string' },
  },
} as const;

const orderSwaggerSchema = {
  type: 'object',
  required: ['header', 'details', 'payments', 'workshops', 'requirements', 'dowelingLinks', 'primaryGroup', 'groups', 'totals', 'version', 'createdAt', 'updatedAt'],
  properties: {
    header: orderHeaderResponseSwaggerSchema,
    details: { type: 'array', items: orderDetailResponseSwaggerSchema },
    payments: { type: 'array', items: orderPaymentResponseSwaggerSchema },
    workshops: { type: 'array', items: orderWorkshopResponseSwaggerSchema },
    requirements: { type: 'array', items: orderRequirementResponseSwaggerSchema },
    dowelingLinks: { type: 'array', items: orderDowelingLinkResponseSwaggerSchema },
    primaryGroup: { ...orderGroupSummarySwaggerSchema, nullable: true },
    groups: { type: 'array', items: orderGroupSummarySwaggerSchema },
    totals: {
      type: 'object',
      required: ['totalAmount', 'finalAmount', 'paidAmount', 'debtAmount', 'partsCount', 'totalArea'],
      properties: {
        totalAmount: { type: 'number' },
        finalAmount: { type: 'number' },
        paidAmount: { type: 'number' },
        debtAmount: { type: 'number' },
        partsCount: { type: 'integer' },
        totalArea: { type: 'number' },
      },
    },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const saveOrderResponseSwaggerSchema = {
  type: 'object',
  required: ['order'],
  properties: {
    order: orderSwaggerSchema,
  },
} as const;

const orderResponseSwaggerSchema = {
  type: 'object',
  required: ['order'],
  properties: {
    order: orderSwaggerSchema,
  },
} as const;

const orderListItemSwaggerSchema = {
  type: 'object',
  required: ['orderId', 'orderName', 'projectId', 'projectCode', 'fullNumber', 'clientId', 'clientName', 'orderDate', 'plannedCompletionDate', 'completionDate', 'issueDate', 'paymentDate', 'orderStatusId', 'orderStatusName', 'paymentStatusId', 'paymentStatusName', 'productionStatusId', 'productionStatusName', 'priority', 'totalAmount', 'discount', 'surcharge', 'finalAmount', 'paidAmount', 'debtAmount', 'partsCount', 'totalArea', 'managerId', 'notes', 'materialIds', 'materialNames', 'basisProjects', 'bazisCutNumbers', 'cutNumbers', 'bathCutNumbers', 'millingTypeId', 'millingTypeName', 'dowelingOrderId', 'dowelingOrderName', 'designEngineerId', 'passedProductionStatusCodes', 'primaryGroup', 'groups', 'createdBy', 'editedBy', 'updatedAt', 'version'],
  properties: {
    orderId: { type: 'integer' },
    orderName: { type: 'string' },
    projectId: { type: 'integer' },
    projectCode: { type: 'string' },
    fullNumber: { type: 'string' },
    clientId: { type: 'integer' },
    clientName: nullableStringSwaggerSchema,
    orderDate: dateOnlySwaggerSchema,
    plannedCompletionDate: { ...dateOnlySwaggerSchema, nullable: true },
    completionDate: { ...dateOnlySwaggerSchema, nullable: true },
    issueDate: { ...dateOnlySwaggerSchema, nullable: true },
    paymentDate: { ...dateOnlySwaggerSchema, nullable: true },
    orderStatusId: { type: 'integer' },
    orderStatusName: { type: 'string' },
    paymentStatusId: { type: 'integer' },
    paymentStatusName: { type: 'string' },
    productionStatusId: nullableIntegerSwaggerSchema,
    productionStatusName: nullableStringSwaggerSchema,
    priority: { type: 'integer' },
    totalAmount: { type: 'number' },
    discount: { type: 'number' },
    surcharge: { type: 'number' },
    finalAmount: { type: 'number' },
    paidAmount: { type: 'number' },
    debtAmount: { type: 'number' },
    partsCount: { type: 'integer' },
    totalArea: { type: 'number' },
    managerId: nullableIntegerSwaggerSchema,
    notes: nullableStringSwaggerSchema,
    /** @deprecated Variant B: always empty post-034; use sheetMaterialTypeIds. */
    materialIds: { type: 'array', items: { type: 'integer' }, deprecated: true },
    materialNames: { type: 'array', items: { type: 'string' } },
    basisProjects: { type: 'array', items: { type: 'string' } },
    bazisCutNumbers: { type: 'array', items: { type: 'string' } },
    cutNumbers: { type: 'array', items: { type: 'string' } },
    bathCutNumbers: { type: 'array', items: { type: 'string' } },
    sheetMaterialTypeIds: { type: 'array', items: { type: 'integer' } },
    millingTypeId: nullableIntegerSwaggerSchema,
    millingTypeName: nullableStringSwaggerSchema,
    dowelingOrderId: nullableIntegerSwaggerSchema,
    dowelingOrderName: nullableStringSwaggerSchema,
    designEngineerId: nullableIntegerSwaggerSchema,
    passedProductionStatusCodes: { type: 'array', items: { type: 'string' } },
    primaryGroup: { ...orderGroupSummarySwaggerSchema, nullable: true },
    groups: { type: 'array', items: orderGroupSummarySwaggerSchema },
    createdBy: nullableIntegerSwaggerSchema,
    editedBy: nullableIntegerSwaggerSchema,
    deletedAt: { type: 'string', format: 'date-time', nullable: true },
    deletedBy: nullableIntegerSwaggerSchema,
    deletedByName: nullableStringSwaggerSchema,
    updatedAt: { type: 'string', format: 'date-time' },
    version: { type: 'integer' },
  },
} as const;

const orderListResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'pagination'],
  properties: {
    data: { type: 'array', items: orderListItemSwaggerSchema },
    pagination: orderPaginationSwaggerSchema,
  },
} as const;

const lookupSwaggerSchema = {
  type: 'object',
  required: ['id', 'name', 'sortOrder'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    sortOrder: { type: 'integer' },
  },
} as const;

const materialLookupSwaggerSchema = {
  type: 'object',
  required: ['id', 'name', 'unitId', 'sortOrder'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    unitId: nullableIntegerSwaggerSchema,
    sortOrder: { type: 'integer' },
  },
} as const;

const millingTypeLookupSwaggerSchema = {
  type: 'object',
  required: ['id', 'name', 'costPerSqm', 'sortOrder'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    costPerSqm: nullableNumberSwaggerSchema,
    sortOrder: { type: 'integer' },
  },
} as const;

const statusLookupSwaggerSchema = {
  type: 'object',
  required: ['id', 'name', 'sortOrder'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    code: nullableStringSwaggerSchema,
    color: nullableStringSwaggerSchema,
    sortOrder: { type: 'integer' },
  },
} as const;

// SP3: only present for callers with sheet_materials.view (service-masked).
const sheetMaterialTypeLookupSwaggerSchema = {
  type: 'object',
  required: ['id', 'name', 'widthMm', 'heightMm', 'isActive', 'isCuttable', 'sortOrder'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    widthMm: nullableNumberSwaggerSchema,
    heightMm: nullableNumberSwaggerSchema,
    isActive: { type: 'boolean' },
    isCuttable: { type: 'boolean' },
    sortOrder: { type: 'integer' },
  },
} as const;

const orderFormDataResponseSwaggerSchema = {
  type: 'object',
  required: [
    'clients',
    'materials',
    'millingTypes',
    'edgeTypes',
    'films',
    'orderStatuses',
    'paymentStatuses',
    'paymentTypes',
    'productionStatuses',
    'workshops',
    'employees',
    'units',
  ],
  properties: {
    clients: { type: 'array', items: lookupSwaggerSchema },
    materials: { type: 'array', items: materialLookupSwaggerSchema },
    millingTypes: { type: 'array', items: millingTypeLookupSwaggerSchema },
    edgeTypes: { type: 'array', items: lookupSwaggerSchema },
    films: { type: 'array', items: lookupSwaggerSchema },
    orderStatuses: { type: 'array', items: statusLookupSwaggerSchema },
    paymentStatuses: { type: 'array', items: statusLookupSwaggerSchema },
    paymentTypes: { type: 'array', items: lookupSwaggerSchema },
    productionStatuses: { type: 'array', items: statusLookupSwaggerSchema },
    workshops: { type: 'array', items: lookupSwaggerSchema },
    employees: { type: 'array', items: { type: 'object', required: ['id', 'fullName'], properties: { id: { type: 'integer' }, fullName: { type: 'string' } } } },
    units: { type: 'array', items: { type: 'object', required: ['id', 'code', 'name', 'sortOrder'], properties: { id: { type: 'integer' }, code: { type: 'string' }, name: { type: 'string' }, symbol: { type: 'string' }, sortOrder: { type: 'integer' } } } },
    // SP3: optional — omitted entirely for callers without sheet_materials.view.
    sheetMaterialTypes: { type: 'array', items: sheetMaterialTypeLookupSwaggerSchema },
  },
} as const;

const orderAuditListResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'pagination', 'requestId'],
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        required: ['auditId', 'action', 'requestId', 'createdAt'],
        properties: {
          auditId: { type: 'string' },
          entityType: nullableStringSwaggerSchema,
          entityId: nullableStringSwaggerSchema,
          action: { type: 'string' },
          userId: nullableIntegerSwaggerSchema,
          username: nullableStringSwaggerSchema,
          role: nullableStringSwaggerSchema,
          before: { type: 'object', nullable: true, additionalProperties: true },
          after: { type: 'object', nullable: true, additionalProperties: true },
          diff: { type: 'object', nullable: true, additionalProperties: true },
          requestId: { type: 'string' },
          ip: nullableStringSwaggerSchema,
          userAgent: nullableStringSwaggerSchema,
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    pagination: orderPaginationSwaggerSchema,
    requestId: { type: 'string' },
  },
} as const;

const deleteOrderResponseSwaggerSchema = {
  type: 'object',
  required: ['success', 'orderId', 'requestId'],
  properties: {
    success: { type: 'boolean', enum: [true] },
    orderId: { type: 'integer' },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

const restoreOrderResponseSwaggerSchema = {
  type: 'object',
  required: ['order', 'requestId'],
  properties: {
    order: orderSwaggerSchema,
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

const orderTransferTargetSwaggerSchema = {
  type: 'object',
  required: [
    'orderId',
    'orderName',
    'clientId',
    'clientName',
    'orderDate',
    'projectId',
    'projectCode',
    'projectName',
    'orderStatusId',
    'orderStatusName',
    'productionStatusId',
    'productionStatusName',
    'version',
  ],
  properties: {
    orderId: { type: 'integer' },
    orderName: { type: 'string' },
    clientId: { type: 'integer' },
    clientName: nullableStringSwaggerSchema,
    orderDate: dateOnlySwaggerSchema,
    projectId: { type: 'integer' },
    projectCode: nullableStringSwaggerSchema,
    projectName: nullableStringSwaggerSchema,
    orderStatusId: { type: 'integer' },
    orderStatusName: nullableStringSwaggerSchema,
    productionStatusId: nullableIntegerSwaggerSchema,
    productionStatusName: nullableStringSwaggerSchema,
    version: { type: 'integer' },
  },
} as const;

const orderTransferTargetsResponseSwaggerSchema = {
  type: 'object',
  required: ['data', 'requestId'],
  properties: {
    data: { type: 'array', items: orderTransferTargetSwaggerSchema },
    requestId: { type: 'string' },
  },
} as const;

const transferOrderDetailsRequestSwaggerSchema = {
  type: 'object',
  required: ['detailIds', 'target'],
  properties: {
    detailIds: { type: 'array', items: { type: 'integer' } },
    target: {
      oneOf: [
        {
          type: 'object',
          required: ['mode', 'orderId', 'version'],
          properties: {
            mode: { type: 'string', enum: ['existing'] },
            orderId: { type: 'integer' },
            version: { type: 'integer' },
          },
        },
        {
          type: 'object',
          required: ['mode', 'orderName'],
          properties: {
            mode: { type: 'string', enum: ['new'] },
            orderName: { type: 'string' },
            projectId: nullableIntegerSwaggerSchema,
          },
        },
      ],
    },
    note: nullableStringSwaggerSchema,
  },
} as const;

const transferOrderDetailsResponseSwaggerSchema = {
  type: 'object',
  required: [
    'sourceOrder',
    'targetOrder',
    'movedDetailIds',
    'sourceVersion',
    'targetVersion',
    'targetCreated',
    'auditId',
    'requestId',
  ],
  properties: {
    sourceOrder: orderSwaggerSchema,
    targetOrder: orderSwaggerSchema,
    movedDetailIds: { type: 'array', items: { type: 'integer' } },
    sourceVersion: { type: 'integer' },
    targetVersion: { type: 'integer' },
    targetCreated: { type: 'boolean' },
    auditId: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(OrderTransactionService)
    private readonly orders: OrderTransactionService,
    @Inject(OrderQueryService)
    private readonly orderQueries: OrderQueryService,
    @Inject(OrderDetailTransferService)
    private readonly detailTransfer: OrderDetailTransferService,
    @Inject(OrdersRuntimeConfigService)
    private readonly runtimeConfig: OrdersRuntimeConfigService,
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'sortBy', required: false, enum: ORDER_LIST_SORT_FIELDS, description: 'Sort field' })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'], description: 'Sort direction' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search text' })
  @ApiQuery({ name: 'clientId', required: false, type: Number, description: 'Client ID filter' })
  @ApiQuery({ name: 'projectId', required: false, type: Number, description: 'Project ID filter' })
  @ApiQuery({ name: 'orderStatusId', required: false, type: Number, description: 'Order status ID filter' })
  @ApiQuery({ name: 'paymentStatusId', required: false, type: Number, description: 'Payment status ID filter' })
  @ApiQuery({ name: 'productionStatusId', required: false, type: Number, description: 'Production status ID filter' })
  @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Start date filter', schema: swaggerSchema(dateOnlySwaggerSchema) })
  @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'End date filter', schema: swaggerSchema(dateOnlySwaggerSchema) })
  @ApiQuery({ name: 'onlyMyOrders', required: false, type: Boolean, description: 'Only orders assigned to the current user' })
  @ApiQuery({ name: 'deleted', required: false, type: Boolean, description: 'True to list only deleted orders; requires orders.delete' })
  @ApiQuery({ name: 'groupIds', required: false, type: String, description: 'Comma-separated current group UUID filters' })
  @ApiQuery({ name: 'groupMode', required: false, enum: ['any', 'all', 'primary', 'none'], description: 'Group filter mode' })
  @ApiResponse({ status: 200, description: 'Order list', schema: swaggerSchema(orderListResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid order list query' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'listOrders', summary: 'List orders' })
  @Get()
  async list(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<OrderListResponseDto> {
    this.assertOrdersReadEnabled();

    const currentUser = this.requireCurrentUser(request);
    const listQuery = parseOrderListQuery(query);

    if (listQuery.deleted === true) {
      const deleteScope = this.getDeletedOrderScope(currentUser);
      if (!currentUser.permissions.includes('orders.delete') || deleteScope === undefined) {
        await this.recordTrashDeniedAudit(currentUser, request.requestId, 'orders.list_deleted');
        this.throwTrashPermissionDenied();
      }

      if (deleteScope === 'own') {
        listQuery.deletedScopeUserId = currentUser.id;
      } else if (deleteScope !== 'all') {
        await this.recordTrashDeniedAudit(currentUser, request.requestId, 'orders.list_deleted');
        this.throwTrashPermissionDenied();
      }
    }

    return this.orderQueries.list({ currentUser, query: listQuery });
  }

  @ApiResponse({ status: 200, description: 'Order form data', schema: swaggerSchema(orderFormDataResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'getOrderFormData', summary: 'Get order form data' })
  @Get('form-data')
  async getFormData(@Req() request: RequestWithCurrentUser): Promise<OrderFormDataResponseDto> {
    this.assertOrdersReadEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.orderQueries.getFormData({ currentUser });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Source order ID' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Target search text: order, client, project, status' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Maximum returned targets' })
  @ApiResponse({ status: 200, description: 'Transfer target orders', schema: swaggerSchema(orderTransferTargetsResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Source order not found' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'listOrderTransferTargets', summary: 'List recent transfer target orders' })
  @Get(':orderId/transfer-targets')
  async listTransferTargets(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<OrderTransferTargetsResponseDto> {
    this.assertOrdersReadEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.detailTransfer.listTransferTargets({
      currentUser,
      sourceOrderId: parseOrderId(orderIdParam),
      search: parseSearch(query.search),
      limit: parsePositiveInteger(query.limit, 'limit', 20, 1, 50),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiQuery({ name: 'includeDeleted', required: false, type: Boolean, description: 'True to allow reading a deleted order; requires orders.delete' })
  @ApiResponse({ status: 200, description: 'Order', schema: swaggerSchema(orderResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'getOrderById', summary: 'Get an order by ID' })
  @Get(':orderId')
  async getById(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Query() query: Record<string, string | string[] | undefined> = {},
  ): Promise<OrderResponseDto> {
    this.assertOrdersReadEnabled();

    const currentUser = this.requireCurrentUser(request);
    const orderId = parseOrderId(orderIdParam);
    const includeDeleted = parseOptionalBoolean(query.includeDeleted, 'includeDeleted');
    const deleteScope = includeDeleted === true ? this.getDeletedOrderScope(currentUser) : undefined;

    // Critic code-R2-1: решения, не зависящие от конкретного заказа, принимаются
    // ДО fetch — иначе 404 (нет заказа) против 403 (заказ есть) образуют оракул
    // существования удалённых заказов для не-скоупованных ролей.
    if (
      includeDeleted === true &&
      (!currentUser.permissions.includes('orders.delete') ||
        deleteScope === undefined ||
        deleteScope === 'none' ||
        deleteScope === 'assigned')
    ) {
      await this.recordTrashDeniedAudit(
        currentUser,
        request.requestId,
        'orders.read_deleted',
        orderId,
      );
      this.throwTrashPermissionDenied();
    }

    const order = await this.orderQueries.getById({ currentUser, orderId, includeDeleted });

    // Пост-fetch проверка нужна только для row-зависимого scope 'own'.
    // Отказ отвечает 404 (не 403), чтобы own-скоупованный пользователь не мог
    // отличить «чужой удалённый заказ существует» от «заказа нет»; denied-audit
    // при этом пишется.
    if (
      includeDeleted === true &&
      deleteScope === 'own' &&
      !allowsScope(currentUser, deleteScope, {
        createdByUserId:
          order.header.createdBy === null || order.header.createdBy === undefined
            ? null
            : String(order.header.createdBy),
        managerUserId:
          order.header.managerId === null || order.header.managerId === undefined
            ? null
            : String(order.header.managerId),
      })
    ) {
      await this.recordTrashDeniedAudit(
        currentUser,
        request.requestId,
        'orders.read_deleted',
        orderId,
      );
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден', { orderId });
    }

    return { order };
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, description: 'Items per page' })
  @ApiResponse({ status: 200, description: 'Order audit events', schema: swaggerSchema(orderAuditListResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 422, description: 'Invalid order audit query' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled' })
  @ApiOperation({ operationId: 'getOrderAudit', summary: 'Get order audit events' })
  @Get(':orderId/audit')
  async getAudit(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<OrderAuditListResponseDto> {
    this.assertOrdersReadEnabled();

    const currentUser = this.requireCurrentUser(request);
    const orderId = parseOrderId(orderIdParam);
    const auditQuery = parseOrderAuditQuery(query);

    return this.orderQueries.getAudit({
      currentUser,
      orderId,
      page: auditQuery.page,
      pageSize: auditQuery.pageSize,
      requestId: request.requestId ?? 'orders-audit',
    });
  }

  @ApiBody({ schema: swaggerSchema(saveOrderRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Created order', schema: swaggerSchema(saveOrderResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid save order payload' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled or read-only' })
  @ApiOperation({ operationId: 'createOrder', summary: 'Create an order' })
  @Post()
  async create(
    @Req() request: RequestWithCurrentUser,
    @Body() dto: SaveOrderDto,
  ): Promise<SaveOrderResponseDto> {
    this.assertOrdersWriteEnabled();

    const currentUser = this.requireCurrentUser(request);
    const order = await this.orders.create({ currentUser, dto, requestId: request.requestId });

    return { order };
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiBody({ schema: swaggerSchema(saveOrderRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Updated order', schema: swaggerSchema(saveOrderResponseSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 409, description: 'Stale order version conflict' })
  @ApiResponse({ status: 422, description: 'Invalid save order payload' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled or read-only' })
  @ApiOperation({ operationId: 'updateOrder', summary: 'Update an order' })
  @Put(':orderId')
  @HttpCode(200)
  async update(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Body() dto: SaveOrderDto,
  ): Promise<SaveOrderResponseDto> {
    this.assertOrdersWriteEnabled();

    const currentUser = this.requireCurrentUser(request);
    const orderId = parseOrderId(orderIdParam);
    const order = await this.orders.update({
      currentUser,
      orderId,
      dto,
      requestId: request.requestId,
    });

    return { order };
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Source order ID' })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'Source order version/ETag version is required.',
    schema: { type: 'string' },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Idempotency key for safe retry of the detail transfer request.',
    schema: { type: 'string', minLength: 8, maxLength: 200 },
  })
  @ApiBody({ schema: swaggerSchema(transferOrderDetailsRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Transferred order details', schema: swaggerSchema(transferOrderDetailsResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Missing or invalid transfer request headers' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Source, target, or detail not found' })
  @ApiResponse({ status: 409, description: 'Stale version, source-empty, duplicate name, or idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid transfer payload' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled or read-only' })
  @ApiOperation({ operationId: 'transferOrderDetails', summary: 'Transfer selected details to another or new order' })
  @Post(':orderId/details/transfer')
  @HttpCode(200)
  async transferDetails(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Headers('if-match') ifMatchHeader: string | string[] | undefined,
    @Headers('idempotency-key') idempotencyKeyHeader: string | string[] | undefined,
    @Body() body: unknown,
  ): Promise<TransferOrderDetailsResponseDto> {
    this.assertOrdersWriteEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.detailTransfer.transfer({
      currentUser,
      sourceOrderId: parseOrderId(orderIdParam),
      sourceVersion: parseIfMatchVersion(ifMatchHeader),
      idempotencyKey: parseIdempotencyKeyHeader(idempotencyKeyHeader),
      dto: parseTransferOrderDetailsRequest(body),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'Order version/ETag version is required.',
    schema: { type: 'string' },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Idempotency key for safe retry of the delete request.',
    schema: { type: 'string', minLength: 8, maxLength: 200 },
  })
  @ApiResponse({ status: 200, description: 'Deleted order', schema: swaggerSchema(deleteOrderResponseSwaggerSchema) })
  @ApiResponse({ status: 400, description: 'Missing or invalid delete request headers' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Stale order version or idempotency key conflict' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled or read-only' })
  @ApiOperation({ operationId: 'deleteOrder', summary: 'Delete an order' })
  @Delete(':orderId')
  @HttpCode(200)
  async delete(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Headers('if-match') ifMatchHeader: string | string[] | undefined,
    @Headers('idempotency-key') idempotencyKeyHeader: string | string[] | undefined,
  ): Promise<DeleteOrderResponseDto> {
    this.assertOrdersWriteEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.orders.delete({
      currentUser,
      orderId: parseOrderId(orderIdParam),
      version: parseIfMatchVersion(ifMatchHeader),
      idempotencyKey: parseIdempotencyKeyHeader(idempotencyKeyHeader),
      requestId: request.requestId,
    });
  }

  @ApiParam({ name: 'orderId', type: Number, description: 'Order ID' })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'Order version/ETag version is required.',
    schema: { type: 'string' },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Idempotency key for safe retry of the restore request.',
    schema: { type: 'string', minLength: 8, maxLength: 200 },
  })
  @ApiBody({
    schema: swaggerSchema({
      type: 'object',
      properties: {
        orderName: { type: 'string' },
      },
    }),
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'Restored order',
    schema: swaggerSchema(restoreOrderResponseSwaggerSchema),
  })
  @ApiResponse({ status: 400, description: 'Missing or invalid restore request headers' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({
    status: 409,
    description: 'Stale version, order not deleted, order name duplicate, or restore conflict',
  })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiResponse({ status: 422, description: 'Invalid restore order payload' })
  @ApiResponse({ status: 503, description: 'Orders API is disabled or read-only' })
  @ApiOperation({ operationId: 'restoreOrder', summary: 'Восстановить удалённый заказ' })
  @Post(':orderId/restore')
  @HttpCode(200)
  async restore(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderIdParam: string,
    @Headers('if-match') ifMatchHeader: string | string[] | undefined,
    @Headers('idempotency-key') idempotencyKeyHeader: string | string[] | undefined,
    @Body() body: { orderName?: unknown } | undefined,
  ): Promise<RestoreOrderResponseDto> {
    this.assertOrdersWriteEnabled();

    const currentUser = this.requireCurrentUser(request);
    return this.orders.restore({
      currentUser,
      orderId: parseOrderId(orderIdParam),
      version: parseIfMatchVersion(ifMatchHeader),
      idempotencyKey: parseIdempotencyKeyHeader(idempotencyKeyHeader),
      orderName:
        body?.orderName === undefined || body.orderName === null
          ? undefined
          : String(body.orderName),
      requestId: request.requestId,
    });
  }

  private assertOrdersWriteEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();

    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
      });
    }

    if (flags.ordersReadOnly) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders write API is disabled', {
        feature: 'orders',
        mode: 'read_only',
      });
    }
  }

  private assertOrdersReadEnabled(): void {
    const flags = this.runtimeConfig.getFeatureFlags();

    if (!flags.ordersEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders API is disabled', {
        feature: 'orders',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }

  private async recordTrashDeniedAudit(
    currentUser: CurrentUser,
    requestId: string | undefined,
    event: string,
    orderId?: number,
  ): Promise<void> {
    try {
      await auditService.recordDenied(this.database, {
        event,
        entityType: 'order',
        entityId: orderId !== undefined ? String(orderId) : 'orders',
        actorUserId: currentUser.id,
        actorUsername: currentUser.username ?? null,
        actorRole: currentUser.role ?? null,
        requestId: requestId ?? 'orders-trash-denied',
        source: 'backend-orders-command',
        relatedOrderId: orderId ?? null,
        reason: 'PERMISSION_DENIED',
        requiredPermissions: ['orders.delete'],
      });
    } catch {
      // best-effort: deny response must not depend on audit sink health
    }
  }

  private getDeletedOrderScope(currentUser: CurrentUser): Scope | undefined {
    return ROLE_POLICIES[currentUser.role]?.orders.delete;
  }

  private throwTrashPermissionDenied(): never {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра корзины', {
      requiredPermissions: ['orders.delete'],
    });
  }
}

export function parseOrderListQuery(
  query: Record<string, string | string[] | undefined>,
): OrderListQuery {
  rejectUnsupportedGroupTemporalQuery(query);
  const parsed: OrderListQuery = {
    page: parsePositiveInteger(query.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInteger(query.pageSize, 'pageSize', 25, 1, 200),
    sortBy: parseSortBy(query.sortBy),
    sortOrder: parseSortOrder(query.sortOrder),
    search: parseSearch(query.search),
    clientId: parseOptionalPositiveInteger(query.clientId, 'clientId'),
    projectId: parseOptionalPositiveInteger(query.projectId, 'projectId'),
    orderStatusId: parseOptionalPositiveInteger(query.orderStatusId, 'orderStatusId'),
    paymentStatusId: parseOptionalPositiveInteger(query.paymentStatusId, 'paymentStatusId'),
    productionStatusId: parseOptionalPositiveInteger(
      query.productionStatusId,
      'productionStatusId',
    ),
    dateFrom: parseOptionalDateOnly(query.dateFrom, 'dateFrom'),
    dateTo: parseOptionalDateOnly(query.dateTo, 'dateTo'),
    onlyMyOrders: parseBoolean(query.onlyMyOrders, false),
    deleted: parseOptionalBoolean(query.deleted, 'deleted'),
    groupIds: parseGroupIds(query.groupIds),
    groupMode: parseGroupMode(query.groupMode),
  };

  if (parsed.sortBy === 'deletedAt' && parsed.deleted !== true) {
    throw validationError('sortBy', 'sortBy=deletedAt requires deleted=true');
  }

  return parsed;
}

export function rejectUnsupportedGroupTemporalQuery(
  query: Record<string, string | string[] | undefined>,
): void {
  for (const field of ['asOf', 'overlap', 'factTime']) {
    if (query[field] !== undefined) {
      throw validationError(field, `${field} is not supported for P1-P3 current group links`);
    }
  }
}

export function parseOrderId(value: string): number {
  const orderId = Number(value);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Invalid order id', {
      field: 'orderId',
    });
  }

  return orderId;
}

export function parseOrderAuditQuery(
  query: Record<string, string | string[] | undefined>,
): { page: number; pageSize: number } {
  return {
    page: parsePositiveInteger(query.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInteger(query.pageSize, 'pageSize', 50, 1, 200),
  };
}

export function parseIfMatchVersion(value: string | string[] | undefined): number {
  const raw = singleValue(value)?.trim();

  if (!raw) {
    throw headerError('If-Match', 'If-Match header is required');
  }

  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;

  if (!/^\d+$/.test(unquoted)) {
    throw headerError('If-Match', 'If-Match must be a non-negative integer version');
  }

  const version = Number(unquoted);

  if (!Number.isSafeInteger(version)) {
    throw headerError('If-Match', 'If-Match must be a safe integer version');
  }

  return version;
}

export function parseIdempotencyKeyHeader(value: string | string[] | undefined): string {
  const idempotencyKey = singleValue(value)?.trim();

  if (!idempotencyKey) {
    throw headerError('Idempotency-Key', 'Idempotency-Key header is required');
  }

  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw headerError('Idempotency-Key', 'Idempotency-Key length must be between 8 and 200');
  }

  return idempotencyKey;
}

export function parseTransferOrderDetailsRequest(body: unknown): TransferOrderDetailsDto {
  if (!isRecord(body)) {
    throw validationError('body', 'Transfer payload must be an object');
  }

  const detailIds = parseTransferDetailIds(body.detailIds);
  const target = parseTransferTarget(body.target);
  const note = body.note === undefined || body.note === null ? undefined : String(body.note).trim();
  if (note !== undefined && note.length > 500) {
    throw validationError('note', 'note must be 500 characters or fewer');
  }

  return {
    detailIds,
    target,
    ...(note ? { note } : {}),
  };
}

function headerError(header: string, message: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', message, { header });
}

function parseTransferDetailIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw validationError('detailIds', 'detailIds must be an array');
  }
  if (value.length === 0) {
    throw validationError('detailIds', 'detailIds must not be empty');
  }
  if (value.length > 500) {
    throw validationError('detailIds', 'detailIds supports at most 500 IDs');
  }
  const ids = value.map((item, index) => {
    const parsed = Number(item);
    if (!Number.isInteger(parsed) || parsed <= 0 || !Number.isSafeInteger(parsed)) {
      throw validationError(`detailIds[${index}]`, 'detail id must be a positive integer');
    }
    return parsed;
  });
  if (new Set(ids).size !== ids.length) {
    throw validationError('detailIds', 'detailIds must not contain duplicates');
  }
  return ids;
}

function parseTransferTarget(value: unknown): TransferOrderDetailsDto['target'] {
  if (!isRecord(value)) {
    throw validationError('target', 'target must be an object');
  }
  if (value.mode === 'existing') {
    const orderId = Number(value.orderId);
    const version = Number(value.version);
    if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isSafeInteger(orderId)) {
      throw validationError('target.orderId', 'target.orderId must be a positive integer');
    }
    if (
      value.version === null ||
      value.version === undefined ||
      value.version === '' ||
      !Number.isInteger(version) ||
      version < 0 ||
      !Number.isSafeInteger(version)
    ) {
      throw validationError('target.version', 'target.version must be a non-negative integer');
    }
    return { mode: 'existing', orderId, version };
  }
  if (value.mode === 'new') {
    const orderName = String(value.orderName ?? '').trim();
    if (!orderName || orderName.length > 200) {
      throw validationError('target.orderName', 'target.orderName must be 1-200 characters');
    }
    const projectId =
      value.projectId === undefined || value.projectId === null || value.projectId === ''
        ? undefined
        : Number(value.projectId);
    if (projectId !== undefined && (!Number.isInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(projectId))) {
      throw validationError('target.projectId', 'target.projectId must be a positive integer');
    }
    return { mode: 'new', orderName, ...(projectId === undefined ? {} : { projectId }) };
  }
  throw validationError('target.mode', 'target.mode must be existing or new');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSortBy(value: string | string[] | undefined): OrderListSortBy {
  const sortBy = singleValue(value) ?? 'updatedAt';

  if (!ORDER_LIST_SORT_FIELDS.includes(sortBy as OrderListSortBy)) {
    throw validationError('sortBy', 'Unsupported sort field', {
      allowedValues: [...ORDER_LIST_SORT_FIELDS],
    });
  }

  return sortBy as OrderListSortBy;
}

function parseSortOrder(value: string | string[] | undefined): SortOrder {
  const sortOrder = singleValue(value) ?? 'desc';

  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw validationError('sortOrder', 'sortOrder must be asc or desc');
  }

  return sortOrder;
}

function parseSearch(value: string | string[] | undefined): string | undefined {
  const search = singleValue(value)?.trim();
  if (!search) return undefined;

  if (search.length > 200) {
    throw validationError('search', 'search must be 200 characters or fewer');
  }

  return search;
}

function parseOptionalPositiveInteger(
  value: string | string[] | undefined,
  field: string,
): number | undefined {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') return undefined;

  return parsePositiveInteger(raw, field, undefined, 1, Number.MAX_SAFE_INTEGER);
}

function parsePositiveInteger(
  value: string | string[] | undefined,
  field: string,
  fallback: number | undefined,
  min: number,
  max: number,
): number {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      throw validationError(field, `${field} is required`);
    }
    return fallback;
  }

  const numberValue = Number(raw);
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw validationError(field, `${field} must be an integer between ${min} and ${max}`);
  }

  return numberValue;
}

function parseOptionalDateOnly(
  value: string | string[] | undefined,
  field: string,
): string | undefined {
  const raw = singleValue(value);
  if (!raw) return undefined;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw validationError(field, `${field} must use YYYY-MM-DD format`);
  }

  return raw;
}

function parseBoolean(value: string | string[] | undefined, fallback: boolean): boolean {
  const parsed = parseOptionalBoolean(value, 'onlyMyOrders');
  return parsed ?? fallback;
}

function parseOptionalBoolean(
  value: string | string[] | undefined,
  field: string,
): boolean | undefined {
  const raw = singleValue(value);
  if (raw === undefined || raw === '') return undefined;

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  throw validationError(field, `${field} must be true or false`);
}

function parseGroupIds(value: string | string[] | undefined): string[] | undefined {
  const raw = singleValue(value)?.trim();
  if (!raw) return undefined;

  const values = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (values.length === 0) return undefined;
  if (values.length > 50) {
    throw validationError('groupIds', 'groupIds supports at most 50 IDs');
  }

  const invalid = values.find((item) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item));
  if (invalid) {
    throw validationError('groupIds', 'groupIds must be comma-separated UUIDs');
  }

  return [...new Set(values)];
}

function parseGroupMode(value: string | string[] | undefined): OrderListQuery['groupMode'] {
  const mode = singleValue(value)?.trim();
  if (!mode) return undefined;
  if (mode === 'any' || mode === 'all' || mode === 'primary' || mode === 'none') return mode;
  throw validationError('groupMode', 'groupMode must be any, all, primary, or none');
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validationError(
  field: string,
  message: string,
  extraDetails: Record<string, unknown> = {},
): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Order query validation failed', {
    errors: [{ field, message }],
    ...extraDetails,
  });
}
