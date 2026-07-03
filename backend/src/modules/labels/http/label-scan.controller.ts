import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { LabelsService } from '../application/labels.service';
import type { LabelsContext, ScanResolveResult } from '../application/labels.types';
import { scanResolveSchema } from '../dto/label-scan.dto';
import { assertLabelsEnabled, requireUser } from './label-fields.controller';
import { parse } from './label-templates.controller';
import { LabelsRuntimeConfigService } from './labels-runtime-config.service';

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

  private context(request: RequestWithCurrentUser): LabelsContext {
    return { currentUser: requireUser(request), requestId: request.requestId ?? '' };
  }
}
