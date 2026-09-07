import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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

@ApiTags('CAD preparation')
@ApiBearerAuth()
@Controller('cad')
export class CadController {
  constructor(@Inject(CadService) private readonly cad: CadService) {}
  private user(req: RequestWithCurrentUser) { if (!req.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required'); return req.user; }
  @Get('capabilities')
  async capabilities(@Req() req: RequestWithCurrentUser) {
    const user = this.user(req);
    if (!user.permissions.includes('cad.view')) throw new ApiError(403, 'PERMISSION_DENIED', 'CAD permission required');
    if (!this.cad.enabled) return { enabled: false };
    this.cad.require(user, 'cad.view');
    return { enabled: true, ...await this.cad.client.capabilities() };
  }
  @Get('recipes')
  async recipes(@Req() req: RequestWithCurrentUser) { this.cad.require(this.user(req), 'cad.view'); return this.cad.client.catalog(); }
  @Get('mappings')
  mappings(@Req() req: RequestWithCurrentUser) { return this.cad.mappings(this.user(req)); }
  @Post('mappings/:id')
  map(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    const value = parse(z.object({ recipe: cadRecipeSchema, revision: z.number().int().nonnegative() }).strict(), body);
    return this.cad.mapRecipe(this.user(req), numberId(id), value.recipe, value.revision, key);
  }
  @Get('orders/:id')
  workspace(@Req() req: RequestWithCurrentUser, @Param('id') id: string) { return this.cad.workspace(this.user(req), numberId(id)); }
  @Post('orders/:id/render')
  create(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string) { return this.cad.create(this.user(req), numberId(id), key); }
  @Post('orders/:id/source')
  source(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string) { return this.cad.source(this.user(req), numberId(id), key); }
  @Post('variants/:id/save')
  save(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    const v = parse(saveBody, body); return this.cad.save(this.user(req), uuid(id), v.version, v.groups, v.sourceIds, key);
  }
  @Get('variants/:id/source-status')
  sourceStatus(@Req() req: RequestWithCurrentUser, @Param('id') id: string) { return this.cad.sourceStatus(this.user(req), uuid(id)); }
  @Post('variants/:id/clone')
  clone(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    const v = parse(cloneBody, body); return this.cad.clone(this.user(req), uuid(id), v.name, v.refresh, key);
  }
  @Post('variants/:id/render')
  render(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    return this.cad.render(this.user(req), uuid(id), parse(versionBody, body).version, key);
  }
  @Get('variants/:id/runs/:revision')
  run(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Param('revision') revision: string) { return this.cad.run(this.user(req), uuid(id), numberId(revision)); }
  @Post('variants/:id/package')
  package(@Req() req: RequestWithCurrentUser, @Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: unknown) {
    return this.cad.requestPackage(this.user(req), uuid(id), parse(versionBody, body).version, key);
  }
  @Get('runs/:runId/artifacts/:id')
  async download(@Req() req: RequestWithCurrentUser, @Param('runId') runId: string, @Param('id') id: string, @Res() res: Response) {
    const response = await this.cad.download(this.user(req), uuid(runId), parse(z.string().regex(/^[a-z0-9]{32}$/), id));
    res.setHeader('Content-Type', response.headers.get('Content-Type') ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
    res.send(Buffer.from(await response.arrayBuffer()));
  }
}
