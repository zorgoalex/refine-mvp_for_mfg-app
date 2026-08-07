import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CncTelegramMediaService } from '../application/cnc-telegram-media.service';
import type {
  CncTelegramMediaRestoreClaimResponseDto,
  CncTelegramMediaRestoreResponseDto,
  CncTelegramOrderScreenshotsResponseDto,
} from '../dto/cnc-telegram-media.dto';
import {
  parseCncTelegramMediaRestoreComplete,
  parseCncTelegramMediaRestoreFailure,
  parseCncTelegramMediaRestoreRequestId,
  parseCncTelegramPacketId,
} from '../dto/cnc-telegram-media.dto';
import { CncTelegramRuntimeConfigService } from './cnc-telegram-runtime-config.service';

@ApiTags('CncTelegramMedia')
@ApiBearerAuth()
@Controller('cnc-telegram')
export class CncTelegramMediaController {
  constructor(
    @Inject(CncTelegramMediaService)
    private readonly media: CncTelegramMediaService,
    @Inject(CncTelegramRuntimeConfigService)
    private readonly runtimeConfig: CncTelegramRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'listOrderTelegramScreenshots', summary: 'List Telegram cutting screenshots linked to an order' })
  @ApiResponse({ status: 200, description: 'Order Telegram screenshots' })
  @Get('orders/:orderId/screenshots')
  list(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
  ): Promise<CncTelegramOrderScreenshotsResponseDto> {
    this.assertEnabled();
    return this.media.listOrderScreenshots(this.requireCurrentUser(request), parsePositiveId(orderId, 'orderId'));
  }

  @ApiOperation({ operationId: 'getOrderTelegramScreenshotPreview', summary: 'Get permanent compact Telegram screenshot preview' })
  @ApiResponse({ status: 200, description: 'Compact JPEG preview' })
  @Get('orders/:orderId/screenshots/:packetId/preview')
  async preview(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Param('packetId') packetId: string,
    @Res() response: Response,
  ): Promise<void> {
    this.assertEnabled();
    const opened = await this.media.openPreview(
      this.requireCurrentUser(request),
      parsePositiveId(orderId, 'orderId'),
      parseCncTelegramPacketId(packetId),
    );
    try {
      sendImage(response, opened.raw, opened.contentType, `telegram-cut-preview-${packetId}.jpg`, 86_400);
    } finally {
      await opened.handle.close();
    }
  }

  @ApiOperation({ operationId: 'getOrderTelegramScreenshotImage', summary: 'Get original Telegram screenshot inside its 30-day availability window' })
  @ApiResponse({ status: 200, description: 'Original Telegram screenshot' })
  @ApiResponse({ status: 410, description: 'Original expired; restoration is available' })
  @Get('orders/:orderId/screenshots/:packetId/image')
  async image(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Param('packetId') packetId: string,
    @Res() response: Response,
  ): Promise<void> {
    this.assertEnabled();
    const opened = await this.media.openOriginal(
      this.requireCurrentUser(request),
      parsePositiveId(orderId, 'orderId'),
      parseCncTelegramPacketId(packetId),
    );
    try {
      sendImage(response, opened.raw, opened.contentType, `telegram-cut-${packetId}${extensionFor(opened.contentType)}`, 300);
    } finally {
      await opened.handle.close();
    }
  }

  @ApiOperation({ operationId: 'restoreOrderTelegramScreenshot', summary: 'Request worker restoration of an expired Telegram screenshot' })
  @ApiResponse({ status: 202, description: 'Restore request accepted or already active' })
  @Post('orders/:orderId/screenshots/:packetId/restore')
  @HttpCode(202)
  restore(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Param('packetId') packetId: string,
  ): Promise<CncTelegramMediaRestoreResponseDto> {
    this.assertEnabled();
    return this.media.requestRestore({
      currentUser: this.requireCurrentUser(request),
      orderId: parsePositiveId(orderId, 'orderId'),
      packetId: parseCncTelegramPacketId(packetId),
      requestId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'claimTelegramScreenshotRestores', summary: 'Claim queued screenshot restores for the configured Telegram worker' })
  @Post('media-restores/claim')
  @HttpCode(200)
  claim(@Req() request: RequestWithCurrentUser): Promise<CncTelegramMediaRestoreClaimResponseDto> {
    this.assertEnabled();
    return this.media.claimRestores(this.requireCurrentUser(request));
  }

  @ApiOperation({ operationId: 'completeTelegramScreenshotRestore', summary: 'Complete one worker screenshot restore' })
  @Post('media-restores/:requestId/complete')
  @HttpCode(200)
  complete(
    @Req() request: RequestWithCurrentUser,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<CncTelegramMediaRestoreResponseDto> {
    this.assertEnabled();
    return this.media.completeRestore({
      currentUser: this.requireCurrentUser(request),
      requestId: parseCncTelegramMediaRestoreRequestId(requestId),
      media: parseCncTelegramMediaRestoreComplete(body),
      requestTraceId: request.requestId,
    });
  }

  @ApiOperation({ operationId: 'failTelegramScreenshotRestore', summary: 'Fail one worker screenshot restore' })
  @Post('media-restores/:requestId/fail')
  @HttpCode(200)
  fail(
    @Req() request: RequestWithCurrentUser,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<CncTelegramMediaRestoreResponseDto> {
    this.assertEnabled();
    return this.media.failRestore({
      currentUser: this.requireCurrentUser(request),
      requestId: parseCncTelegramMediaRestoreRequestId(requestId),
      error: parseCncTelegramMediaRestoreFailure(body),
      requestTraceId: request.requestId,
    });
  }

  private assertEnabled(): void {
    if (!this.runtimeConfig.getFeatureFlags().cncTelegramEnabled) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'CNC Telegram API is disabled', {
        feature: 'cnc_telegram',
      });
    }
  }

  private requireCurrentUser(request: RequestWithCurrentUser) {
    if (!request.user) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
    return request.user;
  }
}

function parsePositiveId(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', `Invalid ${field}`, { field });
  }
  return parsed;
}

function sendImage(
  response: Response,
  body: Buffer,
  contentType: string,
  fileName: string,
  maxAgeSeconds: number,
): void {
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(body.length));
  response.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  response.setHeader('Cache-Control', `private, max-age=${maxAgeSeconds}`);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
}

function extensionFor(contentType: string): string {
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/webp') return '.webp';
  return '.jpg';
}
