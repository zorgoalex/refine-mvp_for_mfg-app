import { Controller, Get, Inject, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { RequirePermissions } from '../../../permissions/require-permissions.decorator';
import { WhatsAppPermissionsGuard } from '../whatsapp-permissions.guard';
import { parseWhatsAppNotificationJournalQuery } from './whatsapp-notification-journal.dto';
import { WhatsAppNotificationJournalService } from './whatsapp-notification-journal.service';

/** «Конфигурация» → «Уведомления» → «Канал WhatsApp» (whatsapp.manage; journal rows also need their source's permission). */
@ApiTags('WhatsApp')
@Controller('whatsapp/notifications')
@UseGuards(WhatsAppPermissionsGuard)
export class WhatsAppNotificationJournalController {
  constructor(@Inject(WhatsAppNotificationJournalService) private readonly journal: WhatsAppNotificationJournalService) {}

  @ApiOperation({ summary: 'State of the WhatsApp notification channel' })
  @Get('channel') @ApiBearerAuth('bearerAuth') @RequirePermissions('whatsapp.manage')
  channel(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.journal.channel();
  }

  @ApiOperation({ summary: 'Journal of WhatsApp notification deliveries' })
  @Get('deliveries') @ApiBearerAuth('bearerAuth') @RequirePermissions('whatsapp.manage')
  deliveries(@Query() query: Record<string, unknown>, @Req() request: RequestWithCurrentUser, @Res({ passthrough: true }) response: Response) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    response.setHeader('Cache-Control', 'private, no-store');
    // Rows of a source are shown only with its read permission (the 1C alerts — onec.view), checked on every read.
    return this.journal.list(parseWhatsAppNotificationJournalQuery(query), { permissions: request.user.permissions });
  }
}
