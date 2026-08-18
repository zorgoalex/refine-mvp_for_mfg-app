import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { CncTelegramMediaService } from '../application/cnc-telegram-media.service';
import type { CncTelegramWorkerSessionLeaseContext } from '../application/cnc-telegram-worker-session.types';
import type {
  CncTelegramManualSvgTelegramSendClaimResponseDto,
  CncTelegramManualSvgTelegramSendResponseDto,
  CncTelegramMediaRestoreClaimResponseDto,
  CncTelegramMediaRestoreResponseDto,
  CncTelegramOrderScreenshotsResponseDto,
} from '../dto/cnc-telegram-media.dto';
import { parseWorkerSessionLeaseHeaders } from '../dto/cnc-telegram-worker-session.dto';
import {
  parseCncTelegramManualSvgFileId,
  parseCncTelegramManualSvgTelegramSendComplete,
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

  @ApiOperation({ operationId: 'downloadOrderManualSvgFile', summary: 'Download a manual SVG upload file linked to an order' })
  @ApiResponse({ status: 200, description: 'Manual SVG upload file' })
  @ApiResponse({ status: 410, description: 'Stored file expired in ERP' })
  @Get('orders/:orderId/manual-svg-files/:fileId')
  async manualSvgFile(
    @Req() request: RequestWithCurrentUser,
    @Param('orderId') orderId: string,
    @Param('fileId') fileId: string,
    @Res() response: Response,
  ): Promise<void> {
    this.assertEnabled();
    const file = await this.media.openManualSvgFile(
      this.requireCurrentUser(request),
      parsePositiveId(orderId, 'orderId'),
      parseCncTelegramManualSvgFileId(fileId),
    );
    sendAttachment(response, file.raw, file.contentType, file.fileName, 300);
  }

  @ApiOperation({ operationId: 'claimTelegramScreenshotRestores', summary: 'Claim queued screenshot restores for the configured Telegram worker' })
  @Post('media-restores/claim')
  @HttpCode(200)
  claim(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
  ): Promise<CncTelegramMediaRestoreClaimResponseDto> {
    this.assertEnabled();
    return this.media.claimRestores(this.requireCurrentUser(request), this.workerLease(token, generation, sourceChatId, workerInstanceId));
  }

  @ApiOperation({ operationId: 'completeTelegramScreenshotRestore', summary: 'Complete one worker screenshot restore' })
  @Post('media-restores/:requestId/complete')
  @HttpCode(200)
  complete(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<CncTelegramMediaRestoreResponseDto> {
    this.assertEnabled();
    return this.media.completeRestore({
      currentUser: this.requireCurrentUser(request),
      requestId: parseCncTelegramMediaRestoreRequestId(requestId),
      media: parseCncTelegramMediaRestoreComplete(body),
      requestTraceId: request.requestId,
      lease: this.workerLease(token, generation, sourceChatId, workerInstanceId),
    });
  }

  @ApiOperation({ operationId: 'failTelegramScreenshotRestore', summary: 'Fail one worker screenshot restore' })
  @Post('media-restores/:requestId/fail')
  @HttpCode(200)
  fail(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<CncTelegramMediaRestoreResponseDto> {
    this.assertEnabled();
    const failure = parseCncTelegramMediaRestoreFailure(body);
    return this.media.failRestore({
      currentUser: this.requireCurrentUser(request),
      requestId: parseCncTelegramMediaRestoreRequestId(requestId),
      error: failure.error,
      itemLeaseToken: failure.itemLeaseToken,
      itemLeaseGeneration: failure.itemLeaseGeneration,
      itemLeaseOwner: failure.itemLeaseOwner,
      requestTraceId: request.requestId,
      lease: this.workerLease(token, generation, sourceChatId, workerInstanceId),
    });
  }

  @ApiOperation({ operationId: 'claimManualSvgTelegramSends', summary: 'Claim queued manual SVG files for Telegram sending' })
  @Post('manual-svg-telegram-sends/claim')
  @HttpCode(200)
  claimManualSvgTelegramSends(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
  ): Promise<CncTelegramManualSvgTelegramSendClaimResponseDto> {
    this.assertEnabled();
    return this.media.claimManualSvgTelegramSends(this.requireCurrentUser(request), request.requestId, this.workerLease(token, generation, sourceChatId, workerInstanceId));
  }

  @ApiOperation({ operationId: 'completeManualSvgTelegramSend', summary: 'Complete one manual SVG Telegram send request' })
  @Post('manual-svg-telegram-sends/:requestId/complete')
  @HttpCode(200)
  completeManualSvgTelegramSend(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<CncTelegramManualSvgTelegramSendResponseDto> {
    this.assertEnabled();
    return this.media.completeManualSvgTelegramSend({
      currentUser: this.requireCurrentUser(request),
      requestId: parseCncTelegramMediaRestoreRequestId(requestId),
      completion: parseCncTelegramManualSvgTelegramSendComplete(body),
      requestTraceId: request.requestId,
      lease: this.workerLease(token, generation, sourceChatId, workerInstanceId),
    });
  }

  @ApiOperation({ operationId: 'failManualSvgTelegramSend', summary: 'Fail one manual SVG Telegram send request' })
  @Post('manual-svg-telegram-sends/:requestId/fail')
  @HttpCode(200)
  failManualSvgTelegramSend(
    @Req() request: RequestWithCurrentUser,
    @Headers('x-cnc-telegram-session-token') token: string | string[] | undefined,
    @Headers('x-cnc-telegram-session-generation') generation: string | string[] | undefined,
    @Headers('x-cnc-telegram-chat-id') sourceChatId: string | string[] | undefined,
    @Headers('x-cnc-telegram-worker-instance') workerInstanceId: string | string[] | undefined,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<CncTelegramManualSvgTelegramSendResponseDto> {
    this.assertEnabled();
    const failure = parseCncTelegramMediaRestoreFailure(body);
    return this.media.failManualSvgTelegramSend({
      currentUser: this.requireCurrentUser(request),
      requestId: parseCncTelegramMediaRestoreRequestId(requestId),
      error: failure.error,
      itemLeaseToken: failure.itemLeaseToken,
      itemLeaseGeneration: failure.itemLeaseGeneration,
      itemLeaseOwner: failure.itemLeaseOwner,
      requestTraceId: request.requestId,
      lease: this.workerLease(token, generation, sourceChatId, workerInstanceId),
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

  private workerLease(
    token: string | string[] | undefined,
    generation: string | string[] | undefined,
    sourceChatId: string | string[] | undefined,
    workerInstanceId: string | string[] | undefined,
  ): CncTelegramWorkerSessionLeaseContext {
    return parseWorkerSessionLeaseHeaders(token, generation, sourceChatId, workerInstanceId);
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

function sendAttachment(
  response: Response,
  body: Buffer,
  contentType: string,
  fileName: string,
  maxAgeSeconds: number,
): void {
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(body.length));
  response.setHeader('Content-Disposition', contentDispositionAttachment(fileName));
  response.setHeader('Cache-Control', `private, max-age=${maxAgeSeconds}`);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
}

function contentDispositionAttachment(fileName: string): string {
  const fallback = fileName.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7e]/g, '_') || 'manual-svg-file';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function extensionFor(contentType: string): string {
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/webp') return '.webp';
  return '.jpg';
}
