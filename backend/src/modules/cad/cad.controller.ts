import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../permissions/current-user';
import { cadGroupSchema, cadRecipeSchema } from '../../shared/cad-api';
import { CadService } from './cad.service';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(422, 'CAD_VALIDATION_ERROR', 'Invalid CAD request', { issues: result.error.issues });
  return result.data;
}
const numberId = (value: string) => parse(z.coerce.number().int().positive(), value);
const uuid = (value: string) => parse(z.string().uuid(), value);
const versionBody = z.object({ version: z.number().int().positive() }).strict();
const saveBody = versionBody.extend({ groups: z.array(cadGroupSchema).max(500), sourceIds: z.array(z.string().uuid()).min(1).max(500) }).strict();
const cloneBody = z.object({ name: z.string().trim().min(1).max(100), refresh: z.boolean().default(false) }).strict();
const packageBody = versionBody.extend({ reviewId: z.string().uuid(), acknowledgeStale: z.boolean().default(false) }).strict();

@ApiTags('CAD preparation')
@ApiBearerAuth('bearerAuth')
@Controller('cad')
export class CadController {
  constructor(@Inject(CadService) private readonly cad: CadService) {}
  private user(req: RequestWithCurrentUser) { if (!req.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required'); return req.user; }
  @ApiOperation({ summary: 'Get CAD availability and capabilities' })
  @Get('capabilities')
  async capabilities(@Req() req: RequestWithCurrentUser) {
    const user = this.user(req);
    if (!user.permissions.includes('cad.view')) throw new ApiError(403, 'PERMISSION_DENIED', 'CAD permission required');
    if (!this.cad.enabled) return { enabled: false };
    this.cad.require(user, 'cad.view');
    const remote = await this.cad.client.capabilities();
    return { enabled: true, ...remote, editorEnabled: this.cad.editorEnabled && remote.editor_version === 2 };
  }
  @ApiOperation({ summary: 'List CAD recipes' })
  @Get('recipes')
  async recipes(@Req() req: RequestWithCurrentUser) { this.cad.require(this.user(req), 'cad.view'); return this.cad.client.catalog(); }
  @ApiOperation({ summary: 'List milling type recipe mappings' })
  @Get('mappings')
  mappings(@Req() req: RequestWithCurrentUser) { return this.cad.mappings(this.user(req)); }
  @ApiOperation({ summary: 'Update a milling type recipe mapping' })
  @Post('mappings/:id')
  map(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    const value = parse(z.object({ recipe: cadRecipeSchema, revision: z.number().int().nonnegative() }).strict(), body);
    return this.cad.mapRecipe(this.user(req), numberId(id), value.recipe, value.revision, key);
  }
  @ApiOperation({ summary: 'Get the CAD workspace for an order' })
  @Get('orders/:id')
  workspace(@Req() req: RequestWithCurrentUser, @Param('id') id: string) { return this.cad.workspace(this.user(req), numberId(id)); }
  @ApiOperation({ summary: 'Create and render the original CAD variant' })
  @Post('orders/:id/render')
  create(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string) { return this.cad.create(this.user(req), numberId(id), key); }
  @ApiOperation({ summary: 'Capture an order source snapshot' })
  @Post('orders/:id/source')
  source(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string) { return this.cad.source(this.user(req), numberId(id), key); }
  @ApiOperation({ summary: 'Save a CAD variant revision' })
  @Post('variants/:id/save')
  save(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    const v = parse(saveBody, body); return this.cad.save(this.user(req), uuid(id), v.version, v.groups, v.sourceIds, key);
  }
  @ApiOperation({ summary: 'Fork own draft from an exact archived CAD revision' })
  @Post('variants/:id/fork')
  fork(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    const v = parse(saveBody.extend({ name: z.string().trim().min(1).max(100) }).strict(), body);
    return this.cad.fork(this.user(req), uuid(id), v.version, v.name, v.groups, v.sourceIds, key);
  }
  @ApiOperation({ summary: 'Preview up to twenty CAD parts without export artifacts' })
  @Post('variants/:id/preview')
  preview(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Body() body: unknown) {
    const v = parse(versionBody.extend({ groups: z.array(cadGroupSchema).min(1).max(20) }).strict(), body);
    return this.cad.preview(this.user(req), uuid(id), v.version, v.groups);
  }
  @ApiOperation({ summary: 'Review CAD export eligibility and current source differences' })
  @Post('variants/:id/preflight')
  preflight(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    return this.cad.preflight(this.user(req), uuid(id), parse(versionBody, body).version, key);
  }
  @ApiOperation({ summary: 'Request a scoped approval for one frozen CAD part' })
  @Post('variants/:id/approve')
  approve(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    const v = parse(versionBody.extend({ groupId: z.string().uuid(), manufacturingHash: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(1000) }).strict(), body);
    return this.cad.requestApproval(this.user(req), uuid(id), v.version, v.groupId, v.manufacturingHash, v.reason, key);
  }
  @ApiOperation({ summary: 'Get the durable CAD approval receipt status' })
  @Get('approval-commands/:id')
  approval(@Req() req: RequestWithCurrentUser, @Param('id') id: string) { return this.cad.approvalStatus(this.user(req), uuid(id)); }
  @ApiOperation({ summary: 'Compare CAD sources with current order details' })
  @Get('variants/:id/source-status')
  sourceStatus(@Req() req: RequestWithCurrentUser, @Param('id') id: string) { return this.cad.sourceStatus(this.user(req), uuid(id)); }
  @ApiOperation({ summary: 'Clone a CAD variant' })
  @Post('variants/:id/clone')
  clone(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    const v = parse(cloneBody, body); return this.cad.clone(this.user(req), uuid(id), v.name, v.refresh, key);
  }
  @ApiOperation({ summary: 'Render a CAD variant revision' })
  @Post('variants/:id/render')
  render(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    return this.cad.render(this.user(req), uuid(id), parse(versionBody, body).version, key);
  }
  @ApiOperation({ summary: 'Get the render run for a CAD revision' })
  @Get('variants/:id/runs/:revision')
  run(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Param('revision') revision: string) { return this.cad.run(this.user(req), uuid(id), numberId(revision)); }
  @ApiOperation({ summary: 'Request an approved CAD production package' })
  @Post('variants/:id/package')
  package(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    const v = parse(packageBody, body);
    return this.cad.requestPackage(this.user(req), uuid(id), v.version, key, v.reviewId, v.acknowledgeStale);
  }
  @ApiOperation({ summary: 'Download an artifact from an approved CAD run' })
  @Get('runs/:runId/artifacts/:id')
  async download(@Req() req: RequestWithCurrentUser, @Param('runId') runId: string, @Param('id') id: string, @Query('reviewId') reviewId: string, @Res() res: Response) {
    const response = await this.cad.download(this.user(req), uuid(runId), parse(z.string().regex(/^[a-z0-9]{32}$/), id), uuid(reviewId));
    res.setHeader('Content-Type', response.headers.get('Content-Type') ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
    res.send(Buffer.from(await response.arrayBuffer()));
  }
}
