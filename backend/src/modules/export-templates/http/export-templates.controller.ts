import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ExportTemplatesService } from '../application/export-templates.service';
import {
  availableExportTemplatesQuerySchema,
  createExportTemplateSchema,
  deleteExportTemplateSchema,
  listExportTemplatesQuerySchema,
  previewExportTemplateSchema,
  setDefaultExportTemplateSchema,
  updateExportTemplateSchema,
} from '../dto/export-template.dto';

@ApiTags('ExportTemplates')
@ApiBearerAuth()
@Controller('export-templates')
export class ExportTemplatesController {
  constructor(private readonly service: ExportTemplatesService) {}

  @ApiOperation({ operationId: 'getExportTemplateCatalog', summary: 'Get export template fields and formula capabilities' })
  @Get('catalog')
  catalog(@Req() request: RequestWithCurrentUser) { return this.service.getCatalog(requireUser(request)); }

  @ApiOperation({ operationId: 'listAvailableExportTemplates', summary: 'List active templates available on an export screen' })
  @Get('available')
  available(@Req() request: RequestWithCurrentUser, @Query() query: unknown) {
    return this.service.available(requireUser(request), parse(availableExportTemplatesQuerySchema, query));
  }

  @ApiOperation({ operationId: 'previewExportTemplate', summary: 'Validate and preview export columns' })
  @Post('preview')
  preview(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    assertRawExpressionBudget(body);
    return this.service.preview(requireUser(request), parse(previewExportTemplateSchema, body));
  }

  @ApiOperation({ operationId: 'listExportTemplates', summary: 'List export templates for administration' })
  @Get()
  list(@Req() request: RequestWithCurrentUser, @Query() query: unknown) {
    const parsed = parse(listExportTemplatesQuerySchema, query);
    return this.service.list(requireUser(request), { ...parsed, includeInactive: parsed.includeInactive === 'true' });
  }

  @ApiOperation({ operationId: 'getExportTemplate', summary: 'Get an export template' })
  @Get(':id')
  get(@Req() request: RequestWithCurrentUser, @Param('id') id: string) {
    return this.service.get(requireUser(request), parseId(id));
  }

  @ApiOperation({ operationId: 'createExportTemplate', summary: 'Create an export template' })
  @Post()
  create(@Req() request: RequestWithCurrentUser, @Body() body: unknown) {
    assertRawExpressionBudget(body);
    return this.service.create(requireUser(request), request.requestId ?? 'export-template-create',
      parse(createExportTemplateSchema, body));
  }

  @ApiOperation({ operationId: 'updateExportTemplate', summary: 'Update an export template' })
  @Put(':id')
  update(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown) {
    assertRawExpressionBudget(body);
    return this.service.update(requireUser(request), request.requestId ?? 'export-template-update', parseId(id),
      parse(updateExportTemplateSchema, body));
  }

  @ApiOperation({ operationId: 'setDefaultExportTemplate', summary: 'Atomically set the default export template' })
  @Post(':id/set-default')
  setDefault(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setDefault(requireUser(request), request.requestId ?? 'export-template-set-default', parseId(id),
      parse(setDefaultExportTemplateSchema, body));
  }

  @ApiOperation({ operationId: 'deleteExportTemplate', summary: 'Soft-delete an export template' })
  @Delete(':id')
  @HttpCode(204)
  async delete(@Req() request: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown): Promise<void> {
    await this.service.delete(requireUser(request), request.requestId ?? 'export-template-delete', parseId(id),
      parse(deleteExportTemplateSchema, body));
  }
}

function requireUser(request: RequestWithCurrentUser) {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'BAD_REQUEST', 'Invalid export template id');
  return id;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(422, 'VALIDATION_ERROR', 'Export template validation failed', {
    errors: result.error.issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message })),
  });
}

/** Bounds the untrusted recursive shape before Zod descends into it. */
function assertRawExpressionBudget(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const columns = (value as Record<string, unknown>).columns;
  if (!Array.isArray(columns)) return;
  if (columns.length > 100) throw rawBudgetError('columns', 'Too many columns');
  columns.forEach((column, columnIndex) => {
    const expression = column && typeof column === 'object' && !Array.isArray(column)
      ? (column as Record<string, unknown>).expression : undefined;
    const stack: Array<{ node: unknown; depth: number }> = [{ node: expression, depth: 1 }];
    let nodes = 0;
    while (stack.length > 0) {
      const current = stack.pop()!;
      nodes += 1;
      if (nodes > 100) throw rawBudgetError(`columns.${columnIndex}.expression`, 'Too many expression nodes');
      if (current.depth > 8) throw rawBudgetError(`columns.${columnIndex}.expression`, 'Expression is too deep');
      if (!current.node || typeof current.node !== 'object' || Array.isArray(current.node)) continue;
      const node = current.node as Record<string, unknown>;
      const children: unknown[] = [];
      if (Array.isArray(node.parts)) {
        if (node.parts.length > 20) throw rawBudgetError(`columns.${columnIndex}.expression.parts`, 'Too many expression parts');
        children.push(...node.parts);
      }
      if (node.input !== undefined) children.push(node.input);
      if (node.then !== undefined) children.push(node.then);
      if (node.else !== undefined) children.push(node.else);
      if (node.when && typeof node.when === 'object' && !Array.isArray(node.when)) {
        const when = node.when as Record<string, unknown>;
        if (when.left !== undefined) children.push(when.left);
        if (when.right !== undefined) children.push(when.right);
      }
      children.forEach((child) => stack.push({ node: child, depth: current.depth + 1 }));
    }
  });
}

function rawBudgetError(field: string, message: string): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Export template validation failed', {
    errors: [{ field, message }],
  });
}
