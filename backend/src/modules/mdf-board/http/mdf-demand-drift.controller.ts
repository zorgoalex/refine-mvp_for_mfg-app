import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { MdfDemandDriftService } from '../application/mdf-demand-drift.service';

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders/status-board/mdf-drift')
export class MdfDemandDriftController {
  constructor(@Inject(MdfDemandDriftService) private readonly drift: MdfDemandDriftService) {}

  @Get()
  @ApiOperation({ operationId: 'listMdfDemandDriftConflicts', summary: 'Open MDF demand-drift conflicts visible to the user' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  list(@Req() request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return this.drift.list(request.user);
  }

  @Post(':conflictId/confirm')
  @ApiOperation({ operationId: 'confirmMdfDemandDrift',
    summary: 'Resolve a demand-drift conflict through the confirmed order cascade (409 preview without digest)' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions or owner scope' })
  @ApiResponse({ status: 409, description: 'Confirmation preview (mdfConfirmation.digest) or stale state' })
  confirm(@Req() request: RequestWithCurrentUser, @Param('conflictId') conflictId: string, @Body() body: unknown) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    const raw = (body ?? {}) as Record<string, unknown>;
    if (Object.keys(raw).some(k => k !== 'digest') || (raw.digest !== undefined && typeof raw.digest !== 'string')) {
      throw new ApiError(400, 'MDF_DRIFT_INVALID', 'Некорректный запрос');
    }
    return this.drift.confirm(request.user, conflictId, (raw.digest as string | undefined) ?? null,
      request.requestId ?? 'mdf-demand-drift-confirm');
  }
}
