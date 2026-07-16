import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { SaveOrderDto } from '../../orders/dto/save-order.dto';
import { BazisService } from '../application/bazis.service';
import type {
  BazisAddToOrderRequestDto,
  BazisAddToOrderResponseDto,
  BazisRevisionEstimateDto,
  CreateOrderFromDraftRequestDto,
  BazisImportResponseDto,
  BazisNodeCardDto,
  BazisNodeNotesDto,
  BazisOrderDraftResponseDto,
  BazisNodeSearchResponseDto,
  BazisProjectCardDto,
  BazisProjectDeleteResponseDto,
  BazisProjectListItemDto,
  BazisRevisionMaterialsSummaryDto,
  BazisRevisionOrderDto,
  BazisTreeNodeDto,
  CreateOrderFromRevisionResponseDto,
  MaterialMappingDto,
  UpsertMaterialMappingDto,
} from '../dto/bazis.dto';
import { BazisRuntimeConfigService } from './bazis-runtime-config.service';

const { diskStorage }: { diskStorage: (options: { destination: string }) => unknown } = require('multer');
const swaggerSchema = (schema: unknown): SchemaObject => schema as SchemaObject;
const numericIdSchema = z.coerce.number().int().positive();
const optionalNumericIdSchema = numericIdSchema.optional();

const importFieldsSchema = z.object({
  projectId: optionalNumericIdSchema,
  bazisProjectId: optionalNumericIdSchema,
});

const listProjectsQuerySchema = z.object({
  projectId: optionalNumericIdSchema,
});

const treeQuerySchema = z
  .object({
    parentNodeId: optionalNumericIdSchema,
    all: z
      .string()
      .optional()
      .transform((value) => value === 'true'),
  })
  .refine((value) => !(value.all && value.parentNodeId != null), {
    message: 'all=true несовместим с parentNodeId',
    path: ['all'],
  });

const nodeSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    objectType: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine((value) => value.q != null || value.objectType != null, {
    message: 'Нужен q или objectType',
    path: ['q'],
  });

const materialMappingsQuerySchema = z.object({
  names: z.string().trim().min(1).optional(),
});

const materialMappingItemSchema = z
  .object({
    sourceKind: z.enum(['sheet', 'film', 'edge']),
    bazisName: z.string().trim().min(1).max(255),
    targetKind: z.enum(['sheet', 'film', 'edge', 'ignore']),
    sheetMaterialTypeId: optionalNumericIdSchema.nullish(),
    filmId: optionalNumericIdSchema.nullish(),
    edgeTypeId: optionalNumericIdSchema.nullish(),
  })
  .superRefine((item, ctx) => {
    // Кросс-контекстный маппинг (sheet→film и т.п.) семантически невозможен:
    // buildOrderCreateDto читает sheet-маппинги только для sheet-контекста и
    // film — для film; такая строка молча no-op'ится (Critic R2 finding 1).
    if (item.targetKind !== 'ignore' && item.targetKind !== item.sourceKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetKind'],
        message: `targetKind must be '${item.sourceKind}' or 'ignore' for sourceKind=${item.sourceKind}`,
      });
      return;
    }

    const present = {
      sheetMaterialTypeId: item.sheetMaterialTypeId ?? null,
      filmId: item.filmId ?? null,
      edgeTypeId: item.edgeTypeId ?? null,
    };

    if (item.targetKind === 'sheet') {
      if (present.sheetMaterialTypeId == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sheetMaterialTypeId'], message: 'sheetMaterialTypeId is required for targetKind=sheet' });
      }
      if (present.filmId != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filmId'], message: 'filmId must be empty for targetKind=sheet' });
      }
      if (present.edgeTypeId != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edgeTypeId'], message: 'edgeTypeId must be empty for targetKind=sheet' });
      }
    }

    if (item.targetKind === 'film') {
      if (present.filmId == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filmId'], message: 'filmId is required for targetKind=film' });
      }
      if (present.sheetMaterialTypeId != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sheetMaterialTypeId'], message: 'sheetMaterialTypeId must be empty for targetKind=film' });
      }
      if (present.edgeTypeId != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edgeTypeId'], message: 'edgeTypeId must be empty for targetKind=film' });
      }
    }

    if (item.targetKind === 'edge') {
      if (present.edgeTypeId == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edgeTypeId'], message: 'edgeTypeId is required for targetKind=edge' });
      }
      if (present.sheetMaterialTypeId != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sheetMaterialTypeId'], message: 'sheetMaterialTypeId must be empty for targetKind=edge' });
      }
      if (present.filmId != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filmId'], message: 'filmId must be empty for targetKind=edge' });
      }
    }

    if (item.targetKind === 'ignore') {
      if (present.sheetMaterialTypeId != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sheetMaterialTypeId'], message: 'sheetMaterialTypeId must be empty for targetKind=ignore' });
      }
      if (present.filmId != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filmId'], message: 'filmId must be empty for targetKind=ignore' });
      }
      if (present.edgeTypeId != null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edgeTypeId'], message: 'edgeTypeId must be empty for targetKind=ignore' });
      }
    }
  });

