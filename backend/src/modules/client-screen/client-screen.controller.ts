import { Body, Controller, Get, Inject, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../permissions/current-user';
import { CLIENT_SCREEN_CODES } from './client-screen.registry';
import { ClientScreenService } from './client-screen.service';
import type { ClientScreenSettingsDto } from './client-screen.types';

export const clientScreenSettingsSchema = z.object({
  enabled: z.boolean(),
  visibleCodes: z.array(z.enum(CLIENT_SCREEN_CODES)).max(CLIENT_SCREEN_CODES.length),
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict().refine((value) => new Set(value.visibleCodes).size === value.visibleCodes.length, {
  message: 'повторяющийся код', path: ['visibleCodes'],
});

/** Organisation-wide settings of the customer screen: the master switch and what the customer may see. */
@ApiTags('Client screen')
@ApiBearerAuth('bearerAuth')
@Controller('client-screen')
export class ClientScreenController {
  constructor(@Inject(ClientScreenService) private readonly service: ClientScreenService) {}

  @ApiResponse({ status: 200, description: 'enabled, visibleCodes, version, updatedAt' })
  @ApiResponse({ status: 403, description: 'orders.view or settings.manage required' })
  @ApiOperation({ operationId: 'getClientScreenSettings', summary: 'Customer screen settings' })
  @Get('settings')
  async settings(@Req() request: RequestWithCurrentUser): Promise<ClientScreenSettingsDto> {
    return this.service.getSettings(actor(request).user);
  }

  @ApiResponse({ status: 200, description: 'Settings after the update (no-op when unchanged)' })
  @ApiResponse({ status: 403, description: 'settings.manage required' })
  @ApiResponse({ status: 409, description: 'Stale version' })
  @ApiResponse({ status: 422, description: 'Unknown or repeated code, invalid body' })
  @ApiOperation({ operationId: 'updateClientScreenSettings', summary: 'Update customer screen settings' })
  @Put('settings')
  async updateSettings(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<ClientScreenSettingsDto & { changed: boolean }> {
    const { user, requestId } = actor(request);
    const parsed = clientScreenSettingsSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ApiError(422, 'CLIENT_SCREEN_SETTINGS_INVALID', 'Некорректные настройки экрана клиента', {
        issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
      });
    }
    const result = await this.service.updateSettings({ currentUser: user, requestId, ...parsed.data });
    return { ...result.settings, changed: result.changed };
  }
}

function actor(request: RequestWithCurrentUser): { user: CurrentUser; requestId: string } {
  if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  if (!request.requestId) throw new ApiError(500, 'INTERNAL_ERROR', 'Missing request id');
  return { user: request.user, requestId: request.requestId };
}
