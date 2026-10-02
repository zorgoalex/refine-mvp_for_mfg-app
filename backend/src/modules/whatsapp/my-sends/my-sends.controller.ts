import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { MySendsRepository } from './my-sends.repository';

@ApiTags('WhatsApp')
@ApiBearerAuth('bearerAuth')
@Controller('whatsapp')
export class MySendsController {
  constructor(@Inject(MySendsRepository) private readonly repository: MySendsRepository) {}

  /** Only the caller's own sends of the last day: no permission beyond being signed in, no recipient ids. */
  @ApiOperation({ summary: 'WhatsApp sends started by the current user (order card and calendar) with the estimated send time' })
  @Get('my-sends')
  async mySends(@Req() request: RequestWithCurrentUser, @Res({ passthrough: true }) response: Response, @Query('ids') idsParam: unknown) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    response.setHeader('Cache-Control', 'private, no-store');
    const now = new Date();
    return { serverTime: now.toISOString(), items: await this.repository.list(request.user.id, now, parseIds(idsParam)) };
  }
}

/** `ids=uuid,uuid` — followed sends (at most 50); anything else is a 422. */
export function parseIds(value: unknown): string[] {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string') throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный список ids');
  const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length > 50 || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Некорректный список ids');
  }
  return ids;
}
