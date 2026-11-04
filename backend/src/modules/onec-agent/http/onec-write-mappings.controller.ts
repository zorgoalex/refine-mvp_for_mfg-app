import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import type { OnecRequestContext } from '../application/onec-audit';
import { OnecWriteMappingsService } from '../application/onec-write-mappings.service';
import { OnecPermissionsGuard } from './onec-permissions.guard';

function user(request: RequestWithCurrentUser): CurrentUser {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

function context(request: RequestWithCurrentUser & { headers?: Record<string, string | string[] | undefined> }): OnecRequestContext {
  const raw = request.headers?.['x-correlation-id'];
  const correlation = Array.isArray(raw) ? raw[0] : raw;
  return { requestId: request.requestId ?? `onec-write-mappings-${Date.now()}`, correlationId: correlation ? correlation.slice(0, 100) : null };
}

/**
 * ERP → 1C business commands, phase 1: mappings of ERP items to 1C objects (plan 2026-11-04 §8.2). Read and write both
 * need onec.write.mappings (ERP user names are listed) plus onec.view (the 1C section itself, as in the UI; onec.view is
 * implied by onec.manage / onec.commands.send in the guard). Nothing here sends anything to 1C.
 */
@ApiTags('1C integration')
@Controller('onec/write-mappings')
@UseGuards(OnecPermissionsGuard)
export class OnecWriteMappingsController {
  constructor(@Inject(OnecWriteMappingsService) private readonly mappings: OnecWriteMappingsService) {}

  @ApiOperation({ summary: 'Mappings of ERP items to 1C objects for ERP → 1C commands, per kind' })
  @Get()
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions(['onec.view', 'onec.write.mappings'])
  list(@Query('agentId') agentId: string | undefined) {
    return this.mappings.list(agentId);
  }

  @ApiOperation({ summary: 'Live 1C mirror objects that a mapping kind may point to (at most 50)' })
  @Get('candidates')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions(['onec.view', 'onec.write.mappings'])
  candidates(@Query('agentId') agentId: string | undefined, @Query('kind') kind: string | undefined, @Query('search') search: string | undefined) {
    return this.mappings.candidates(agentId, kind, search);
  }

  @ApiOperation({ summary: 'Set or clear the mapping of one ERP item (optimistic on expectedVersion; audited)' })
  @Put(':kind/:erpKey')
  @ApiBearerAuth('bearerAuth')
  @RequirePermissions(['onec.view', 'onec.write.mappings'])
  put(@Param('kind') kind: string, @Param('erpKey') erpKey: string, @Query('agentId') agentId: string | undefined,
      @Body() body: unknown, @Req() request: RequestWithCurrentUser) {
    return this.mappings.put(user(request), agentId, kind, erpKey, body, context(request));
  }
}
