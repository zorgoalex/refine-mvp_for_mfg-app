import { Body, Controller, HttpCode, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiError } from '../../../common/errors/api-error';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { sniffImageMime } from '../application/scan/image-mime-sniffer';
import { LabelsService } from '../application/labels.service';
import type { LabelsContext, ScanResolveImageResult, ScanResolveResult } from '../application/labels.types';
import { scanResolveSchema } from '../dto/label-scan.dto';
import { assertLabelsEnabled, requireUser } from './label-fields.controller';
import { parse } from './label-templates.controller';
import { LabelsRuntimeConfigService } from './labels-runtime-config.service';

const MAX_SCAN_IMAGE_BYTES = 10 * 1024 * 1024;

/** Duck-typed multer file shape (mirrors vlm.controller.ts's own uploaded-file handling — no
 *  @types/multer dependency in this codebase). */
interface UploadedImageFile {
  buffer?: Buffer;
  size?: number;
}

@ApiTags('Labels')
@ApiBearerAuth()
@Controller('labels')
export class LabelScanController {
  constructor(
    private readonly service: LabelsService,
    private readonly runtimeConfig: LabelsRuntimeConfigService,
  ) {}

  @ApiOperation({ operationId: 'scanResolveLabel', summary: 'Resolve scanned label payload to order details' })
  @Post('scan-resolve')
  @HttpCode(200)
  async scanResolve(@Req() request: RequestWithCurrentUser, @Body() body: unknown): Promise<ScanResolveResult> {
    assertLabelsEnabled(this.runtimeConfig);
    const input = parse(scanResolveSchema, body);
    return this.service.scanResolve({
      ...this.context(request),
      payload: input.payload,
      source: input.source,
    });
  }

  @ApiOperation({
    operationId: 'scanResolveLabelImage',
    summary: 'Resolve a photographed label (no QR) to order details via OCR',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'Photo of a printed label.' } },
    },
  })
  @ApiResponse({ status: 415, description: 'Uploaded file is not a recognizable image' })
  @Post('scan-resolve-image')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SCAN_IMAGE_BYTES } }))
  async scanResolveImage(
    @Req() request: RequestWithCurrentUser,
    @UploadedFile() uploadedFile: unknown,
  ): Promise<ScanResolveImageResult> {
    assertLabelsEnabled(this.runtimeConfig);
    const file = uploadedFile as UploadedImageFile | undefined;
    if (!file?.buffer || file.buffer.length === 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Label image file is required', {
        errors: [{ field: 'file', message: 'file is required' }],
      });
    }
    // Never trust the client-supplied mimetype/Content-Type — sniff the actual bytes
    // (Codex R2/R3: a spoofed image/* header must not reach the OCR service).
    const contentType = sniffImageMime(file.buffer);
    if (!contentType) {
      throw new ApiError(415, 'UNSUPPORTED_IMAGE_TYPE', 'Unsupported image type', {});
    }
    return this.service.scanResolveImage({
      ...this.context(request),
      image: file.buffer,
      contentType,
    });
  }

  private context(request: RequestWithCurrentUser): LabelsContext {
    return { currentUser: requireUser(request), requestId: request.requestId ?? '' };
  }
}