const upsertMappingsBodySchema = z.object({
  items: z.array(materialMappingItemSchema),
});

const createOrderFromRevisionBodySchema = z.object({
  clientId: z.coerce.number().int().positive(),
  orderName: z.string().trim().min(1).max(200),
  orderStatusId: z.coerce.number().int().positive(),
  selectedNodeIds: z.array(z.coerce.number().int().positive()).min(1),
  idempotencyKey: z.string().min(8).max(200),
});

const createOrderFromDraftBodySchema = z.object({
  order: z
    .object({
      header: z.object({}).passthrough(),
      details: z.array(z.object({}).passthrough()),
    })
    .passthrough(),
  nodes: z.array(
    z.object({
      clientKey: z.string().trim().min(1).max(255),
      bazisNodeId: z.coerce.number().int().positive(),
    }),
  ),
  idempotencyKey: z.string().trim().min(1).max(200),
});

const addToOrderPairSchema = z.object({
  bazisNodeId: z.coerce.number().int().positive(),
  orderDetailId: z.coerce.number().int().positive(),
});

const addToOrderBodySchema = z.object({
  orderId: z.coerce.number().int().positive(),
  adds: z.array(z.coerce.number().int().positive()),
  replaces: z.array(addToOrderPairSchema),
  skips: z.array(addToOrderPairSchema),
  idempotencyKey: z.string().trim().min(1).max(200),
});

const buildOrderDraftBodySchema = z.object({
  selectedNodeIds: z.array(z.coerce.number().int().positive()).min(1).max(500),
  targetOrderId: optionalNumericIdSchema.nullish(),
});

const setNodeNotesSchema = z
  .object({
    notes: z.union([z.string(), z.null()]),
  })
  .strict();

const importRequestSwaggerSchema = {
  type: 'object',
  required: ['file'],
  properties: {
    file: { type: 'string', format: 'binary' },
    projectId: { type: 'integer' },
    bazisProjectId: { type: 'integer' },
  },
} as const;

const upsertMappingsRequestSwaggerSchema = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sourceKind', 'bazisName', 'targetKind'],
        properties: {
          sourceKind: { type: 'string', enum: ['sheet', 'film', 'edge'] },
          bazisName: { type: 'string', minLength: 1, maxLength: 255 },
          targetKind: { type: 'string', enum: ['sheet', 'film', 'edge', 'ignore'] },
          sheetMaterialTypeId: { type: 'integer', nullable: true },
          filmId: { type: 'integer', nullable: true },
          edgeTypeId: { type: 'integer', nullable: true },
        },
      },
    },
  },
} as const;

const createOrderFromRevisionRequestSwaggerSchema = {
  type: 'object',
  required: ['clientId', 'orderName', 'orderStatusId', 'selectedNodeIds', 'idempotencyKey'],
  properties: {
    clientId: { type: 'integer' },
    orderName: { type: 'string', minLength: 1, maxLength: 200 },
    orderStatusId: { type: 'integer' },
    selectedNodeIds: {
      type: 'array',
      minItems: 1,
      items: { type: 'integer' },
    },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

const createOrderFromDraftRequestSwaggerSchema = {
  type: 'object',
  required: ['order', 'nodes', 'idempotencyKey'],
  properties: {
    order: {
      $ref: '#/components/schemas/SaveOrderDto',
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['clientKey', 'bazisNodeId'],
        properties: {
          clientKey: { type: 'string', minLength: 1, maxLength: 255 },
          bazisNodeId: { type: 'integer' },
        },
      },
    },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

const addToOrderRequestSwaggerSchema = {
  type: 'object',
  required: ['orderId', 'adds', 'replaces', 'skips', 'idempotencyKey'],
  properties: {
    orderId: { type: 'integer' },
    adds: {
      type: 'array',
      items: { type: 'integer' },
    },
    replaces: {
      type: 'array',
      items: {
        type: 'object',
        required: ['bazisNodeId', 'orderDetailId'],
        properties: {
          bazisNodeId: { type: 'integer' },
          orderDetailId: { type: 'integer' },
        },
      },
    },
    skips: {
      type: 'array',
      items: {
        type: 'object',
        required: ['bazisNodeId', 'orderDetailId'],
        properties: {
          bazisNodeId: { type: 'integer' },
          orderDetailId: { type: 'integer' },
        },
      },
    },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

const buildOrderDraftRequestSwaggerSchema = {
  type: 'object',
  required: ['selectedNodeIds'],
  properties: {
    selectedNodeIds: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: { type: 'integer' },
    },
    targetOrderId: { type: 'integer', nullable: true },
  },
} as const;

interface UploadedBazisFile {
  path?: string;
  size?: number;
  originalname?: string;
}

@ApiTags('Bazis')
@ApiBearerAuth()
@Controller('bazis')
export class BazisController {
  constructor(
    @Inject(BazisService)
    private readonly bazis: BazisService,
    @Inject(BazisRuntimeConfigService)
    private readonly runtimeConfig: BazisRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'importBazisXml', summary: 'Import a Bazis XML revision' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: swaggerSchema(importRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'Imported Bazis revision' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Import conflict' })
  @ApiResponse({ status: 422, description: 'Invalid import payload' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Post('imports')
  @HttpCode(201)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: tmpdir() }),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async importXml(
    @Req() request: RequestWithCurrentUser,
    @UploadedFile() uploadedFile: unknown,
    @Body() body: unknown,
  ): Promise<BazisImportResponseDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    const file = uploadedFile as UploadedBazisFile | undefined;

    if (!file?.path || !file.size) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Файл не передан');
    }

    const fields = parseBazisImportFields(body);
    if (fields.projectId == null && fields.bazisProjectId == null) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Нужен projectId или bazisProjectId');
    }

    try {
      return await this.bazis.importXml({
        currentUser,
        requestId: request.requestId,
        projectId: fields.projectId ?? null,
        bazisProjectId: fields.bazisProjectId ?? null,
        fileName: file.originalname ?? 'bazis.xml',
        filePath: file.path,
      });
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  @ApiOperation({ operationId: 'listBazisProjects', summary: 'List Bazis projects' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid list query' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Get('projects')
  async listProjects(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<BazisProjectListItemDto[]> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.bazis.listProjects(currentUser, parseListProjectsQuery(query));
  }

  @ApiOperation({ operationId: 'deleteBazisProject', summary: 'Delete a Bazis project (hard, gated by created orders)' })
  @ApiResponse({ status: 200, description: 'Deleted Bazis project summary' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis project not found' })
  @ApiResponse({ status: 409, description: 'Orders were created from this Bazis project' })
  @ApiResponse({ status: 422, description: 'Invalid project id' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Delete('projects/:id')
  async deleteProject(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
  ): Promise<BazisProjectDeleteResponseDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.bazis.deleteProject(currentUser, request.requestId, parseNumericPathParam(id, 'id'));
  }

  @ApiOperation({ operationId: 'getBazisProject', summary: 'Get Bazis project card' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid project id' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Get('projects/:id')
  async getProject(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
  ): Promise<BazisProjectCardDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.bazis.getProject(currentUser, parseNumericPathParam(id, 'id'));
  }

  @ApiOperation({ operationId: 'getBazisRevisionTree', summary: 'Get Bazis revision tree level (or full tree with all=true)' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis revision not found (all=true)' })
  @ApiResponse({ status: 422, description: 'Invalid tree query' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Get('revisions/:id/tree')
  async getTree(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<BazisTreeNodeDto[]> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    const parsed = parseRevisionTreeQuery(query);
    const revisionId = parseNumericPathParam(id, 'id');
    if (parsed.all) {
      return this.bazis.getFullTree(currentUser, revisionId);
    }
    return this.bazis.getTree(currentUser, revisionId, parsed.parentNodeId);
  }

  @ApiOperation({ operationId: 'getBazisNodeCard', summary: 'Get Bazis node card with raw payload' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis node not found' })
  @ApiResponse({ status: 422, description: 'Invalid node id' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Get('nodes/:id')
  async getNodeCard(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
  ): Promise<BazisNodeCardDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.bazis.getNodeCard(currentUser, parseNumericPathParam(id, 'id'));
  }

  @ApiOperation({ operationId: 'setBazisNodeNotes', summary: 'Set operator notes on a Bazis node' })
  @ApiResponse({ status: 200, description: 'Updated node notes' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis node not found' })
  @ApiResponse({ status: 422, description: 'Invalid notes payload' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Patch('nodes/:id/notes')
  async setNodeNotes(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BazisNodeNotesDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    const parsed = parseSetNodeNotesBody(body);
    return this.bazis.setNodeNotes(currentUser, request.requestId, parseNumericPathParam(id, 'id'), parsed.notes);
  }

  @ApiOperation({ operationId: 'searchBazisRevisionNodes', summary: 'Search nodes within a Bazis revision' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis revision not found' })
  @ApiResponse({ status: 422, description: 'Invalid node search query' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Get('revisions/:id/nodes/search')
  async searchNodes(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<BazisNodeSearchResponseDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.bazis.searchNodes(currentUser, parseNumericPathParam(id, 'id'), parseNodeSearchQuery(query));
  }

  @ApiOperation({ operationId: 'getBazisRevisionMaterialsSummary', summary: 'Get materials summary for a Bazis revision' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis revision not found' })
  @ApiResponse({ status: 422, description: 'Invalid revision id' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Get('revisions/:id/materials-summary')
  async getMaterialsSummary(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
  ): Promise<BazisRevisionMaterialsSummaryDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.bazis.getMaterialsSummary(currentUser, parseNumericPathParam(id, 'id'));
  }

  @ApiOperation({ operationId: 'getBazisRevisionEstimate', summary: 'Get materials/operations estimate for a Bazis revision' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis revision not found' })
  @ApiResponse({ status: 422, description: 'Invalid revision id' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Get('revisions/:id/estimate')
  async getRevisionEstimate(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
  ): Promise<BazisRevisionEstimateDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.bazis.getRevisionEstimate(currentUser, parseNumericPathParam(id, 'id'));
  }

  @ApiOperation({ operationId: 'listBazisRevisionOrders', summary: 'List ERP orders created from a Bazis revision' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis revision not found' })
  @ApiResponse({ status: 422, description: 'Invalid revision id' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Get('revisions/:id/orders')
  async listRevisionOrders(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
  ): Promise<BazisRevisionOrderDto[]> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    return this.bazis.listRevisionOrders(currentUser, parseNumericPathParam(id, 'id'));
  }

  @ApiOperation({ operationId: 'createOrderFromBazisRevision', summary: 'Create ERP order from a Bazis revision selection' })
  @ApiBody({ schema: swaggerSchema(createOrderFromRevisionRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'ERP order created from Bazis revision' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid create-order payload' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Post('revisions/:id/create-order')
  @HttpCode(201)
  async createOrderFromRevision(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CreateOrderFromRevisionResponseDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    const parsed = parseCreateOrderFromRevisionBody(body);
    return this.bazis.createOrderFromRevision({
      currentUser,
      requestId: request.requestId,
      revisionId: parseNumericPathParam(id, 'id'),
      clientId: parsed.clientId,
      orderName: parsed.orderName,
      orderStatusId: parsed.orderStatusId,
      selectedNodeIds: parsed.selectedNodeIds,
      idempotencyKey: parsed.idempotencyKey,
    });
  }

  @ApiOperation({ operationId: 'createOrderFromBazisDraft', summary: 'Create ERP order from a saved Bazis draft' })
  @ApiBody({ schema: swaggerSchema(createOrderFromDraftRequestSwaggerSchema) })
  @ApiResponse({ status: 201, description: 'ERP order created from Bazis draft' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis revision not found' })
  @ApiResponse({ status: 409, description: 'Idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid create-order payload' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Post('revisions/:revisionId/orders')
  @HttpCode(201)
  async createOrderFromDraft(
    @Req() request: RequestWithCurrentUser,
    @Param('revisionId') revisionId: string,
    @Body() body: unknown,
  ): Promise<CreateOrderFromRevisionResponseDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    const parsed = parseCreateOrderFromDraftBody(body);
    return this.bazis.createOrderFromDraft({
      currentUser,
      requestId: request.requestId,
      revisionId: parseNumericPathParam(revisionId, 'revisionId'),
      order: parsed.order,
      nodes: parsed.nodes,
      idempotencyKey: parsed.idempotencyKey,
    });
  }

  @ApiOperation({ operationId: 'addBazisPanelsToOrder', summary: 'Add selected Bazis panels to an existing ERP order' })
  @ApiBody({ schema: swaggerSchema(addToOrderRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'Selected Bazis panels added to ERP order' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis revision not found' })
  @ApiResponse({ status: 409, description: 'Duplicate resolution conflict or idempotency conflict' })
  @ApiResponse({ status: 422, description: 'Invalid add-to-order payload' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Post('revisions/:revisionId/add-to-order')
  @HttpCode(200)
  async addToOrder(
    @Req() request: RequestWithCurrentUser,
    @Param('revisionId') revisionId: string,
    @Body() body: unknown,
  ): Promise<BazisAddToOrderResponseDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    const parsed = parseAddToOrderBody(body);
    return this.bazis.addToOrder({
      currentUser,
      requestId: request.requestId,
      revisionId: parseNumericPathParam(revisionId, 'revisionId'),
      orderId: parsed.orderId,
      adds: parsed.adds,
      replaces: parsed.replaces,
      skips: parsed.skips,
      idempotencyKey: parsed.idempotencyKey,
    });
  }

  @ApiOperation({ operationId: 'buildBazisOrderDraft', summary: 'Build ERP order draft from a Bazis revision selection' })
  @ApiBody({ schema: swaggerSchema(buildOrderDraftRequestSwaggerSchema) })
  @ApiResponse({ status: 200, description: 'ERP order draft built from Bazis revision' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Bazis revision not found' })
  @ApiResponse({ status: 422, description: 'Invalid draft payload' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Post('revisions/:id/order-draft')
  @HttpCode(200)
  async buildOrderDraft(
    @Req() request: RequestWithCurrentUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BazisOrderDraftResponseDto> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    const parsed = parseBuildOrderDraftBody(body);
    return this.bazis.buildOrderDraft({
      currentUser,
      requestId: request.requestId,
      revisionId: parseNumericPathParam(id, 'id'),
      selectedNodeIds: parsed.selectedNodeIds,
      targetOrderId: parsed.targetOrderId ?? null,
    });
  }

  @ApiOperation({ operationId: 'listBazisMaterialMappings', summary: 'List Bazis material mappings' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid mappings query' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Get('material-mappings')
  async listMaterialMappings(
    @Req() request: RequestWithCurrentUser,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<MaterialMappingDto[]> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    const parsed = parseMaterialMappingsQuery(query);
    return this.bazis.listMaterialMappings(currentUser, parsed.names);
  }

  @ApiOperation({ operationId: 'upsertBazisMaterialMappings', summary: 'Upsert Bazis material mappings' })
  @ApiBody({ schema: swaggerSchema(upsertMappingsRequestSwaggerSchema) })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 422, description: 'Invalid mappings payload' })
  @ApiResponse({ status: 503, description: 'Bazis API is disabled' })
  @Put('material-mappings')
  async upsertMaterialMappings(
    @Req() request: RequestWithCurrentUser,
    @Body() body: unknown,
  ): Promise<MaterialMappingDto[]> {
    this.assertBazisEnabled();
    const currentUser = this.requireCurrentUser(request);
    const parsed = parseUpsertMaterialMappingsBody(body);
    return this.bazis.upsertMaterialMappings(currentUser, request.requestId, parsed.items);
  }

  private assertBazisEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().bazisEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Bazis API is disabled', {
        feature: 'bazis',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    return request.user;
  }
}

export function parseBazisImportFields(body: unknown): { projectId?: number; bazisProjectId?: number } {
  return parseWithZod(importFieldsSchema, body, 'Bazis import payload validation failed');
}

export function parseListProjectsQuery(
  query: Record<string, string | string[] | undefined>,
): { projectId?: number } {
  return parseWithZod(listProjectsQuerySchema, flattenQuery(query), 'Bazis projects query validation failed');
}

export function parseRevisionTreeQuery(
  query: Record<string, string | string[] | undefined>,
): { parentNodeId: number | null; all: boolean } {
  const parsed = parseWithZod(treeQuerySchema, flattenQuery(query), 'Bazis tree query validation failed');
  return { parentNodeId: parsed.parentNodeId ?? null, all: parsed.all };
}

export function parseNodeSearchQuery(
  query: Record<string, string | string[] | undefined>,
): { q: string | null; objectType: string | null; limit: number } {
  const parsed = parseWithZod(
    nodeSearchQuerySchema,
    flattenQuery(query),
    'Bazis node search query validation failed',
  );
  return { q: parsed.q ?? null, objectType: parsed.objectType ?? null, limit: parsed.limit ?? 50 };
}

export function parseMaterialMappingsQuery(
  query: Record<string, string | string[] | undefined>,
): { names?: string[] } {
  const parsed = parseWithZod(
    materialMappingsQuerySchema,
    flattenQuery(query),
    'Bazis material mappings query validation failed',
  );

  if (!parsed.names) {
    return {};
  }

  const names = parsed.names
    .split(',')
    .map((name) => decodeURIComponent(name).trim())
    .filter((name) => name.length > 0);

  return names.length > 0 ? { names } : {};
}

export function parseUpsertMaterialMappingsBody(body: unknown): { items: UpsertMaterialMappingDto[] } {
  return parseWithZod(
    upsertMappingsBodySchema,
    body,
    'Bazis material mappings payload validation failed',
  );
}

export function parseCreateOrderFromRevisionBody(body: unknown): {
  clientId: number;
  orderName: string;
  orderStatusId: number;
  selectedNodeIds: number[];
  idempotencyKey: string;
} {
  return parseWithZod(
    createOrderFromRevisionBodySchema,
    body,
    'Bazis create-order payload validation failed',
  );
}

export function parseCreateOrderFromDraftBody(body: unknown): CreateOrderFromDraftRequestDto {
  const parsed = parseWithZod(
    createOrderFromDraftBodySchema,
    body,
    'Bazis create-order-from-draft payload validation failed',
  );

  return {
    order: parsed.order as unknown as SaveOrderDto,
    nodes: parsed.nodes,
    idempotencyKey: parsed.idempotencyKey,
  };
}

export function parseAddToOrderBody(body: unknown): BazisAddToOrderRequestDto {
  return parseWithZod(
    addToOrderBodySchema,
    body,
    'Bazis add-to-order payload validation failed',
  );
}

export function parseBuildOrderDraftBody(body: unknown): {
  selectedNodeIds: number[];
  targetOrderId?: number | null;
} {
  return parseWithZod(
    buildOrderDraftBodySchema,
    body,
    'Bazis order-draft payload validation failed',
  );
}

export function parseSetNodeNotesBody(body: unknown): { notes: string | null } {
  return parseWithZod(setNodeNotesSchema, body, 'Bazis node notes payload validation failed');
}

function parseNumericPathParam(value: unknown, field: string): number {
  const parsed = numericIdSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError(parsed.error, 'Bazis path parameter validation failed', field);
  }

  return parsed.data;
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function flattenQuery(
  query: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(query).map(([key, value]) => [key, firstQueryValue(value)]));
}

function parseWithZod<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationError(parsed.error, message);
  }

  return parsed.data;
}

function validationError(error: z.ZodError, message: string, fallbackField?: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, {
    errors: error.issues.map((issue) => ({
      field: issue.path.join('.') || fallbackField || 'body',
      message: issue.message,
    })),
  });
}
